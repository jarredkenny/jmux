import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { writeString, writeStyledLine, textCols, type CellAttrs } from "./cell-grid";
import { theme, neutralFg } from "./theme";
import { tokens, frame, space } from "./chrome-tokens";
import { layoutFooter, type FooterSegment } from "./footer";

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
// detected. Neutral text (white/gray) follows `neutralFg`; the prompt caret
// and fuzzy-match highlight follow `tokens.accent` (green now means
// "running", not focus) and the current-tag chip follows `tokens.textPrimary`
// bold (yellow retired — weight signals "current", not hue).

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
  assign(PROMPT_ATTRS, { ...tokens.accent, ...onSurface });
  assign(INPUT_ATTRS, { ...primary, bold: true, ...onSurface });
  assign(RESULT_ATTRS, { ...primary, dim: true, ...onSurface });
  assign(SELECTED_RESULT_ATTRS, { ...primary, ...onSelected });
  assign(MATCH_ATTRS, { ...tokens.accent, ...onSurface });
  assign(SELECTED_MATCH_ATTRS, {
    ...tokens.accent,
    bold: true,
    ...onSelected,
  });
  assign(CATEGORY_ATTRS, { ...secondary, ...onSurface });
  assign(SELECTED_CATEGORY_ATTRS, { ...secondary, ...onSelected });
  assign(CURRENT_TAG_ATTRS, { ...tokens.textPrimary, bold: true, ...onSurface });
  assign(SELECTED_CURRENT_TAG_ATTRS, {
    ...tokens.textPrimary,
    bold: true,
    ...onSelected,
  });
  assign(BREADCRUMB_ATTRS, { ...secondary, ...onSurface });
  assign(NO_MATCHES_ATTRS, { ...secondary, dim: true, ...onSurface });
  assign(DIM_ATTRS, { ...secondary, dim: true, ...onSurface });
  assign(BG_ATTRS, { ...onSurface });
  assign(SELECTED_BG_ATTRS, { ...onSelected });
}

rebuildModalAttrs();

// --- Modal chrome primitive ---
//
// One shared title/hairline/hint-footer treatment for modals, in the same
// dialect as the persistent footer (footer.ts): a title row (bold text, plus
// an optional right-aligned count), an optional full-width hairline directly
// under the modal's input line, and a hint-footer row that reuses
// layoutFooter's " · " packing so a modal's hints read identically to the
// toolbar's.
//
// Layout (grid rows, top to bottom), when everything fits:
//   row 0                     title (+ count)
//   row 1                     the modal's own input/breadcrumb line
//   row 2  (hairlineAfterInput only)  hairline
//   rows 2|3 .. R-1-hintRows  the rect returned by modalContentRect — the
//                             modal's own results/content
//   row R-1 (hints.length > 0 only)   hint footer
//
// A modal that has no separate input line (hairlineAfterInput: false) simply
// treats the first row of the returned content rect as its own first line —
// there's no fixed input row reserved outside the rect in that case.
//
// Degradation (as the outer grid gets too short for chrome + >=1 content
// row): drop the hint footer first, then the count, then the title itself —
// each dropped element frees its row (the count doesn't have its own row, so
// dropping it is a no-op for the row math, but it's still the documented
// priority a very narrow title row falls back to before the title text
// itself is sacrificed). The hairline's presence is controlled purely by
// `hairlineAfterInput` — it isn't part of this degradation ladder.
export interface ModalChrome {
  title: string;
  count?: string;
  hints: FooterSegment[];
  hairlineAfterInput?: boolean;
}

interface ChromePlan {
  showTitle: boolean;
  showCount: boolean;
  showHairline: boolean;
  showHint: boolean;
  contentTop: number;
  contentRows: number;
}

function planChrome(chrome: ModalChrome, outer: { cols: number; rows: number }): ChromePlan {
  const hairlineWanted = chrome.hairlineAfterInput === true;
  // Input row + hairline row, both reserved above the content rect.
  const hairlineReservedRows = hairlineWanted ? 2 : 0;

  let showTitle = true;
  let showCount = chrome.count !== undefined;
  let showHint = chrome.hints.length > 0;

  const reservedRows = (): { top: number; bottom: number } => ({
    top: (showTitle ? 1 : 0) + hairlineReservedRows,
    bottom: showHint ? 1 : 0,
  });

  let reserved = reservedRows();
  let contentRows = outer.rows - reserved.top - reserved.bottom;

  if (contentRows < 1 && showHint) {
    showHint = false;
    reserved = reservedRows();
    contentRows = outer.rows - reserved.top - reserved.bottom;
  }
  if (contentRows < 1 && showCount) {
    // Dropping the count never frees a row (it shares the title's row) — kept
    // as its own ladder step purely to document the priority order; the row
    // math is unaffected.
    showCount = false;
  }
  if (contentRows < 1 && showTitle) {
    showTitle = false;
    reserved = reservedRows();
    contentRows = outer.rows - reserved.top - reserved.bottom;
  }

  return {
    showTitle, showCount, showHairline: hairlineWanted, showHint,
    contentTop: reserved.top,
    contentRows: Math.max(0, contentRows),
  };
}

/**
 * The interior rect a modal may draw its content (its results/list — not its
 * input line, when `hairlineAfterInput` is set) into, after reserving rows
 * for the title, the input+hairline pair, and the hint footer. See the
 * module-level comment above for the full row layout and degradation order.
 */
export function modalContentRect(
  chrome: ModalChrome,
  outer: { cols: number; rows: number },
): { top: number; left: number; cols: number; rows: number } {
  const plan = planChrome(chrome, outer);
  return { top: plan.contentTop, left: 0, cols: outer.cols, rows: plan.contentRows };
}

/**
 * Paints the title row (+ optional right-aligned count), the hairline (if
 * `hairlineAfterInput`), and the hint footer row directly onto `grid` —
 * sized exactly as `modalContentRect` expects (title/hairline/hint rows
 * reserved, everything else left for the modal's own content). Colours come
 * from `tokens.*`; the hint footer reuses `footer.ts`'s `layoutFooter` so a
 * modal's hints render in the exact same dialect as the persistent footer.
 * Assumes the caller has already filled the grid's background (BG_ATTRS) —
 * this only overwrites glyphs/foreground on the rows it owns.
 */
export function drawModalChrome(grid: CellGrid, chrome: ModalChrome): void {
  const outer = { cols: grid.cols, rows: grid.rows };
  const plan = planChrome(chrome, outer);

  if (plan.showTitle) {
    const titleAttrs: CellAttrs = { ...tokens.textPrimary, bold: true };
    writeString(grid, 0, space.inset, chrome.title, titleAttrs);

    if (plan.showCount && chrome.count) {
      const titleEndCol = space.inset + textCols(chrome.title);
      const countCol = grid.cols - space.inset - textCols(chrome.count);
      // Only draw the count if there's at least one blank column between it
      // and the title — otherwise drop it (the "count" degradation step,
      // driven by width rather than height).
      if (countCol > titleEndCol) {
        writeString(grid, 0, countCol, chrome.count, tokens.textSecondary);
      }
    }
  }

  if (plan.showHairline) {
    const hairlineRow = plan.contentTop - 1;
    writeString(grid, hairlineRow, 0, frame.ruleLight.repeat(grid.cols), tokens.ruleHairline);
  }

  if (plan.showHint) {
    const hintRow = grid.rows - 1;
    const hintLayout = layoutFooter({ left: chrome.hints, right: [] }, grid.cols);
    writeStyledLine(grid, hintRow, 0, hintLayout.cells, grid.cols);
  }
}
