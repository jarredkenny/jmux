/** Where a pane physically lives (tmux ids, stable for the server lifetime). */
export interface PaneLocation {
  sessionId: string;
  windowId: string;
}

/**
 * Durable home-restore record for a checked-out (pinned) pane. Persisted to
 * config.json so a pane can always be returned home, even across a jmux
 * restart while the tmux server is alive. IDs are authoritative; names are
 * UI-only and may go stale.
 */
export interface PinnedPaneRecord {
  paneId: string;
  homeSessionId: string;
  homeWindowId: string;
  homeLayout: string;
  displaySessionName?: string;
  displayWindowName?: string;
}

/** Inputs to the pure pin reconciler — all observed, no tmux calls. */
export interface ReconcileInput {
  /** Pane ids whose `@jmux-pinned` option is currently set. */
  desired: ReadonlySet<string>;
  /** Persisted home records, keyed by paneId. */
  records: ReadonlyMap<string, PinnedPaneRecord>;
  /** Current location of every live pane, keyed by paneId. */
  live: ReadonlyMap<string, PaneLocation>;
  /** session_id of the glass holding session, or null if it doesn't exist yet. */
  holdingSessionId: string | null;
}

/** How to bring a checked-out pane home, given what still exists in tmux. */
export type RestorePlan =
  /** Home window still exists: join back and re-apply the saved layout. */
  | { mode: "rejoinWindow"; windowId: string; layout: string }
  /** Home window gone but session alive: join as a new window in that session. */
  | { mode: "newWindowInSession"; sessionId: string }
  /** Home session gone: promote the holding window into its own new session. */
  | { mode: "newSession" };

/** A decision the reconciler emits; the executor performs the tmux side effect. */
export type ReconcileAction =
  /** Break a live, home, desired pane out into the holding session. */
  | { type: "checkout"; paneId: string; home: PaneLocation }
  /** Join a checked-out, no-longer-desired pane back home. */
  | { type: "restore"; record: PinnedPaneRecord }
  /** Drop a stale record (pane died, or is already home). */
  | { type: "discardRecord"; paneId: string };
