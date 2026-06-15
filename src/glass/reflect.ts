import type { PaneLocation } from "./types";

const US = "\x1f";

/** Format for `list-panes -a -F` to read pin flag + location for every pane. */
export const PANE_STATE_FORMAT =
  `#{pane_id}${US}#{@jmux-pinned}${US}#{session_id}${US}#{window_id}`;

export interface PaneState {
  pinned: Set<string>;
  live: Map<string, PaneLocation>;
}

/** Parse `list-panes -a -F PANE_STATE_FORMAT` output into pinned set + location map. */
export function parsePaneStateLines(lines: string[]): PaneState {
  const pinned = new Set<string>();
  const live = new Map<string, PaneLocation>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const [paneId, pin, sessionId, windowId] = line.split(US);
    if (!paneId) continue;
    live.set(paneId, { sessionId: sessionId ?? "", windowId: windowId ?? "" });
    if (pin === "1") pinned.add(paneId);
  }
  return { pinned, live };
}
