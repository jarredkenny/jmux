import type { PinnedPaneRecord, ReconcileAction, ReconcileInput, RestorePlan } from "./types";

/**
 * Pure pin reconciler. Compares desired membership (`@jmux-pinned`) against the
 * physical world (persisted records + live pane locations) and returns the
 * minimal set of break/join/discard decisions. The same function serves
 * steady-state, agent-initiated pins, and startup crash recovery.
 *
 * A pane is "checked out" when its live location is the holding session.
 */
export function reconcilePins(input: ReconcileInput): ReconcileAction[] {
  const { desired, records, live, holdingSessionId } = input;
  const actions: ReconcileAction[] = [];

  const isCheckedOut = (paneId: string): boolean =>
    holdingSessionId !== null && live.get(paneId)?.sessionId === holdingSessionId;

  // 1. Drive desired panes toward being checked out.
  for (const paneId of desired) {
    const here = live.get(paneId);
    if (!here) {
      // Desired but the pane is gone (e.g. its process exited). Drop any record;
      // PinnedPaneTracker.pruneExcept clears it from `desired` separately.
      if (records.has(paneId)) actions.push({ type: "discardRecord", paneId });
      continue;
    }
    if (isCheckedOut(paneId)) continue; // already in glass-land — steady state
    if (holdingSessionId === null) continue; // no holding session yet; cannot break out
    // Live and home (or anywhere non-holding) but desired → break it out.
    actions.push({ type: "checkout", paneId, home: here });
  }

  // 2. Resolve records whose pane is no longer desired.
  for (const [paneId, record] of records) {
    if (desired.has(paneId)) continue; // handled above
    if (isCheckedOut(paneId)) {
      actions.push({ type: "restore", record }); // unpinned → bring home
    } else {
      // Pane is gone, or already back home — nothing to join; just drop the record.
      actions.push({ type: "discardRecord", paneId });
    }
  }

  return actions;
}

/**
 * Decide how to bring a checked-out pane home. Encodes the spec's three
 * branches; never destroys the pane's process.
 */
export function planRestore(
  record: PinnedPaneRecord,
  liveWindowIds: ReadonlySet<string>,
  liveSessionIds: ReadonlySet<string>,
): RestorePlan {
  if (liveWindowIds.has(record.homeWindowId)) {
    return { mode: "rejoinWindow", windowId: record.homeWindowId, layout: record.homeLayout };
  }
  if (liveSessionIds.has(record.homeSessionId)) {
    return { mode: "newWindowInSession", sessionId: record.homeSessionId };
  }
  return { mode: "newSession" };
}
