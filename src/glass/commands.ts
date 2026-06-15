import type { PinnedPaneRecord, RestorePlan } from "./types";

/** Read a window's layout string so it can be restored exactly on unpin. */
export function captureLayoutCommand(homeWindowId: string): string[] {
  return ["display-message", "-p", "-t", homeWindowId, "#{window_layout}"];
}

/** Break a pane out into a new window of the holding session, printing the new window id. */
export function breakPaneCommand(paneId: string, holdingSession: string): string[] {
  return ["break-pane", "-d", "-P", "-F", "#{window_id}", "-s", paneId, "-t", `${holdingSession}:`];
}

export interface RestoreContext {
  /** The pane's current (holding) window id — needed for the newSession move. */
  holdingWindowId: string;
  /** Sanitized, user-visible name for the newSession branch. */
  newSessionName: string;
}

/**
 * Commands to bring a checked-out pane home, per the chosen RestorePlan.
 * Never kills the pane's process.
 */
export function buildRestoreCommands(
  record: PinnedPaneRecord,
  plan: RestorePlan,
  ctx: RestoreContext,
): string[][] {
  switch (plan.mode) {
    case "rejoinWindow":
      return [
        ["join-pane", "-s", record.paneId, "-t", plan.windowId],
        ["select-layout", "-t", plan.windowId, plan.layout],
      ];
    case "newWindowInSession":
      return [["break-pane", "-d", "-s", record.paneId, "-t", `${plan.sessionId}:`]];
    case "newSession":
      return [
        ["new-session", "-d", "-s", ctx.newSessionName, "-n", "__placeholder"],
        ["move-window", "-s", ctx.holdingWindowId, "-t", `${ctx.newSessionName}:`],
        ["kill-window", "-t", `${ctx.newSessionName}:__placeholder`],
      ];
  }
}
