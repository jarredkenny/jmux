export const enum ColorMode {
  Default = 0,
  Palette = 1,
  RGB = 2,
}

export interface Cell {
  char: string;
  width: number; // 0 = continuation of wide char, 1 = normal, 2 = wide
  fg: number;
  bg: number;
  fgMode: ColorMode;
  bgMode: ColorMode;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
}

export interface CellGrid {
  cols: number;
  rows: number;
  cells: Cell[][];
}

export interface CursorPosition {
  x: number;
  y: number;
}

export interface WindowTab {
  windowId: string;
  index: number;
  name: string;
  active: boolean;
  bell: boolean;
  zoomed: boolean;
}

export interface SessionInfo {
  id: string;
  name: string;
  attached: boolean;
  activity: number;
  gitBranch?: string;
  attention: boolean;
  windowCount: number;
  directory?: string;
  project?: string; // wtm project name (bare repo basename)
}

export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  sublist?: PaletteSublistOption[];
}

export interface PaletteSublistOption {
  id: string;
  label: string;
  current?: boolean;
}

export interface PaletteResult {
  commandId: string;
  sublistOptionId?: string;
}

export type PaletteAction =
  | { type: "consumed" }
  | { type: "closed" }
  | { type: "execute"; result: PaletteResult };
