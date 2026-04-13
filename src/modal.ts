import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import type { CellAttrs } from "./cell-grid";

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

// --- Shared color constants ---

export const MODAL_BG = (0x16 << 16) | (0x1b << 8) | 0x22; // #161b22
export const SELECTED_BG = (0x1e << 16) | (0x2a << 8) | 0x35; // #1e2a35

export const HEADER_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SUBHEADER_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const PROMPT_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const INPUT_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const RESULT_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SELECTED_RESULT_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

export const MATCH_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SELECTED_MATCH_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

export const CATEGORY_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SELECTED_CATEGORY_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

export const CURRENT_TAG_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SELECTED_CURRENT_TAG_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

export const BREADCRUMB_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const NO_MATCHES_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const DIM_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const BG_ATTRS: CellAttrs = {
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SELECTED_BG_ATTRS: CellAttrs = {
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};
