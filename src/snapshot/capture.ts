import type { Clock, FileSystem, Lock, TmuxRunner } from "./deps";
import { SnapshotModel } from "./model";
import { detectPaneKind } from "./painter";
import type {
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
}

export class Snapshotter {
  private dirty = false;
  private debounceCancel: (() => void) | null = null;
  private scrollbackCancel: (() => void) | null = null;
  private lock: Lock | null = null;
  private stopped = false;
  private degraded = false;

  constructor(private readonly opts: SnapshotterOptions) {}

  isDegraded(): boolean {
    return this.degraded;
  }

  async start(): Promise<void> {
    // Lock acquisition is added in Task 9.
    // Scrollback loop is added in Task 8.
  }

  markDirty(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.debounceCancel) return;
    this.debounceCancel = this.opts.clock.setTimeout(() => {
      this.debounceCancel = null;
      void this.flushNow();
    }, this.opts.debounceMs);
  }

  async flushNow(): Promise<void> {
    if (this.stopped) return;
    if (!this.dirty) return;
    const capturedAt = new Date(this.opts.clock.now()).toISOString();
    const file = this.opts.model.toFile(capturedAt);
    const json = JSON.stringify(file, null, 2);
    try {
      await this.opts.fs.writeAtomic(
        `${this.opts.dir}/state.json`,
        new TextEncoder().encode(json),
      );
      // Only clear dirty after a successful write so a failed flush
      // (ENOSPC, EIO, etc.) is retried on the next debounce or tick.
      this.dirty = false;
    } catch {
      // Stay dirty. Next markDirty will reschedule the debounce.
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceCancel) {
      this.debounceCancel();
      this.debounceCancel = null;
    }
    if (this.scrollbackCancel) {
      this.scrollbackCancel();
      this.scrollbackCancel = null;
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
      "-F",
      "#{session_name}|#{session_path}",
    ]);
    if (sessionsRes.exitCode !== 0) {
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
    const file = this.opts.model.toFile(
      new Date(this.opts.clock.now()).toISOString(),
    );
    for (const s of file.sessions) {
      if (!live.has(s.name)) this.opts.model.removeSession(s.name);
    }
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

  async onLayoutChanged(
    sessionName: string,
    _windowIndex: number,
  ): Promise<void> {
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

  onAttention(name: string, attention: boolean): void {
    this.opts.model.setAttention(name, attention);
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
