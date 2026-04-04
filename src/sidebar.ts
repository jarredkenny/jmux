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

function getGroupLabel(dir: string): string | null {
  const segments = dir.split("/").filter((s) => s.length > 0);
  // For ~/X/Y/... paths, group by X/Y (fixed depth)
  // ~/Code/personal/jmux → "Code/personal"
  // ~/Code/personal      → "Code/personal"
  // ~/Code/tracktile/platform → "Code/tracktile"
  if (segments[0] === "~") {
    if (segments.length < 3) return null; // ~ or ~/Code — too shallow
    return segments[1] + "/" + segments[2];
  }
  // Absolute paths: /X/Y/... → group by X/Y
  if (segments.length < 2) return null;
  return segments[0] + "/" + segments[1];
}

type RenderItem =
  | { type: "group-header"; label: string }
  | { type: "session"; sessionIndex: number; grouped: boolean }
  | { type: "spacer" };

function buildRenderPlan(sessions: SessionInfo[]): {
  items: RenderItem[];
  displayOrder: number[];
} {
  const groupMap = new Map<string, number[]>();
  const ungrouped: number[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const dir = sessions[i].directory;
    if (!dir) {
      ungrouped.push(i);
      continue;
    }
    const label = getGroupLabel(dir);
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

  for (const [label, indices] of groupMap) {
    if (indices.length === 1) {
      ungrouped.push(indices[0]);
      groupMap.delete(label);
    }
  }

  const sortedGroups: SessionGroup[] = [...groupMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, indices]) => ({
      label,
      sessionIndices: indices.sort((a, b) =>
        sessions[a].name.localeCompare(sessions[b].name),
      ),
    }));

  ungrouped.sort((a, b) => sessions[a].name.localeCompare(sessions[b].name));

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
  private displayOrder: number[] = [];
  private rowToSessionIndex = new Map<number, number>();
  private activitySet = new Set<string>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  updateSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    const { displayOrder } = buildRenderPlan(sessions);
    this.displayOrder = displayOrder;
  }

  setActiveSession(id: string): void {
    this.activeSessionId = id;
  }

  setActivity(sessionId: string, active: boolean): void {
    if (active) {
      this.activitySet.add(sessionId);
    } else {
      this.activitySet.delete(sessionId);
    }
  }

  getDisplayOrderIds(): string[] {
    return this.displayOrder
      .map((idx) => this.sessions[idx]?.id)
      .filter(Boolean) as string[];
  }

  getSessionByRow(row: number): SessionInfo | null {
    const sessionIdx = this.rowToSessionIndex.get(row);
    if (sessionIdx === undefined) return null;
    return this.sessions[sessionIdx] ?? null;
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

      const sessionIdx = item.sessionIndex;
      const session = this.sessions[sessionIdx];
      if (!session) continue;

      const nameRow = row;
      const detailRow = row + 1;
      const isActive = session.id === this.activeSessionId;
      const hasActivity = this.activitySet.has(session.id);

      // Map rows to session for click handling
      this.rowToSessionIndex.set(nameRow, sessionIdx);
      if (detailRow < this.height) {
        this.rowToSessionIndex.set(detailRow, sessionIdx);
      }

      // Active marker
      if (isActive) {
        writeString(grid, nameRow, 0, "\u258e", ACTIVE_MARKER_ATTRS);
        if (detailRow < this.height) {
          writeString(grid, detailRow, 0, "\u258e", ACTIVE_MARKER_ATTRS);
        }
      }

      // Indicator
      if (session.attention) {
        writeString(grid, nameRow, 1, "!", ATTENTION_ATTRS);
      } else if (hasActivity) {
        writeString(grid, nameRow, 1, "\u25CF", ACTIVITY_ATTRS);
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
        ? { ...ACTIVE_NAME_ATTRS }
        : { ...INACTIVE_NAME_ATTRS };
      writeString(grid, nameRow, nameStart, displayName, nameAttrs);

      if (windowCountCol > nameStart) {
        writeString(grid, nameRow, windowCountCol, windowCountStr, DIM_ATTRS);
      }

      // Detail line
      if (detailRow < this.height) {
        const detailStart = 3;

        if (item.grouped) {
          if (session.gitBranch) {
            const branchCol = this.width - session.gitBranch.length - 1;
            if (branchCol > detailStart) {
              writeString(grid, detailRow, branchCol, session.gitBranch, DIM_ATTRS);
            }
          }
        } else {
          let branchCols = 0;
          if (session.gitBranch) {
            const branchCol = this.width - session.gitBranch.length - 1;
            if (branchCol > detailStart + 1) {
              writeString(grid, detailRow, branchCol, session.gitBranch, DIM_ATTRS);
              branchCols = session.gitBranch.length + 2;
            }
          }
          if (session.directory !== undefined) {
            const dirMaxLen = this.width - detailStart - branchCols - 1;
            let displayDir = session.directory;
            if (displayDir.length > dirMaxLen) {
              displayDir = displayDir.slice(0, dirMaxLen - 1) + "\u2026";
            }
            writeString(grid, detailRow, detailStart, displayDir, DIM_ATTRS);
          }
        }
      }

      row += 2;
    }

    return grid;
  }
}
