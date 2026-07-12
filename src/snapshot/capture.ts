import type { Clock, FileSystem, Lock, TmuxRunner } from "./deps";
import { SnapshotModel } from "./model";
import { detectPaneKind } from "./painter";
import { INTERNAL_SESSION_FILTER } from "../glass/internal-sessions";
import {
  emptyHealth,
  recordSuccess,
  recordFailure,
  deriveHealth,
  type HealthSnapshot,
  type SnapshotHealth,
} from "./health";
import type {
  SnapshotAgentState,
  SnapshotOtel,
  SnapshotPane,
  SnapshotWindow,
} from "./schema";

export interface SnapshotterOptions {
  dir: string;
  model: SnapshotModel;
  fs: FileSystem;
  runner: TmuxRunner;
  clock: Clock;
  debounceMs: number;
  scrollbackIntervalMs: number;
  scrollbackMaxBytes?: number;
  lock?: Lock;
  /** Age (ms) past which a healthy-but-not-recently-committed snapshot is
      reported `stale`. Default 60_000. */
  staleMs?: number;
  /** Fired whenever the derived health verdict changes. */
  onHealthChange?: (h: SnapshotHealth) => void;
  /** When set, the current health is persisted here (JSON) on transitions,
      watchdog ticks, and stop — so the next launch can report the prior run's
      final health. */
  healthPersistPath?: string;
  /** Watchdog interval (ms): a full capture is attempted this often regardless
      of change activity. Default 15_000. */
  captureIntervalMs?: number;
}

export class Snapshotter {
  private dirty = false;
  private debounceCancel: (() => void) | null = null;
  private scrollbackCancel: (() => void) | null = null;
  private lock: Lock | null = null;
  private stopped = false;
  private degraded = false;
  private degradedReason_: string | null = null;
  private scrollbackBusy = false;
  private health: HealthSnapshot = emptyHealth(0);
  private lastDerived: SnapshotHealth | null = null;
  private watchdogCancel: (() => void) | null = null;

  constructor(private readonly opts: SnapshotterOptions) {}

  isDegraded(): boolean {
    return this.degraded;
  }

  degradedReason(): string | null {
    return this.degradedReason_;
  }

  healthSnapshot(): HealthSnapshot {
    return this.health;
  }

  getHealth(nowMs: number = this.opts.clock.now()): SnapshotHealth {
    if (this.stopped) return "stopped";
    if (this.degraded) {
      return this.degradedReason_ === "lock_held" ? "locked_live" : "error";
    }
    return deriveHealth(this.health, nowMs, this.opts.staleMs ?? 60_000);
  }

  private emitHealthIfChanged(): void {
    const h = this.getHealth();
    if (h !== this.lastDerived) {
      this.lastDerived = h;
      this.opts.onHealthChange?.(h);
    }
  }

  async start(): Promise<void> {
    this.health = emptyHealth(this.opts.clock.now());
    if (this.opts.lock !== undefined) {
      // Caller (Restorer) already holds the lock — take ownership without re-acquiring.
      this.lock = this.opts.lock;
    } else {
      const lockRes = await this.opts.fs.lock(`${this.opts.dir}/.lock`);
      if (!lockRes.ok) {
        this.degraded = true;
        this.degradedReason_ = lockRes.reason === "error" ? "lock_error" : "lock_held";
        return;
      }
      this.lock = lockRes.lock;
    }
    this.scrollbackCancel = this.opts.clock.setInterval(
      () => void this.scrollbackTick(),
      this.opts.scrollbackIntervalMs,
    );
  }

  markDirty(): void {
    if (this.stopped || this.degraded) return;
    this.dirty = true;
    if (this.debounceCancel) return;
    this.debounceCancel = this.opts.clock.setTimeout(() => {
      this.debounceCancel = null;
      void this.flushNow();
    }, this.opts.debounceMs);
  }

  async flushNow(): Promise<void> {
    if (this.stopped || this.degraded) return;
    if (!this.dirty) return;
    // Mark not-dirty BEFORE the await so a concurrent markDirty during writeAtomic
    // correctly re-flags dirty=true and triggers a follow-up flush.
    this.dirty = false;
    const capturedAt = new Date(this.opts.clock.now()).toISOString();
    const file = this.opts.model.toFile(capturedAt);
    const json = JSON.stringify(file, null, 2);
    try {
      await this.opts.fs.writeAtomic(
        `${this.opts.dir}/state.json`,
        new TextEncoder().encode(json),
      );
      recordSuccess(this.health.stateCommit, this.opts.clock.now());
    } catch (err) {
      this.dirty = true;
      recordFailure(this.health.stateCommit, this.opts.clock.now(), String(err));
    }
    this.emitHealthIfChanged();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.debounceCancel) {
      this.debounceCancel();
      this.debounceCancel = null;
    }
    if (this.scrollbackCancel) {
      this.scrollbackCancel();
      this.scrollbackCancel = null;
    }
    // Synchronous final flush (bypass debounce) if dirty and not degraded.
    if (this.dirty && !this.degraded) {
      try {
        const capturedAt = new Date(this.opts.clock.now()).toISOString();
        const file = this.opts.model.toFile(capturedAt);
        const json = JSON.stringify(file, null, 2);
        await this.opts.fs.writeAtomic(
          `${this.opts.dir}/state.json`,
          new TextEncoder().encode(json),
        );
      } catch {
        // best-effort during shutdown
      }
    }
    if (this.lock) {
      await this.lock.release();
      this.lock = null;
    }
  }

  async onSessionsChanged(): Promise<void> {
    if (this.stopped) return;
    const sessionsRes = await this.opts.runner.run([
      "list-sessions",
      "-f",
      INTERNAL_SESSION_FILTER,
      "-F",
      "#{session_name}|#{session_path}",
    ]);
    if (sessionsRes.exitCode !== 0) {
      recordFailure(
        this.health.topology,
        this.opts.clock.now(),
        `list-sessions exit ${sessionsRes.exitCode}`,
      );
      this.emitHealthIfChanged();
      return;
    }
    const live = new Set<string>();
    for (const line of sessionsRes.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, cwd] = line.split("|");
      live.add(name);
      const existing = this.opts.model.hasSession(name);
      if (!existing) {
        this.opts.model.upsertSession(
          SnapshotModel.makeEmptySession(name, cwd),
        );
      }
      await this.rederiveSessionWindows(name);
    }
    // Remove sessions no longer present.
    for (const name of this.opts.model.sessionNames()) {
      if (!live.has(name)) this.opts.model.removeSession(name);
    }
    recordSuccess(this.health.topology, this.opts.clock.now());
    this.markDirty();
  }

  async onWindowAdded(sessionName: string): Promise<void> {
    await this.rederiveSessionWindows(sessionName);
    this.markDirty();
  }

  async onWindowClosed(sessionName: string): Promise<void> {
    await this.rederiveSessionWindows(sessionName);
    this.markDirty();
  }

  async onWindowRenamed(sessionName: string): Promise<void> {
    await this.rederiveSessionWindows(sessionName);
    this.markDirty();
  }

  async onLayoutChanged(sessionName: string): Promise<void> {
    await this.rederiveSessionWindows(sessionName);
    this.markDirty();
  }

  async onSessionRenamed(oldName: string, newName: string): Promise<void> {
    this.opts.model.renameSession(oldName, newName);
    this.markDirty();
  }

  onPermissionMode(
    name: string,
    mode: "default" | "plan" | "accept-edits" | null,
  ): void {
    this.opts.model.setPermissionMode(name, mode);
    this.markDirty();
  }

  onPinned(name: string, pinned: boolean): void {
    this.opts.model.setPinned(name, pinned);
    this.markDirty();
  }

  onAgentState(
    name: string,
    agentState: SnapshotAgentState | null,
  ): void {
    this.opts.model.setAgentState(name, agentState);
    this.markDirty();
  }

  onLinks(
    name: string,
    links: { type: "issue" | "mr"; id: string }[],
  ): void {
    this.opts.model.setLinks(name, links);
    this.markDirty();
  }

  onOtel(name: string, otel: SnapshotOtel | null): void {
    this.opts.model.setOtel(name, otel);
    this.markDirty();
  }

  onFocused(name: string | null): void {
    this.opts.model.setLastFocused(name);
    this.markDirty();
  }

  async scrollbackTick(): Promise<void> {
    if (this.stopped || this.degraded || this.scrollbackBusy) return;
    this.scrollbackBusy = true;
    try {
      const sessRes = await this.opts.runner.run([
        "list-sessions",
        "-f",
        INTERNAL_SESSION_FILTER,
        "-F",
        "#{session_name}",
      ]);
      if (sessRes.exitCode !== 0) {
        recordFailure(
          this.health.scrollback,
          this.opts.clock.now(),
          `list-sessions exit ${sessRes.exitCode}`,
        );
        this.emitHealthIfChanged();
        return;
      }
      const liveSessions = sessRes.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      for (const session of liveSessions) {
        const winRes = await this.opts.runner.run([
          "list-windows",
          "-t",
          session,
          "-F",
          "#{window_index}",
        ]);
        if (winRes.exitCode !== 0) continue;
        const windows = winRes.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .map((s) => Number(s));

        for (const w of windows) {
          const paneRes = await this.opts.runner.run([
            "list-panes",
            "-t",
            `${session}:${w}`,
            "-F",
            "#{pane_index}",
          ]);
          if (paneRes.exitCode !== 0) continue;
          const panes = paneRes.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .map((s) => Number(s));

          for (const p of panes) {
            await this.captureOnePane(session, w, p);
          }
        }
      }

      await this.gcScrollback(liveSessions);
      recordSuccess(this.health.scrollback, this.opts.clock.now());
      this.emitHealthIfChanged();
    } finally {
      this.scrollbackBusy = false;
    }
  }

  private async captureOnePane(
    session: string,
    w: number,
    p: number,
  ): Promise<void> {
    const cap = await this.opts.runner.run([
      "capture-pane",
      "-p",
      "-e",
      "-J",
      "-S",
      "-",
      "-t",
      `${session}:${w}.${p}`,
    ]);
    const path = `${this.opts.dir}/scrollback/${session}/${w}-${p}.ansi`;
    if (cap.exitCode !== 0) return;
    if (cap.stdout.length === 0) {
      await this.opts.fs.unlink(path);
      this.opts.model.setScrollbackFile(session, w, p, null);
      this.markDirty();
      return;
    }
    let bytes = new TextEncoder().encode(cap.stdout);
    const cap2 = this.opts.scrollbackMaxBytes ?? 2 * 1024 * 1024;
    if (bytes.byteLength > cap2) {
      // Reserve space for the marker so total <= cap2 AND the marker survives.
      const enc = new TextEncoder();
      let droppedGuess = bytes.byteLength;
      let marker = enc.encode(
        `\n--- truncated: oldest ${droppedGuess} bytes dropped ---\n`,
      );
      let tailBudget = Math.max(0, cap2 - marker.byteLength);
      let droppedActual = bytes.byteLength - tailBudget;
      if (droppedActual !== droppedGuess) {
        marker = enc.encode(
          `\n--- truncated: oldest ${droppedActual} bytes dropped ---\n`,
        );
        tailBudget = Math.max(0, cap2 - marker.byteLength);
        droppedActual = bytes.byteLength - tailBudget;
        marker = enc.encode(
          `\n--- truncated: oldest ${droppedActual} bytes dropped ---\n`,
        );
      }
      let cut = bytes.byteLength - tailBudget;
      // Align tail start to a UTF-8 leading byte
      while (cut < bytes.byteLength && (bytes[cut] & 0xc0) === 0x80) cut++;
      const tail = bytes.subarray(cut);
      const combined = new Uint8Array(marker.byteLength + tail.byteLength);
      combined.set(marker, 0);
      combined.set(tail, marker.byteLength);
      bytes = combined;
    }
    await this.opts.fs.writeAtomic(path, bytes);
    this.opts.model.setScrollbackFile(
      session,
      w,
      p,
      `scrollback/${session}/${w}-${p}.ansi`,
    );
    this.markDirty();
  }

  private async gcScrollback(liveSessions: string[]): Promise<void> {
    const live = new Set(liveSessions);
    const root = `${this.opts.dir}/scrollback`;
    const entries = await this.opts.fs.readDir(root);
    for (const dir of entries) {
      const sessionDir = `${root}/${dir}`;
      if (!live.has(dir)) {
        // Whole session gone — remove all its files + the dir.
        const files = await this.opts.fs.readDir(sessionDir);
        for (const f of files) await this.opts.fs.unlink(`${sessionDir}/${f}`);
        // rmdir already ignores ENOENT/ENOTEMPTY; the outer catch keeps one
        // permission-denied stale dir from aborting the whole scrollback tick.
        await this.opts.fs.rmdir(sessionDir).catch(() => undefined);
        continue;
      }
      // Session is live — prune .ansi files for panes that no longer exist.
      const session = this.opts.model.getSession(dir);
      if (!session) continue;
      const liveFiles = new Set<string>();
      for (const w of session.windows) {
        for (const p of w.panes) {
          liveFiles.add(`${w.index}-${p.index}.ansi`);
        }
      }
      const files = await this.opts.fs.readDir(sessionDir);
      for (const f of files) {
        if (!liveFiles.has(f)) {
          await this.opts.fs.unlink(`${sessionDir}/${f}`).catch(() => undefined);
        }
      }
    }
  }

  private async rederiveSessionWindows(name: string): Promise<void> {
    const winRes = await this.opts.runner.run([
      "list-windows",
      "-t",
      name,
      "-F",
      "#{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
    ]);
    if (winRes.exitCode !== 0) {
      this.opts.model.removeSession(name);
      return;
    }
    const windows: SnapshotWindow[] = [];
    for (const line of winRes.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [idxStr, wname, layout, activeStr] = line.split("|");
      const idx = Number(idxStr);
      const paneRes = await this.opts.runner.run([
        "list-panes",
        "-t",
        `${name}:${idx}`,
        "-F",
        "#{pane_index}|#{pane_current_path}|#{pane_start_command}",
      ]);
      if (paneRes.exitCode !== 0) {
        // Window vanished between list-windows and list-panes — skip it.
        // Leave any prior model state for this session untouched by NOT pushing
        // a windowless window. The next event will trigger a fresh rederive.
        continue;
      }
      const panes: SnapshotPane[] = [];
      for (const pline of paneRes.stdout.split("\n")) {
        if (!pline.trim()) continue;
        const [piStr, cwd, cmd] = pline.split("|");
        panes.push({
          index: Number(piStr),
          cwd,
          command: cmd,
          kind: detectPaneKind(cmd),
          scrollbackFile: null,
        });
      }
      if (panes.length === 0) continue;
      windows.push({
        index: idx,
        name: wname,
        layout,
        active: activeStr === "1",
        panes,
      });
    }
    this.opts.model.updateWindows(name, windows);
  }
}
