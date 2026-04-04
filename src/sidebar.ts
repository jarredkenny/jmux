import type { CellGrid, SessionInfo } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

const ROWS_PER_SESSION = 3;
const HEADER_ROWS = 2; // "jmux" + separator line

const DIM_ATTRS: CellAttrs = { dim: true };
const ACTIVE_BG: CellAttrs = {
  bg: 8,
  bgMode: ColorMode.Palette,
}; // bright black (dark gray) — subtle highlight
const HIGHLIGHT_BG: CellAttrs = {
  bg: 4,
  bgMode: ColorMode.Palette,
}; // blue — picking state
const ACTIVITY_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
}; // green
const ATTENTION_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
  bold: true,
}; // yellow bold
const ACTIVE_NAME_ATTRS: CellAttrs = { bold: true }; // bold name for active session

export class Sidebar {
  private width: number;
  private height: number;
  private sessions: SessionInfo[] = [];
  private activeSessionId: string | null = null;
  private highlightIndex = 0;
  private activitySet = new Set<string>();
  private _sidebarMode = false;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  updateSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    if (this.highlightIndex >= sessions.length) {
      this.highlightIndex = Math.max(0, sessions.length - 1);
    }
  }

  setActiveSession(id: string): void {
    this.activeSessionId = id;
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx >= 0) this.highlightIndex = idx;
  }

  setActivity(sessionId: string, active: boolean): void {
    if (active) {
      this.activitySet.add(sessionId);
    } else {
      this.activitySet.delete(sessionId);
    }
  }

  moveHighlight(delta: number): void {
    if (this.sessions.length === 0) return;
    this.highlightIndex =
      (this.highlightIndex + delta + this.sessions.length) %
      this.sessions.length;
  }

  getHighlightedSessionId(): string | null {
    return this.sessions[this.highlightIndex]?.id ?? null;
  }

  getSessionByRow(row: number): SessionInfo | null {
    const idx = Math.floor((row - HEADER_ROWS) / ROWS_PER_SESSION);
    if (idx < 0 || idx >= this.sessions.length) return null;
    return this.sessions[idx];
  }

  setSidebarMode(active: boolean): void {
    this._sidebarMode = active;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  getGrid(): CellGrid {
    const grid = createGrid(this.width, this.height);

    // Header
    writeString(grid, 0, 0, "jmux", { bold: true });

    // Separator line
    const sep = "\u2500".repeat(this.width);
    writeString(grid, 1, 0, sep, DIM_ATTRS);

    // Session rows — 3 rows each: name line, detail line, blank spacer
    for (let i = 0; i < this.sessions.length; i++) {
      const nameRow = HEADER_ROWS + i * ROWS_PER_SESSION;
      const detailRow = nameRow + 1;
      if (nameRow >= this.height) break;

      const session = this.sessions[i];
      const isActive = session.id === this.activeSessionId;
      const isHighlighted = i === this.highlightIndex;
      const hasActivity = this.activitySet.has(session.id);

      const showHighlight = isHighlighted && this._sidebarMode;
      const rowAttrs: CellAttrs = showHighlight
        ? { ...HIGHLIGHT_BG }
        : isActive
          ? { ...ACTIVE_BG }
          : {};

      // Fill background on both content rows if active or highlighted
      if (showHighlight || isActive) {
        writeString(grid, nameRow, 0, " ".repeat(this.width), rowAttrs);
        if (detailRow < this.height) {
          writeString(grid, detailRow, 0, " ".repeat(this.width), rowAttrs);
        }
      }

      // Col 0: padding space (already blank)
      // Col 1: indicator
      if (session.attention) {
        writeString(grid, nameRow, 1, "!", {
          ...rowAttrs,
          ...ATTENTION_ATTRS,
        });
      } else if (hasActivity) {
        writeString(grid, nameRow, 1, "\u25CF", {
          ...rowAttrs,
          ...ACTIVITY_ATTRS,
        });
      }
      // Col 2: separator space (already blank)

      // Right-aligned window count ("Nw"), dimmed
      const windowCountStr = `${session.windowCount}w`;
      const windowCountCol = this.width - windowCountStr.length;

      // Session name starting at col 3, truncated to avoid collision with window count
      // Leave at least 1 space gap between name and window count
      const nameMaxLen = windowCountCol - 1 - 3; // width minus windowcount minus gap minus start col
      let displayName = session.name;
      if (displayName.length > nameMaxLen) {
        displayName = displayName.slice(0, nameMaxLen - 1) + "\u2026";
      }

      const nameAttrs: CellAttrs =
        isActive ? { ...rowAttrs, ...ACTIVE_NAME_ATTRS } : rowAttrs;
      writeString(grid, nameRow, 3, displayName, nameAttrs);

      // Window count right-aligned on name row
      if (windowCountCol > 3) {
        writeString(grid, nameRow, windowCountCol, windowCountStr, {
          ...rowAttrs,
          ...DIM_ATTRS,
        });
      }

      // Detail line (row 2 of this session)
      if (detailRow < this.height && session.directory !== undefined) {
        // Right-aligned git branch, dimmed
        let branchCols = 0;
        if (session.gitBranch) {
          const branchStr = session.gitBranch;
          const branchCol = this.width - branchStr.length;
          // Only show if there's room — needs gap from directory start (col 3)
          if (branchCol > 3 + 1) {
            writeString(grid, detailRow, branchCol, branchStr, {
              ...rowAttrs,
              ...DIM_ATTRS,
            });
            branchCols = branchStr.length + 1;
          }
        }

        // Directory path starting at col 3, dimmed
        const dirMaxLen = this.width - 3 - branchCols;
        let displayDir = session.directory;
        if (displayDir.length > dirMaxLen) {
          displayDir = displayDir.slice(0, dirMaxLen - 1) + "\u2026";
        }
        writeString(grid, detailRow, 3, displayDir, {
          ...rowAttrs,
          ...DIM_ATTRS,
        });
      }
    }

    return grid;
  }
}
