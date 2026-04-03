import type { CellGrid, SessionInfo } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

const HEADER_ROWS = 2; // "jmux" + separator line

const DIM_ATTRS: CellAttrs = { dim: true };
const ACTIVE_BG: CellAttrs = {
  bg: 8,
  bgMode: ColorMode.Palette,
};
const HIGHLIGHT_BG: CellAttrs = {
  bg: 4,
  bgMode: ColorMode.Palette,
};
const ACTIVITY_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
};
const ATTENTION_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
  bold: true,
};

export class Sidebar {
  private width: number;
  private height: number;
  private sessions: SessionInfo[] = [];
  private activeSessionId: string | null = null;
  private highlightIndex = 0;
  private activitySet = new Set<string>();

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
    const idx = row - HEADER_ROWS;
    if (idx < 0 || idx >= this.sessions.length) return null;
    return this.sessions[idx];
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

    // Session rows
    for (let i = 0; i < this.sessions.length; i++) {
      const row = HEADER_ROWS + i;
      if (row >= this.height) break;

      const session = this.sessions[i];
      const isActive = session.id === this.activeSessionId;
      const isHighlighted = i === this.highlightIndex;
      const hasActivity = this.activitySet.has(session.id);

      const rowAttrs: CellAttrs = isHighlighted
        ? { ...HIGHLIGHT_BG }
        : isActive
          ? { ...ACTIVE_BG }
          : {};

      if (isHighlighted || isActive) {
        writeString(grid, row, 0, " ".repeat(this.width), rowAttrs);
      }

      let indicatorCol = 0;
      if (session.attention) {
        writeString(grid, row, 0, "!", {
          ...rowAttrs,
          ...ATTENTION_ATTRS,
        });
        indicatorCol = 2;
      } else if (hasActivity) {
        writeString(grid, row, 0, "\u25CF", {
          ...rowAttrs,
          ...ACTIVITY_ATTRS,
        });
        indicatorCol = 2;
      }

      let branchCols = 0;
      if (session.gitBranch) {
        branchCols = session.gitBranch.length + 1;
        const branchCol = this.width - session.gitBranch.length;
        if (branchCol > indicatorCol + 3) {
          writeString(grid, row, branchCol, session.gitBranch, {
            ...rowAttrs,
            ...DIM_ATTRS,
          });
        } else {
          branchCols = 0;
        }
      }

      const nameMaxLen = this.width - indicatorCol - branchCols;
      let displayName = session.name;
      if (displayName.length > nameMaxLen) {
        displayName = displayName.slice(0, nameMaxLen - 1) + "\u2026";
      }
      writeString(grid, row, indicatorCol, displayName, rowAttrs);
    }

    return grid;
  }
}
