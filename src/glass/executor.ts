import { planRestore } from "./reconciler";
import { captureLayoutCommand, breakPaneCommand, buildRestoreCommands } from "./commands";
import { sanitizeTmuxSessionName } from "../config";
import type { PinnedPaneRecord, ReconcileAction } from "./types";

export interface GlassRunner {
  run(args: string[]): { ok: boolean; lines: string[] };
}

export interface RecordStore {
  get(): PinnedPaneRecord[];
  put(record: PinnedPaneRecord): void;
  remove(paneId: string): void;
}

export interface GlassExecutorOptions {
  runner: GlassRunner;
  store: RecordStore;
  holdingSession: string;
  holdingSessionId: string;
}

/**
 * Executes the pure reconciler's decisions against tmux, in the crash-safe order
 * from the spec: persist the home record before break-pane; drop it only after a
 * successful restore. Pure orchestration over an injected runner/store, so it is
 * unit-tested with fakes; real tmux is exercised by the smoke test.
 */
export class GlassExecutor {
  constructor(private readonly opts: GlassExecutorOptions) {}

  apply(actions: ReconcileAction[]): void {
    for (const action of actions) {
      if (action.type === "checkout") this.checkout(action.paneId, action.home);
      else if (action.type === "restore") this.restore(action.record);
      else this.opts.store.remove(action.paneId);
    }
  }

  private checkout(paneId: string, home: { sessionId: string; windowId: string }): void {
    const { runner, store, holdingSession } = this.opts;
    const layout = runner.run(captureLayoutCommand(home.windowId)).lines[0] ?? "";
    store.put({
      paneId,
      homeSessionId: home.sessionId,
      homeWindowId: home.windowId,
      homeLayout: layout,
    });
    runner.run(breakPaneCommand(paneId, holdingSession));
  }

  private restore(record: PinnedPaneRecord): void {
    const { runner, store } = this.opts;
    const liveWindows = new Set(runner.run(["list-windows", "-a", "-F", "#{window_id}"]).lines);
    const liveSessions = new Set(runner.run(["list-sessions", "-F", "#{session_id}"]).lines);
    const holdingWindowId = runner.run(["display-message", "-p", "-t", record.paneId, "#{window_id}"]).lines[0] ?? "";
    const newSessionName = sanitizeTmuxSessionName(record.displaySessionName ?? "restored");

    const plan = planRestore(record, liveWindows, liveSessions);
    for (const cmd of buildRestoreCommands(record, plan, { holdingWindowId, newSessionName })) {
      runner.run(cmd);
    }
    store.remove(record.paneId);
  }
}
