import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import type { CellAttrs } from "./cell-grid";
import { theme, neutralFg } from "./theme";

// --- Modal interface ---

export type ModalAction =
  | { type: "consumed" }
  | { type: "closed" }
  | { type: "result"; value: unknown };

export interface Modal {
  isOpen(): boolean;
  preferredWidth(termCols: number): number;
  getGrid(width: number): CellGrid;
  getCursorPosition(): { row: number; col: number } | null;
  handleInput(data: string): ModalAction;
  close(): void;
}

// --- Shared color attrs ---
//
// These objects are imported by reference across the modals and read by
// writeString() on every render, so mutating them in place (see
// rebuildModalAttrs) re-themes every modal without re-importing. They start
// populated from DEFAULT_THEME and are rebuilt once a terminal background is
// detected. Neutral text (white/gray) follows `neutralFg`; accent colors
// (green prompt/match, yellow tag) are palette and theme-independent.

export const HEADER_ATTRS: CellAttrs = {};
export const SUBHEADER_ATTRS: CellAttrs = {};
export const PROMPT_ATTRS: CellAttrs = {};
export const INPUT_ATTRS: CellAttrs = {};
export const RESULT_ATTRS: CellAttrs = {};
export const SELECTED_RESULT_ATTRS: CellAttrs = {};
export const MATCH_ATTRS: CellAttrs = {};
export const SELECTED_MATCH_ATTRS: CellAttrs = {};
export const CATEGORY_ATTRS: CellAttrs = {};
export const SELECTED_CATEGORY_ATTRS: CellAttrs = {};
export const CURRENT_TAG_ATTRS: CellAttrs = {};
export const SELECTED_CURRENT_TAG_ATTRS: CellAttrs = {};
export const BREADCRUMB_ATTRS: CellAttrs = {};
export const NO_MATCHES_ATTRS: CellAttrs = {};
export const DIM_ATTRS: CellAttrs = {};
export const BG_ATTRS: CellAttrs = {};
export const SELECTED_BG_ATTRS: CellAttrs = {};

/**
 * Repopulate every shared attr object from the current `theme`. Called once at
 * module load (default theme) and again whenever the terminal background is
 * detected. Each object's identity is preserved so existing imports stay live.
 */
export function rebuildModalAttrs(): void {
  const surface = theme.surface;
  const selected = theme.selected;
  const onSurface = { bg: surface, bgMode: ColorMode.RGB };
  const onSelected = { bg: selected, bgMode: ColorMode.RGB };
  const primary = neutralFg(7);
  const secondary = neutralFg(8);

  const assign = (target: CellAttrs, src: CellAttrs): void => {
    // Reset attrs that vary between roles so a rebuild can't leave stale flags.
    delete target.bold;
    delete target.dim;
    Object.assign(target, src);
  };

  assign(HEADER_ATTRS, { ...primary, bold: true, ...onSurface });
  assign(SUBHEADER_ATTRS, { ...secondary, ...onSurface });
  assign(PROMPT_ATTRS, { fg: 2, fgMode: ColorMode.Palette, ...onSurface });
  assign(INPUT_ATTRS, { ...primary, bold: true, ...onSurface });
  assign(RESULT_ATTRS, { ...primary, dim: true, ...onSurface });
  assign(SELECTED_RESULT_ATTRS, { ...primary, ...onSelected });
  assign(MATCH_ATTRS, { fg: 2, fgMode: ColorMode.Palette, ...onSurface });
  assign(SELECTED_MATCH_ATTRS, {
    fg: 2,
    fgMode: ColorMode.Palette,
    bold: true,
    ...onSelected,
  });
  assign(CATEGORY_ATTRS, { ...secondary, ...onSurface });
  assign(SELECTED_CATEGORY_ATTRS, { ...secondary, ...onSelected });
  assign(CURRENT_TAG_ATTRS, { fg: 3, fgMode: ColorMode.Palette, ...onSurface });
  assign(SELECTED_CURRENT_TAG_ATTRS, {
    fg: 3,
    fgMode: ColorMode.Palette,
    ...onSelected,
  });
  assign(BREADCRUMB_ATTRS, { ...secondary, ...onSurface });
  assign(NO_MATCHES_ATTRS, { ...secondary, dim: true, ...onSurface });
  assign(DIM_ATTRS, { ...secondary, dim: true, ...onSurface });
  assign(BG_ATTRS, { ...onSurface });
  assign(SELECTED_BG_ATTRS, { ...onSelected });
}

rebuildModalAttrs();
