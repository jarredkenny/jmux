import type { Clock, FileSystem, Lock, TmuxRunner } from "./deps";
import { validateSnapshot, type SnapshotFile, type SnapshotSession } from "./schema";
import { RestoreLog, type RestoreOutcome } from "./log";
import { buildPainterArgv } from "./painter";

export interface RestorerOptions {
  dir: string;
  fs: FileSystem;
  runner: TmuxRunner;
  clock: Clock;
  jmuxVersion: string;
  userShell: string;
  claudeCommand: string;
  cwdExists?: (path: string) => Promise<boolean>;
  sessionLinksSink?: (
    name: string,
    links: import("./schema").SessionLink[],
  ) => void;
  permissionModeSink?: (
    name: string,
    mode: import("./schema").SnapshotPermissionMode,
  ) => void;
  otelSink?: (
    name: string,
    otel: import("./schema").SnapshotOtel | null,
  ) => void;
  pinnedSink?: (name: string, pinned: boolean) => void;
  attentionSink?: (name: string, attention: boolean) => void;
}

export type EligibilityResult =
  | { ok: true; snapshot: SnapshotFile }
  | { ok: false; reason: "no_snapshot" | "invalid_snapshot" | "server_busy" | "tmux_error" | "locked" };

const NO_SERVER_RX = /no server running|error connecting to|no sessions/i;

export class Restorer {
  protected readonly log: RestoreLog;
  protected outcomes = new Map<string, RestoreOutcome>();
  protected lastSnapshot: SnapshotFile | null = null;
  private heldLock: Lock | null = null;

  constructor(protected readonly opts: RestorerOptions) {
    this.log = new RestoreLog(opts.fs, `${opts.dir}/restore.log`);
  }

  /**
   * Transfer ownership of the lock to the caller (typically the Snapshotter).
   * After this call, the Restorer no longer owns the lock.
   * Returns null if the lock was never acquired (e.g. reason was "locked").
   */
  takeLock(): Lock | null {
    const l = this.heldLock;
    this.heldLock = null;
    return l;
  }

  /**
   * Release the held lock if still owned by this Restorer.
   * Used when no Snapshotter will be constructed (e.g. snapshot.enabled is false
   * after eligibility returned an ineligible-but-not-locked result).
   */
  async releaseLock(): Promise<void> {
    if (this.heldLock) {
      await this.heldLock.release();
      this.heldLock = null;
    }
  }

  attachTarget(): string | null {
    if (!this.lastSnapshot) return null;
    const lf = this.lastSnapshot.lastFocusedSession;
    if (lf && this.outcomes.get(lf) === "restored") return lf;
    for (const s of this.lastSnapshot.sessions) {
      if (this.outcomes.get(s.name) === "restored") return s.name;
    }
    return null;
  }

  outcomeFor(session: string): RestoreOutcome | undefined {
    return this.outcomes.get(session);
  }

  async checkEligibility(): Promise<EligibilityResult> {
    // Acquire the lock FIRST — before reading state.json — to guarantee that no
    // two jmux processes can both pass eligibility and both run restore().
    // On lock failure (another jmux holds it), skip immediately without acquiring.
    const lock = await this.opts.fs.lock(`${this.opts.dir}/.lock`);
    if (!lock) {
      return { ok: false, reason: "locked" };
    }
    // Hold the lock for the lifetime of this Restorer (and then hand it to
    // the Snapshotter via takeLock()).  All return paths below keep heldLock set
    // so the caller can always call takeLock() to receive it.
    this.heldLock = lock;

    const raw = await this.opts.fs.readFile(`${this.opts.dir}/state.json`);
    if (!raw) return { ok: false, reason: "no_snapshot" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      await this.backupCorrupt(raw);
      return { ok: false, reason: "invalid_snapshot" };
    }

    const v = validateSnapshot(parsed);
    if (!v.ok) {
      await this.backupCorrupt(raw);
      return { ok: false, reason: "invalid_snapshot" };
    }

    const sess = await this.opts.runner.run([
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    if (sess.exitCode === 0) {
      if (sess.stdout.trim().length === 0) return { ok: true, snapshot: v.value };
      return { ok: false, reason: "server_busy" };
    }
    if (NO_SERVER_RX.test(sess.stderr)) {
      return { ok: true, snapshot: v.value };
    }
    return { ok: false, reason: "tmux_error" };
  }

  protected async backupCorrupt(raw: Uint8Array): Promise<void> {
    const ts = new Date(this.opts.clock.now()).toISOString();
    await this.opts.fs.writeAtomic(
      `${this.opts.dir}/state.json.broken-${ts}`,
      raw,
    );
  }

  async run(snapshot: SnapshotFile): Promise<void> {
    this.lastSnapshot = snapshot;
    for (const session of snapshot.sessions) {
      await this.restoreSession(session, snapshot.capturedAt);
    }
  }

  protected async restoreSession(
    session: SnapshotSession,
    capturedAt: string,
  ): Promise<void> {
    const exists = this.opts.cwdExists ?? this.defaultCwdExists.bind(this);
    if (!(await exists(session.cwd))) {
      this.outcomes.set(session.name, "skipped");
      await this.log.append({
        ts: new Date(this.opts.clock.now()).toISOString(),
        session: session.name,
        outcome: "skipped",
        reason: "cwd_missing",
      });
      return;
    }

    let layoutDegraded = false;
    let totalPanes = 0;
    let sessionCreated = false;

    for (let wi = 0; wi < session.windows.length; wi++) {
      const w = session.windows[wi];
      if (w.panes.length === 0) continue;  // degenerate window — skip
      const firstPane = w.panes[0];
      const painter = buildPainterArgv({
        scrollbackPath: firstPane.scrollbackFile
          ? `${this.opts.dir}/${firstPane.scrollbackFile}`
          : "",
        capturedAt,
        kind: firstPane.kind,
        claudeCommand: this.opts.claudeCommand,
        userShell: this.opts.userShell,
      });

      const isFirst = !sessionCreated;
      const baseArgs = isFirst
        ? ["new-session", "-d", "-s", session.name, "-c", firstPane.cwd]
        : ["new-window", "-t", `${session.name}:${w.index}`, "-c", firstPane.cwd];

      const r1 = await this.opts.runner.run([...baseArgs, ...painter]);
      if (r1.exitCode !== 0) {
        await this.failSession(
          session.name,
          isFirst ? "new_session_failed" : "new_window_failed",
          r1.stderr,
        );
        return;
      }
      sessionCreated = true;
      totalPanes++;

      // Remaining panes: split-window
      for (let pi = 1; pi < w.panes.length; pi++) {
        const p = w.panes[pi];
        const painterP = buildPainterArgv({
          scrollbackPath: p.scrollbackFile
            ? `${this.opts.dir}/${p.scrollbackFile}`
            : "",
          capturedAt,
          kind: p.kind,
          claudeCommand: this.opts.claudeCommand,
          userShell: this.opts.userShell,
        });
        const r2 = await this.opts.runner.run([
          "split-window",
          "-t",
          `${session.name}:${w.index}`,
          "-c",
          p.cwd,
          ...painterP,
        ]);
        if (r2.exitCode !== 0) {
          await this.failSession(session.name, "split_window_failed", r2.stderr);
          return;
        }
        totalPanes++;
      }

      // Apply layout — failure is cosmetic, keep going
      const rL = await this.opts.runner.run([
        "select-layout",
        "-t",
        `${session.name}:${w.index}`,
        w.layout,
      ]);
      if (rL.exitCode !== 0) layoutDegraded = true;

      // Window name — failure is session-fatal
      const rR = await this.opts.runner.run([
        "rename-window",
        "-t",
        `${session.name}:${w.index}`,
        w.name,
      ]);
      if (rR.exitCode !== 0) {
        await this.failSession(session.name, "rename_window_failed", rR.stderr);
        return;
      }
    }

    // If every window was zero-pane the session was never created — log and bail.
    if (!sessionCreated) {
      this.outcomes.set(session.name, "skipped");
      await this.log.append({
        ts: new Date(this.opts.clock.now()).toISOString(),
        session: session.name,
        outcome: "skipped",
        reason: "no_restorable_windows",
      });
      return;
    }

    // Active window
    const activeWindow = session.windows.find((w) => w.active);
    if (activeWindow) {
      await this.opts.runner.run([
        "select-window",
        "-t",
        `${session.name}:${activeWindow.index}`,
      ]);
    }

    this.opts.sessionLinksSink?.(session.name, session.links);
    this.opts.permissionModeSink?.(session.name, session.permissionMode);
    this.opts.otelSink?.(session.name, session.otel);
    this.opts.pinnedSink?.(session.name, session.pinned);
    this.opts.attentionSink?.(session.name, session.attention);

    this.outcomes.set(session.name, "restored");
    await this.log.append({
      ts: new Date(this.opts.clock.now()).toISOString(),
      session: session.name,
      outcome: "restored",
      windowCount: session.windows.length,
      paneCount: totalPanes,
      reason: layoutDegraded ? "layout_degraded" : undefined,
    });
  }

  protected async failSession(
    name: string,
    reason: string,
    stderr: string,
  ): Promise<void> {
    await this.opts.runner.run(["kill-session", "-t", name]);
    this.outcomes.set(name, "failed");
    await this.log.append({
      ts: new Date(this.opts.clock.now()).toISOString(),
      session: name,
      outcome: "failed",
      reason,
      stderr,
    });
  }

  protected async defaultCwdExists(p: string): Promise<boolean> {
    return (await this.opts.fs.stat(p)) !== null;
  }
}
