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

/**
 * The neutral name plus the 16 ANSI names — this is the full set of choices
 * offered by the settings/palette picker. Kept separate from
 * STATE_COLOR_NAMES so the positional ANSI→palette-index mapping above is
 * never disturbed (appending here would shift index 16, which doesn't exist).
 */
export const STATE_COLOR_CHOICES = [...STATE_COLOR_NAMES, "neutral"] as const;

export type StateColorChoice = (typeof STATE_COLOR_CHOICES)[number];

/**
 * A resolved agent-state color: either a real palette index (an ANSI name
 * the user picked) or the neutral tone — a finished agent recedes rather
 * than taking on a palette color.
 */
export type StateColor = { kind: "palette"; index: number } | { kind: "neutral" };

const NAME_TO_PALETTE: Record<StateColorName, number> = STATE_COLOR_NAMES.reduce(
  (acc, name, idx) => {
    acc[name] = idx;
    return acc;
  },
  {} as Record<StateColorName, number>,
);

/** Default color per state — matches jmux's original hardcoded palette. */
export const DEFAULT_STATE_COLORS: Record<AgentState, StateColorChoice> = {
  running: "green",
  waiting: "yellow",
  complete: "neutral",
};

/**
 * Resolve a color name to a palette index, or null if the name is unknown.
 * Case-insensitive.
 */
export function colorNameToPalette(name: string): number | null {
  const key = name.toLowerCase();
  return Object.hasOwn(NAME_TO_PALETTE, key)
    ? NAME_TO_PALETTE[key as StateColorName]
    : null;
}

/**
 * Resolve a state-color config into a StateColor for every agent state.
 * Missing or invalid names fall back to that state's default, so the result is
 * always a valid, complete map — the single place defaults + validation live.
 * "neutral" resolves to { kind: "neutral" } rather than a palette index —
 * it is never assigned an ANSI slot, so it can never collide with (or be
 * mistaken for) palette index 16, which doesn't exist.
 */
export function resolveStateColors(cfg?: StateColorConfig): Record<AgentState, StateColor> {
  const resolve = (state: AgentState): StateColor => {
    const name = cfg?.[state] ?? DEFAULT_STATE_COLORS[state];
    if (name.toLowerCase() === "neutral") return { kind: "neutral" };
    const palette = colorNameToPalette(name);
    if (palette !== null) return { kind: "palette", index: palette };
    // Invalid name: fall back to this state's default.
    const fallback = DEFAULT_STATE_COLORS[state];
    return fallback === "neutral"
      ? { kind: "neutral" }
      : { kind: "palette", index: NAME_TO_PALETTE[fallback] };
  };
  return {
    running: resolve("running"),
    waiting: resolve("waiting"),
    complete: resolve("complete"),
  };
}

/**
 * Temporary bridge for callers not yet migrated to the StateColor union
 * (sidebar indicator attrs, glass border palette). Palette 8 (bright-black /
 * grey) is the neutral tone — it's the closest existing palette slot to the
 * dim-blue "complete" look this replaces. Superseded by plan 3's stateAttrs.
 */
export function stateColorToPalette(c: StateColor): number {
  return c.kind === "neutral" ? 8 : c.index;
}
