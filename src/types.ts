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
  // OSC 8 hyperlink target. When set, the renderer wraps runs of cells
  // sharing the same link in OSC 8 open/close escapes so the terminal
  // treats the visible text as one clickable region — even across line
  // wraps where regex-based URL detection would otherwise fail.
  link?: string;
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

export interface CacheTimerState {
  lastRequestTime: number;  // Date.now() when the api_request event was received
  cacheWasHit: boolean;     // cache_read_tokens > 0 on the last request
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
  | { type: "result"; value: PaletteResult };
