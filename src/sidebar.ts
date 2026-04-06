import type { CellGrid, SessionInfo } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

const HEADER_ROWS = 2; // "jmux" header + separator

const DIM_ATTRS: CellAttrs = { dim: true };
const ACCENT_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
};
// #1e2a35 as packed RGB for subtle active row background
const ACTIVE_BG = (0x1e << 16) | (0x2a << 8) | 0x35;
const ACTIVE_MARKER_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: ACTIVE_BG,
  bgMode: ColorMode.RGB,
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
  fg: 2,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: ACTIVE_BG,
  bgMode: ColorMode.RGB,
};
const ACTIVE_DETAIL_ATTRS: CellAttrs = {
  dim: true,
  bg: ACTIVE_BG,
  bgMode: ColorMode.RGB,
};
const INACTIVE_NAME_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
};
// Subtle hover background — slightly lighter than the default terminal bg
const HOVER_BG = (0x1a << 16) | (0x1f << 8) | 0x26;
const HOVER_NAME_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bg: HOVER_BG,
  bgMode: ColorMode.RGB,
};
const HOVER_DETAIL_ATTRS: CellAttrs = {
  dim: true,
  bg: HOVER_BG,
  bgMode: ColorMode.RGB,
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

function getSubdirectory(dir: string, groupLabel: string): string | null {
  // dir: "~/Code/personal/jmux", groupLabel: "Code/personal" → "jmux"
  // dir: "~/Code/personal/jmux/sub", groupLabel: "Code/personal" → "jmux/sub"
  const idx = dir.indexOf(groupLabel);
  if (idx < 0) return null;
  const rest = dir.slice(idx + groupLabel.length);
  // rest is e.g. "/jmux" or "/jmux/sub/deep"
  const trimmed = rest.replace(/^\/+/, "");
  if (!trimmed) return null;
  // For nested paths, just show the last directory name
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

type RenderItem =
  | { type: "group-header"; label: string }
  | { type: "session"; sessionIndex: number; grouped: boolean; groupLabel?: string }
  | { type: "spacer" };

function buildRenderPlan(sessions: SessionInfo[]): {
  items: RenderItem[];
  displayOrder: number[];
} {
  const groupMap = new Map<string, number[]>();
  const ungrouped: number[] = [];

  for (let i = 0; i < sessions.length; i++) {
    // Prefer project name (wtm) over directory-based grouping
    const label = sessions[i].project ?? (() => {
      const dir = sessions[i].directory;
      return dir ? getGroupLabel(dir) : null;
    })();
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
    items.push({ type: "spacer" });
    for (const idx of group.sessionIndices) {
      items.push({ type: "session", sessionIndex: idx, grouped: true, groupLabel: group.label });
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

function itemHeight(item: RenderItem): number {
  return item.type === "session" ? 2 : 1;
}

// --- Sidebar class ---

const UPDATE_AVAILABLE_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
};

export class Sidebar {
  private width: number;
  private height: number;
  private sessions: SessionInfo[] = [];
  private activeSessionId: string | null = null;
  private items: RenderItem[] = [];
  private displayOrder: number[] = [];
  private rowToSessionIndex = new Map<number, number>();
  private activitySet = new Set<string>();
  private scrollOffset = 0;
  private hoveredRow: number | null = null;
  private currentVersion: string = "";
  private latestVersion: string | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  updateSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    const { items, displayOrder } = buildRenderPlan(sessions);
    this.items = items;
    this.displayOrder = displayOrder;
    this.clampScroll();
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

  hasActivity(sessionId: string): boolean {
    return this.activitySet.has(sessionId);
  }

  hasAttention(sessionId: string): boolean {
    const session = this.sessions.find((s) => s.id === sessionId);
    return session?.attention === true;
  }

  getDisplayOrderIds(): string[] {
    return this.displayOrder
      .map((idx) => this.sessions[idx]?.id)
      .filter(Boolean) as string[];
  }

  setVersion(current: string, latest?: string): void {
    this.currentVersion = current;
    this.latestVersion = latest ?? null;
  }

  hasUpdate(): boolean {
    return this.latestVersion !== null && this.latestVersion !== this.currentVersion;
  }

  isVersionRow(row: number): boolean {
    return this.currentVersion !== "" && row === this.height - 1;
  }

  getSessionByRow(row: number): SessionInfo | null {
    const sessionIdx = this.rowToSessionIndex.get(row);
    if (sessionIdx === undefined) return null;
    return this.sessions[sessionIdx] ?? null;
  }

  setHoveredRow(row: number | null): void {
    this.hoveredRow = row;
  }

  getHoveredRow(): number | null {
    return this.hoveredRow;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.clampScroll();
  }

  scrollBy(delta: number): void {
    this.scrollOffset += delta;
    this.clampScroll();
  }

  scrollToActive(): void {
    if (!this.activeSessionId) return;
    const viewportHeight = this.viewportHeight();
    let vRow = 0;
    for (const item of this.items) {
      const h = itemHeight(item);
      if (item.type === "session") {
        const session = this.sessions[item.sessionIndex];
        if (session?.id === this.activeSessionId) {
          if (vRow < this.scrollOffset) {
            this.scrollOffset = vRow;
          } else if (vRow + h > this.scrollOffset + viewportHeight) {
            this.scrollOffset = vRow + h - viewportHeight;
          }
          this.clampScroll();
          return;
        }
      }
      vRow += h;
    }
  }

  private footerRows(): number {
    return this.currentVersion ? 1 : 0;
  }

  private viewportHeight(): number {
    return this.height - HEADER_ROWS - this.footerRows();
  }

  private clampScroll(): void {
    const totalRows = this.items.reduce((sum, item) => sum + itemHeight(item), 0);
    const maxOffset = Math.max(0, totalRows - this.viewportHeight());
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));
  }

  getGrid(): CellGrid {
    const grid = createGrid(this.width, this.height);
    this.rowToSessionIndex.clear();

    // Header
    writeString(grid, 0, 1, "jmux", { ...ACCENT_ATTRS, bold: true });
    writeString(grid, 1, 0, "\u2500".repeat(this.width), DIM_ATTRS);

    const vpHeight = this.viewportHeight();
    const contentBottom = HEADER_ROWS + vpHeight;
    let vRow = 0;
    let totalRows = 0;

    for (const item of this.items) {
      const h = itemHeight(item);
      const screenRow = HEADER_ROWS + vRow - this.scrollOffset;

      // Skip items entirely above viewport
      if (screenRow + h <= HEADER_ROWS) {
        vRow += h;
        totalRows += h;
        continue;
      }
      // Track total rows even after viewport
      if (screenRow >= contentBottom) {
        vRow += h;
        totalRows += h;
        continue;
      }

      if (item.type === "group-header") {
        let label = item.label;
        if (label.length > this.width - 2) {
          label = label.slice(0, this.width - 3) + "\u2026";
        }
        writeString(grid, screenRow, 1, label, GROUP_HEADER_ATTRS);
      } else if (item.type === "spacer") {
        // nothing to render
      } else {
        this.renderSession(grid, screenRow, item);
      }

      vRow += h;
      totalRows += h;
    }

    // Scroll indicators
    if (this.scrollOffset > 0) {
      writeString(grid, HEADER_ROWS, this.width - 1, "\u25b2", DIM_ATTRS);
    }
    if (this.scrollOffset + vpHeight < totalRows) {
      const scrollRow = this.footerRows() ? contentBottom - 1 : this.height - 1;
      writeString(grid, scrollRow, this.width - 1, "\u25bc", DIM_ATTRS);
    }

    // Version footer
    if (this.currentVersion) {
      const footerRow = this.height - 1;
      const versionText = `v${this.currentVersion}`;
      if (this.hasUpdate()) {
        const updateText = `v${this.latestVersion} avail`;
        const maxLen = this.width - 2;
        const display = updateText.length <= maxLen ? updateText : `v${this.latestVersion}`;
        writeString(grid, footerRow, 1, display, UPDATE_AVAILABLE_ATTRS);
      } else {
        writeString(grid, footerRow, 1, versionText, DIM_ATTRS);
      }
    }

    return grid;
  }

  private renderSession(
    grid: CellGrid,
    nameRow: number,
    item: Extract<RenderItem, { type: "session" }>,
  ): void {
    const sessionIdx = item.sessionIndex;
    const session = this.sessions[sessionIdx];
    if (!session) return;

    const detailRow = nameRow + 1;
    const isActive = session.id === this.activeSessionId;
    const isHovered = !isActive && this.hoveredRow !== null &&
      (this.hoveredRow === nameRow || this.hoveredRow === detailRow);
    const hasActivity = this.activitySet.has(session.id);

    // Map rows to session for click handling
    this.rowToSessionIndex.set(nameRow, sessionIdx);
    if (detailRow < this.height) {
      this.rowToSessionIndex.set(detailRow, sessionIdx);
    }

    // Paint background across both rows
    if (isActive || isHovered) {
      const bg = isActive ? ACTIVE_BG : HOVER_BG;
      const bgFill = " ".repeat(this.width);
      const bgAttrs: CellAttrs = { bg, bgMode: ColorMode.RGB };
      writeString(grid, nameRow, 0, bgFill, bgAttrs);
      writeString(grid, detailRow, 0, bgFill, bgAttrs);
    }

    // Active marker
    if (isActive) {
      writeString(grid, nameRow, 0, "\u258e", ACTIVE_MARKER_ATTRS);
      writeString(grid, detailRow, 0, "\u258e", ACTIVE_MARKER_ATTRS);
    }

    // Indicator
    if (session.attention) {
      writeString(grid, nameRow, 1, "!", ATTENTION_ATTRS);
    } else if (hasActivity) {
      writeString(grid, nameRow, 1, "\u25CF", ACTIVITY_ATTRS);
    }

    // Name row: name + window count
    const windowCountStr = `${session.windowCount}w`;
    const windowCountCol = this.width - windowCountStr.length - 1;
    const nameStart = 3;
    const nameMaxLen = windowCountCol - 1 - nameStart;
    let displayName = session.name;
    if (displayName.length > nameMaxLen) {
      displayName = displayName.slice(0, nameMaxLen - 1) + "\u2026";
    }

    const nameAttrs: CellAttrs = isActive
      ? { ...ACTIVE_NAME_ATTRS }
      : isHovered
        ? { ...HOVER_NAME_ATTRS }
        : { ...INACTIVE_NAME_ATTRS };
    writeString(grid, nameRow, nameStart, displayName, nameAttrs);

    const wcAttrs: CellAttrs = isActive
      ? { ...DIM_ATTRS, bg: ACTIVE_BG, bgMode: ColorMode.RGB }
      : isHovered
        ? { ...DIM_ATTRS, bg: HOVER_BG, bgMode: ColorMode.RGB }
        : DIM_ATTRS;
    if (windowCountCol > nameStart) {
      writeString(grid, nameRow, windowCountCol, windowCountStr, wcAttrs);
    }

    // Detail line
    const detailAttrs: CellAttrs = isActive
      ? ACTIVE_DETAIL_ATTRS
      : isHovered
        ? HOVER_DETAIL_ATTRS
        : DIM_ATTRS;
    if (item.grouped) {
      if (session.gitBranch) {
        const detailStart = 3;
        const maxLen = this.width - detailStart - 1;
        let branch = session.gitBranch;
        if (branch.length > maxLen) {
          branch = branch.slice(0, maxLen - 1) + "\u2026";
        }
        writeString(grid, detailRow, detailStart, branch, detailAttrs);
      }
    } else {
      const detailStart = 3;
      let branchCols = 0;
      if (session.gitBranch) {
        const branchCol = this.width - session.gitBranch.length - 1;
        if (branchCol > detailStart + 1) {
          writeString(grid, detailRow, branchCol, session.gitBranch, detailAttrs);
          branchCols = session.gitBranch.length + 2;
        }
      }
      if (session.directory !== undefined) {
        const dirMaxLen = this.width - detailStart - branchCols - 1;
        let displayDir = session.directory;
        if (displayDir.length > dirMaxLen) {
          displayDir = displayDir.slice(0, dirMaxLen - 1) + "\u2026";
        }
        writeString(grid, detailRow, detailStart, displayDir, detailAttrs);
      }
    }
  }
}
