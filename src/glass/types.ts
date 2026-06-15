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
