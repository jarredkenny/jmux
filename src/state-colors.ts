import type { AgentState } from "./types";
import type { StateColorConfig } from "./config";

/**
 * The 16 named ANSI colors users may pick for agent-state indicators, mapping
 * to palette indices 0-15. These names also drive the settings/palette picker.
 */
export const STATE_COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightblack",
  "brightred",
  "brightgreen",
  "brightyellow",
  "brightblue",
  "brightmagenta",
  "brightcyan",
  "brightwhite",
] as const;

export type StateColorName = (typeof STATE_COLOR_NAMES)[number];

const NAME_TO_PALETTE: Record<StateColorName, number> = STATE_COLOR_NAMES.reduce(
  (acc, name, idx) => {
    acc[name] = idx;
    return acc;
  },
  {} as Record<StateColorName, number>,
);

/** Default color per state — matches jmux's original hardcoded palette. */
export const DEFAULT_STATE_COLORS: Record<AgentState, StateColorName> = {
  running: "green",
  waiting: "yellow",
  complete: "blue",
};

/**
 * Resolve a color name to a palette index, or null if the name is unknown.
 * Case-insensitive.
 */
export function colorNameToPalette(name: string): number | null {
  const key = name.toLowerCase() as StateColorName;
  return key in NAME_TO_PALETTE ? NAME_TO_PALETTE[key] : null;
}

/**
 * Resolve a state-color config into palette indices for every agent state.
 * Missing or invalid names fall back to that state's default, so the result is
 * always a valid, complete map — the single place defaults + validation live.
 */
export function resolveStateColors(cfg?: StateColorConfig): Record<AgentState, number> {
  const resolve = (state: AgentState): number => {
    const name = cfg?.[state];
    const palette = name ? colorNameToPalette(name) : null;
    return palette ?? NAME_TO_PALETTE[DEFAULT_STATE_COLORS[state]];
  };
  return {
    running: resolve("running"),
    waiting: resolve("waiting"),
    complete: resolve("complete"),
  };
}
