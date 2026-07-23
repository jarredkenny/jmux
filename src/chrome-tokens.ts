// Single home for chrome colours, spacing, and frame glyphs.
//
// Chrome colours were previously scattered as raw literals across modal.ts,
// sidebar.ts, renderer.ts and friends, each with its own re-theming hook —
// which is how colour collisions arose (two oranges both meaning "active",
// green meaning four different things). This module owns every chrome
// colour so later work migrates onto a single semantic set: one accent
// (focus), a neutral text ramp, and semantic affirmative/attention/failure/
// link roles.
//
// `tokens` follows the same live-re-theming idiom as modal.ts's
// rebuildModalAttrs: each `CellAttrs` object is mutated in place by
// rebuildChromeTokens() so existing imports stay live across a re-theme
// (e.g. on OSC 11 background detection) without needing to re-import.

import { ColorMode } from "./types";
import type { CellAttrs } from "./cell-grid";
import { theme, neutralFg, accentFor, mix, unpack, pack } from "./theme";

/** The single jmux accent — used for focus/active chrome. */
export const ACCENT_BASE = 0xf0883e;

// --- Chrome colour tokens ---
//
// Populated in place by rebuildChromeTokens(); see that function for the
// derivation of each role. Objects are imported by reference across chrome
// modules and mutated, never reassigned, so identity survives a re-theme.

export const tokens: {
  accent: CellAttrs;
  accentMuted: CellAttrs;
  textPrimary: CellAttrs;
  textSecondary: CellAttrs;
  textTertiary: CellAttrs;
  ruleFrame: CellAttrs;
  ruleHairline: CellAttrs;
  affirmative: CellAttrs;
  attention: CellAttrs;
  failure: CellAttrs;
  link: CellAttrs;
  modePlan: CellAttrs;
} = {
  accent: {},
  accentMuted: {},
  textPrimary: {},
  textSecondary: {},
  textTertiary: {},
  ruleFrame: {},
  ruleHairline: {},
  affirmative: {},
  attention: {},
  failure: {},
  link: {},
  modePlan: {},
};

/**
 * Repopulate every `tokens.*` object from the current `theme`. Called once at
 * module load (default theme) and again whenever the terminal background is
 * detected or changes. Each object's identity is preserved so existing
 * imports stay live.
 */
export function rebuildChromeTokens(): void {
  const assign = (target: CellAttrs, src: CellAttrs): void => {
    // Reset attrs that vary between roles so a rebuild can't leave stale flags.
    delete target.dim;
    Object.assign(target, src);
  };

  const anchor = theme.isLight ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  const accentMutedFg = pack(mix(unpack(theme.surface), anchor, 0.55));

  const textSecondary = neutralFg(8);

  assign(tokens.accent, { fg: accentFor(ACCENT_BASE), fgMode: ColorMode.RGB });
  assign(tokens.accentMuted, { fg: accentMutedFg, fgMode: ColorMode.RGB });
  assign(tokens.textPrimary, neutralFg(7));
  assign(tokens.textSecondary, textSecondary);
  assign(tokens.textTertiary, { ...textSecondary, dim: true });
  assign(tokens.ruleFrame, { ...textSecondary, dim: true });
  assign(tokens.ruleHairline, { ...textSecondary, dim: true });
  assign(tokens.affirmative, { fg: 2, fgMode: ColorMode.Palette });
  assign(tokens.attention, { fg: 3, fgMode: ColorMode.Palette });
  assign(tokens.failure, { fg: 1, fgMode: ColorMode.Palette });
  assign(tokens.link, { fg: accentFor(0x58a6ff), fgMode: ColorMode.RGB });
  assign(tokens.modePlan, { fg: 6, fgMode: ColorMode.Palette });
}

rebuildChromeTokens();

// --- Spacing scale ---
//
// Terminal-cell units. `inset` is the standard padding inside chrome panels;
// `modalInset` the wider padding for modal dialogs; `glyphGutter` the gap
// after a leading icon/glyph; `groupGutter` the gap between sidebar groups;
// `blockGap` the gap between stacked blocks; `measure` a default max content
// width for prose-like chrome text.
export const space = {
  inset: 1,
  modalInset: 2,
  glyphGutter: 1,
  groupGutter: 2,
  blockGap: 1,
  measure: 64,
} as const;

// --- Frame glyphs ---
//
// The box-drawing characters used to render chrome frames/rules.
export const frame = {
  ruleLight: "─",
  ruleHeavy: "━",
  crossDown: "┼",
  crossUp: "┴",
  divider: "│",
} as const;
