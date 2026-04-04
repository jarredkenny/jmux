import type { CellGrid, SessionInfo } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

const HEADER_ROWS = 2; // "jmux" header + separator

const DIM_ATTRS: CellAttrs = { dim: true };
const ACCENT_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
};
const ACTIVE_MARKER_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bold: true,
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
const ACTIVE_NAME_ATTRS: CellAttrs = {
  fg: 15,
  fgMode: ColorMode.Palette,
  bold: true,
};
const INACTIVE_NAME_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
};
const GROUP_HEADER_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bold: true,
};

// --- Grouping logic ---

interface SessionGroup {
  label: string;
  sessionIndices: number[];
}

function getParentLabel(dir: string): string | null {
  const lastSlash = dir.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const parent = dir.slice(0, lastSlash);
  const segments = parent.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  if (segments[0] === "~" && segments.length === 1) return null;
  return segments.slice(-2).join("/");
}

type RenderItem =
  | { type: "group-header"; label: string }
  | { type: "session"; sessionIndex: number; grouped: boolean }
  | { type: "spacer" };

function buildRenderPlan(sessions: SessionInfo[]): {
  items: RenderItem[];
  displayOrder: number[];
} {
  // Group sessions by parent directory
  const groupMap = new Map<string, number[]>();
  const ungrouped: number[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const dir = sessions[i].directory;
    if (!dir) {
      ungrouped.push(i);
      continue;
    }
    const label = getParentLabel(dir);
    if (!label) {
      ungrouped.push(i);
      continue;
    }
    const existing = groupMap.get(label);
    if (existing) {
      existing.push(i);
    } else {
      groupMap.set(label, [i]);
    }
  }

  // Solo groups → move to ungrouped
  for (const [label, indices] of groupMap) {
    if (indices.length === 1) {
      ungrouped.push(indices[0]);
      groupMap.delete(label);
    }
  }

  // Sort groups by label, sessions within groups by name
  const sortedGroups: SessionGroup[] = [...groupMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, indices]) => ({
      label,
      sessionIndices: indices.sort((a, b) =>
        sessions[a].name.localeCompare(sessions[b].name),
      ),
    }));

  // Sort ungrouped by name
  ungrouped.sort((a, b) => sessions[a].name.localeCompare(sessions[b].name));

  // Build render plan and display order
  const items: RenderItem[] = [];
  const displayOrder: number[] = [];

  for (const group of sortedGroups) {
    items.push({ type: "group-header", label: group.label });
    for (const idx of group.sessionIndices) {
      items.push({ type: "session", sessionIndex: idx, grouped: true });
      displayOrder.push(idx);
      items.push({ type: "spacer" });
    }
  }

  // Ungrouped sessions
  for (const idx of ungrouped) {
    items.push({ type: "session", sessionIndex: idx, grouped: false });
    displayOrder.push(idx);
    items.push({ type: "spacer" });
  }

  return { items, displayOrder };
}

// --- Sidebar class ---

export class Sidebar {
  private width: number;
  private height: number;
  private sessions: SessionInfo[] = [];
  private activeSessionId: string | null = null;
  private highlightIndex = 0; // index into displayOrder
  private displayOrder: number[] = []; // indices into sessions, in visual order
  private rowToSessionIndex = new Map<number, number>(); // row → index into sessions
  private activitySet = new Set<string>();
  private _sidebarMode = false;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  updateSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    const { displayOrder } = buildRenderPlan(sessions);
    this.displayOrder = displayOrder;
    if (this.highlightIndex >= displayOrder.length) {
      this.highlightIndex = Math.max(0, displayOrder.length - 1);
    }
  }

  setActiveSession(id: string): void {
    this.activeSessionId = id;
    const sessionIdx = this.sessions.findIndex((s) => s.id === id);
    if (sessionIdx >= 0) {
      const displayIdx = this.displayOrder.indexOf(sessionIdx);
      if (displayIdx >= 0) this.highlightIndex = displayIdx;
    }
  }

  setActivity(sessionId: string, active: boolean): void {
    if (active) {
      this.activitySet.add(sessionId);
    } else {
      this.activitySet.delete(sessionId);
    }
  }

  moveHighlight(delta: number): void {
    if (this.displayOrder.length === 0) return;
    this.highlightIndex =
      (this.highlightIndex + delta + this.displayOrder.length) %
      this.displayOrder.length;
  }

  getHighlightedSessionId(): string | null {
    const sessionIdx = this.displayOrder[this.highlightIndex];
    return this.sessions[sessionIdx]?.id ?? null;
  }

  getSessionByRow(row: number): SessionInfo | null {
    const sessionIdx = this.rowToSessionIndex.get(row);
    if (sessionIdx === undefined) return null;
    return this.sessions[sessionIdx] ?? null;
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
    this.rowToSessionIndex.clear();

    // Header
    writeString(grid, 0, 1, "jmux", { ...ACCENT_ATTRS, bold: true });
    writeString(grid, 1, 0, "\u2500".repeat(this.width), DIM_ATTRS);

    const { items } = buildRenderPlan(this.sessions);
    let row = HEADER_ROWS;

    for (const item of items) {
      if (row >= this.height) break;

      if (item.type === "group-header") {
        // Group header — last two path segments, dimmed bold
        let label = item.label;
        if (label.length > this.width - 2) {
          label = label.slice(0, this.width - 3) + "\u2026";
        }
        writeString(grid, row, 1, label, GROUP_HEADER_ATTRS);
        row++;
        continue;
      }

      if (item.type === "spacer") {
        row++;
        continue;
      }

      // Session entry — 2 rows: name line + detail line
      const sessionIdx = item.sessionIndex;
      const session = this.sessions[sessionIdx];
      if (!session) continue;

      const nameRow = row;
      const detailRow = row + 1;
      const isActive = session.id === this.activeSessionId;
      const displayIdx = this.displayOrder.indexOf(sessionIdx);
      const isHighlighted = displayIdx === this.highlightIndex;
      const hasActivity = this.activitySet.has(session.id);
      const showHighlight = isHighlighted && this._sidebarMode;

      // Map rows to session for click handling
      this.rowToSessionIndex.set(nameRow, sessionIdx);
      if (detailRow < this.height) {
        this.rowToSessionIndex.set(detailRow, sessionIdx);
      }

      // Active marker
      if (isActive && !showHighlight) {
        writeString(grid, nameRow, 0, "\u258e", ACTIVE_MARKER_ATTRS);
        if (detailRow < this.height) {
          writeString(grid, detailRow, 0, "\u258e", ACTIVE_MARKER_ATTRS);
        }
      }

      // Highlight background
      if (showHighlight) {
        writeString(grid, nameRow, 0, " ".repeat(this.width), HIGHLIGHT_BG);
        if (detailRow < this.height) {
          writeString(
            grid,
            detailRow,
            0,
            " ".repeat(this.width),
            HIGHLIGHT_BG,
          );
        }
      }

      const rowAttrs: CellAttrs = showHighlight ? { ...HIGHLIGHT_BG } : {};

      // Indicator
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

      // Window count right-aligned
      const windowCountStr = `${session.windowCount}w`;
      const windowCountCol = this.width - windowCountStr.length - 1;

      // Session name
      const nameStart = 3;
      const nameMaxLen = windowCountCol - 1 - nameStart;
      let displayName = session.name;
      if (displayName.length > nameMaxLen) {
        displayName = displayName.slice(0, nameMaxLen - 1) + "\u2026";
      }

      const nameAttrs: CellAttrs = isActive
        ? { ...rowAttrs, ...ACTIVE_NAME_ATTRS }
        : { ...rowAttrs, ...INACTIVE_NAME_ATTRS };
      writeString(grid, nameRow, nameStart, displayName, nameAttrs);

      if (windowCountCol > nameStart) {
        writeString(grid, nameRow, windowCountCol, windowCountStr, {
          ...rowAttrs,
          ...DIM_ATTRS,
        });
      }

      // Detail line
      if (detailRow < this.height) {
        const detailStart = 3;

        if (item.grouped) {
          // Grouped: show only git branch (directory context from group header)
          if (session.gitBranch) {
            const branchCol = this.width - session.gitBranch.length - 1;
            if (branchCol > detailStart) {
              writeString(grid, detailRow, branchCol, session.gitBranch, {
                ...rowAttrs,
                ...DIM_ATTRS,
              });
            }
          }
        } else {
          // Ungrouped: show directory + branch
          let branchCols = 0;
          if (session.gitBranch) {
            const branchCol = this.width - session.gitBranch.length - 1;
            if (branchCol > detailStart + 1) {
              writeString(grid, detailRow, branchCol, session.gitBranch, {
                ...rowAttrs,
                ...DIM_ATTRS,
              });
              branchCols = session.gitBranch.length + 2;
            }
          }
          if (session.directory !== undefined) {
            const dirMaxLen = this.width - detailStart - branchCols - 1;
            let displayDir = session.directory;
            if (displayDir.length > dirMaxLen) {
              displayDir = displayDir.slice(0, dirMaxLen - 1) + "\u2026";
            }
            writeString(grid, detailRow, detailStart, displayDir, {
              ...rowAttrs,
              ...DIM_ATTRS,
            });
          }
        }
      }

      row += 2; // name row + detail row (spacer handled by the spacer item)
    }

    return grid;
  }
}
