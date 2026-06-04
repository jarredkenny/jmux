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
  branch?: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  attached: boolean;
  activity: number;
  gitBranch?: string;
  windowCount: number;
  directory?: string;
  project?: string; // wtm project name (bare repo basename)
}

export type ErrorState = {
  type: "api_error" | "api_retries_exhausted";
  timestamp: number;
};

export type PermissionMode = "default" | "plan" | "accept-edits";

export interface SessionOtelState {
  // Cache-timer fields (existing)
  lastRequestTime: number;
  cacheWasHit: boolean;

  // Current main-loop context occupancy in tokens (input + cache_read +
  // cache_creation of the latest main-thread api_request). Reset on compaction.
  contextTokens: number;
  lastError: ErrorState | null;
  failedMcpServers: Set<string>;
  permissionMode: PermissionMode;
  lastCompactionTime: number | null;
  lastUserPromptTime: number | null;
}

export function makeSessionOtelState(): SessionOtelState {
  return {
    lastRequestTime: 0,
    cacheWasHit: false,
    contextTokens: 0,
    lastError: null,
    failedMcpServers: new Set(),
    permissionMode: "default",
    lastCompactionTime: null,
    lastUserPromptTime: null,
  };
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

export type AgentState = "running" | "waiting" | "complete";

export interface AgentStateRecord {
  state: AgentState;
  /** Epoch milliseconds. Converted from the seconds the hook writes. */
  since: number;
}
