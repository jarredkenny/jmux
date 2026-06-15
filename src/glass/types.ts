/** Where a pane physically lives (tmux ids, stable for the server lifetime). */
export interface PaneLocation {
  sessionId: string;
  windowId: string;
}
