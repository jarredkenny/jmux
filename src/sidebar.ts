import type { SessionOtelState, CellGrid, SessionInfo } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import type { SessionContext } from "./adapters/types";
import { buildSessionView, buildSessionRow3 } from "./session-view";

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
const ERROR_ATTRS: CellAttrs = {
  fg: 1,
  fgMode: ColorMode.Palette,
  bold: true,
};
const MCP_DOWN_ATTRS: CellAttrs = {
  fg: 1,
  fgMode: ColorMode.Palette,
  dim: true,
};
const MODE_PLAN_ATTRS: CellAttrs = {
  fg: 6,
  fgMode: ColorMode.Palette,
};
const MODE_ACCEPT_EDITS_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
};
const MODE_COMPACTION_ATTRS: CellAttrs = { dim: true };
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

// --- Pipeline glyph constants ---
const PIPELINE_GLYPH_MAP: Record<string, string> = {
  passed: "✓", running: "⟳", failed: "✗", pending: "○", canceled: "—",
};
const PIPELINE_GLYPH_COLORS: Record<string, CellAttrs> = {
  passed: { fg: 2, fgMode: ColorMode.Palette },
  running: { fg: 3, fgMode: ColorMode.Palette },
  failed: { fg: 1, fgMode: ColorMode.Palette },
  pending: { fg: 3, fgMode: ColorMode.Palette },
  canceled: { fg: 8, fgMode: ColorMode.Palette, dim: true },
};

// --- Cache timer helpers ---

function cacheTimerAttrs(
  remaining: number,
  isActive: boolean,
  isHovered: boolean,
): CellAttrs {
  const base: CellAttrs = {};
  if (isActive) {
    base.bg = ACTIVE_BG;
    base.bgMode = ColorMode.RGB;
  } else if (isHovered) {
    base.bg = HOVER_BG;
    base.bgMode = ColorMode.RGB;
  }
  if (remaining <= 0) return { ...base, dim: true };
  if (remaining <= 29) return { ...base, fg: 1, fgMode: ColorMode.Palette };
  if (remaining <= 180) return { ...base, fg: 3, fgMode: ColorMode.Palette };
  return { ...base, fg: 2, fgMode: ColorMode.Palette };
}

// --- Grouping logic ---

interface SessionGroup {
  label: string;
  sessionIndices: number[];
}

function getGroupLabel(dir: string): string | null {
  const segments = dir.split("/").filter((s) => s.length > 0);
  // For ~/X/Y/... paths, group by X/Y (fixed depth)
  // ~/X/Y/Z → "X/Y"
  // ~/X/Y   → "X/Y"
  if (segments[0] === "~") {
    if (segments.length < 3) return null; // ~ or ~/Code — too shallow
    return segments[1] + "/" + segments[2];
  }
  // Absolute paths: /X/Y/... → group by X/Y
  if (segments.length < 2) return null;
  return segments[0] + "/" + segments[1];
}

function getSubdirectory(dir: string, groupLabel: string): string | null {
  // dir: "~/X/Y/Z", groupLabel: "X/Y" → "Z"
  // dir: "~/X/Y/Z/sub", groupLabel: "X/Y" → "Z/sub"
  const idx = dir.indexOf(groupLabel);
  if (idx < 0) return null;
  const rest = dir.slice(idx + groupLabel.length);
  // rest is e.g. "/Z" or "/Z/sub/deep"
  const trimmed = rest.replace(/^\/+/, "");
  if (!trimmed) return null;
  // For nested paths, just show the last directory name
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

type RenderItem =
  | { type: "group-header"; label: string; collapsed: boolean; sessionCount: number }
  | { type: "session"; sessionIndex: number; grouped: boolean; groupLabel?: string }
  | { type: "spacer" };

const PINNED_GROUP_LABEL = "Pinned";

function buildRenderPlan(
  sessions: SessionInfo[],
  collapsedGroups: Set<string>,
  pinnedNames: Set<string>,
): {
  items: RenderItem[];
  displayOrder: number[];
} {
  const pinnedIndices: number[] = [];
  const groupMap = new Map<string, number[]>();
  const ungrouped: number[] = [];

  for (let i = 0; i < sessions.length; i++) {
    if (pinnedNames.has(sessions[i].name)) {
      pinnedIndices.push(i);
      continue;
    }
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

  pinnedIndices.sort((a, b) => sessions[a].name.localeCompare(sessions[b].name));

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

  // Pinned group first
  if (pinnedIndices.length > 0) {
    const isCollapsed = collapsedGroups.has(PINNED_GROUP_LABEL);
    items.push({
      type: "group-header",
      label: PINNED_GROUP_LABEL,
      collapsed: isCollapsed,
      sessionCount: pinnedIndices.length,
    });
    items.push({ type: "spacer" });
    if (!isCollapsed) {
      for (const idx of pinnedIndices) {
        items.push({
          type: "session",
          sessionIndex: idx,
          grouped: true,
          groupLabel: PINNED_GROUP_LABEL,
        });
        displayOrder.push(idx);
        items.push({ type: "spacer" });
      }
    }
  }

  for (const group of sortedGroups) {
    const isCollapsed = collapsedGroups.has(group.label);
    items.push({
      type: "group-header",
      label: group.label,
      collapsed: isCollapsed,
      sessionCount: group.sessionIndices.length,
    });
    items.push({ type: "spacer" });
    if (!isCollapsed) {
      for (const idx of group.sessionIndices) {
        items.push({
          type: "session",
          sessionIndex: idx,
          grouped: true,
          groupLabel: group.label,
        });
        displayOrder.push(idx);
        items.push({ type: "spacer" });
      }
    }
  }

  for (const idx of ungrouped) {
    items.push({
      type: "session",
      sessionIndex: idx,
      grouped: false,
    });
    displayOrder.push(idx);
    items.push({ type: "spacer" });
  }

  return { items, displayOrder };
}

function itemHeight(item: RenderItem): number {
  if (item.type === "session") return 3;
  return 1; // group-header or spacer
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
  private rowToGroupLabel = new Map<number, string>();
  private activitySet = new Set<string>();
  private scrollOffset = 0;
  private hoveredRow: number | null = null;
  private collapsedGroups = new Set<string>();
  private pinnedSessions = new Set<string>();
  private currentVersion: string = "";
  private latestVersion: string | null = null;
  private otelStates = new Map<string, SessionOtelState>();
  cacheTimersEnabled: boolean = true;
  private sessionContexts = new Map<string, SessionContext>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  updateSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    // Prune otelStates for sessions that no longer exist
    const activeIds = new Set(sessions.map((s) => s.id));
    for (const id of this.otelStates.keys()) {
      if (!activeIds.has(id)) this.otelStates.delete(id);
    }
    this.rebuildPlan();
  }

  setActiveSession(id: string): void {
    if (this.activeSessionId === id) return;
    this.activeSessionId = id;
  }

  toggleGroup(label: string): void {
    if (this.collapsedGroups.has(label)) {
      this.collapsedGroups.delete(label);
    } else {
      this.collapsedGroups.add(label);
    }
    this.rebuildPlan();
  }

  setPinnedSessions(names: Set<string>): void {
    this.pinnedSessions = new Set(names);
    this.rebuildPlan();
  }

  private rebuildPlan(): void {
    const { items, displayOrder } = buildRenderPlan(
      this.sessions,
      this.collapsedGroups,
      this.pinnedSessions,
    );
    this.items = items;
    this.displayOrder = displayOrder;
    this.clampScroll();
  }

  isPinned(sessionName: string): boolean {
    return this.pinnedSessions.has(sessionName);
  }

  setActivity(sessionId: string, active: boolean): void {
    if (active) {
      this.activitySet.add(sessionId);
    } else {
      this.activitySet.delete(sessionId);
    }
  }

  setSessionOtelState(sessionId: string, state: SessionOtelState | null): void {
    if (state === null) {
      this.otelStates.delete(sessionId);
    } else {
      this.otelStates.set(sessionId, state);
    }
  }

  /** Test-only: number of otelStates entries currently held. */
  _otelStateCount(): number {
    return this.otelStates.size;
  }

  setSessionContexts(contexts: Map<string, SessionContext>): void {
    this.sessionContexts = contexts;
    this.clampScroll();
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

  getGroupByRow(row: number): string | null {
    return this.rowToGroupLabel.get(row) ?? null;
  }

  getGroups(): { label: string; collapsed: boolean }[] {
    const groups: { label: string; collapsed: boolean }[] = [];
    const seen = new Set<string>();
    for (const item of this.items) {
      if (item.type === "group-header" && !seen.has(item.label)) {
        seen.add(item.label);
        groups.push({ label: item.label, collapsed: item.collapsed });
      }
    }
    return groups;
  }

  setHoveredRow(row: number | null): void {
    if (this.hoveredRow === row) return;
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
    this.rowToGroupLabel.clear();

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
        const isHovered = this.hoveredRow === screenRow;
        if (isHovered) {
          const bgFill = " ".repeat(this.width);
          writeString(grid, screenRow, 0, bgFill, { bg: HOVER_BG, bgMode: ColorMode.RGB });
        }
        const headerAttrs: CellAttrs = isHovered
          ? { ...GROUP_HEADER_ATTRS, bg: HOVER_BG, bgMode: ColorMode.RGB }
          : GROUP_HEADER_ATTRS;
        const countAttrs: CellAttrs = isHovered
          ? { ...DIM_ATTRS, bg: HOVER_BG, bgMode: ColorMode.RGB }
          : DIM_ATTRS;
        const chevron = item.collapsed ? "\u25b8" : "\u25be"; // ▸ or ▾
        writeString(grid, screenRow, 1, chevron, headerAttrs);
        const labelStart = 3;
        let label = item.label;
        const countSuffix = item.collapsed ? ` (${item.sessionCount})` : "";
        const maxLabelLen = this.width - labelStart - countSuffix.length - 1;
        if (label.length > maxLabelLen) {
          label = label.slice(0, maxLabelLen - 1) + "\u2026";
        }
        writeString(grid, screenRow, labelStart, label, headerAttrs);
        if (countSuffix) {
          writeString(grid, screenRow, labelStart + label.length, countSuffix, countAttrs);
        }
        this.rowToGroupLabel.set(screenRow, item.label);
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

  private paintRowChrome(
    grid: CellGrid,
    row: number,
    isActive: boolean,
    isHovered: boolean,
  ): void {
    if (row >= this.height) return;
    if (isActive || isHovered) {
      const bg = isActive ? ACTIVE_BG : HOVER_BG;
      writeString(grid, row, 0, " ".repeat(this.width), { bg, bgMode: ColorMode.RGB });
    }
    if (isActive) {
      writeString(grid, row, 0, "▎", ACTIVE_MARKER_ATTRS);
    }
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
    const row3 = nameRow + 2;
    const isActive = session.id === this.activeSessionId;
    const isHovered = !isActive && this.hoveredRow !== null &&
      (this.hoveredRow === nameRow || this.hoveredRow === detailRow || this.hoveredRow === row3);

    // Build the view
    const ctx = this.sessionContexts.get(session.name);
    const timerState = this.cacheTimersEnabled ? this.otelStates.get(session.id) ?? undefined : undefined;
    const view = buildSessionView(session, ctx, timerState, this.activitySet);

    // Map rows to session for click handling
    this.rowToSessionIndex.set(nameRow, sessionIdx);
    if (detailRow < this.height) {
      this.rowToSessionIndex.set(detailRow, sessionIdx);
    }

    // Paint background + active marker bar across name + detail rows
    this.paintRowChrome(grid, nameRow, isActive, isHovered);
    this.paintRowChrome(grid, detailRow, isActive, isHovered);

    // Indicator (col 1)
    switch (view.indicatorKind) {
      case "error":
        writeString(grid, nameRow, 1, "\u2A2F", ERROR_ATTRS);
        break;
      case "mcp-down":
        writeString(grid, nameRow, 1, "\u2298", MCP_DOWN_ATTRS);
        break;
      case "attention":
        writeString(grid, nameRow, 1, "!", ATTENTION_ATTRS);
        break;
      case "activity":
        writeString(grid, nameRow, 1, "\u25CF", ACTIVITY_ATTRS);
        break;
    }

    const bgAttrs: CellAttrs = isActive
      ? { bg: ACTIVE_BG, bgMode: ColorMode.RGB }
      : isHovered
        ? { bg: HOVER_BG, bgMode: ColorMode.RGB }
        : {};

    // --- Row 1: session name (left) + mode badge + linear ID (right) ---
    const nameStart = 3;
    const linearIdStr = view.linearId ?? "";
    const linearIdCol = linearIdStr ? this.width - linearIdStr.length - 1 : this.width;
    const hasBadge = view.modeBadge !== null;
    const badgeCol = hasBadge
      ? (linearIdStr ? linearIdCol - 2 : this.width - 2)
      : -1;
    const reserveRight = (linearIdStr ? linearIdCol - 1 : this.width - 1)
      - (hasBadge ? 2 : 0);
    const nameMaxLen = reserveRight - nameStart;
    let displayName = view.sessionName;
    if (displayName.length > nameMaxLen) {
      displayName = displayName.slice(0, Math.max(0, nameMaxLen - 1)) + "\u2026";
    }

    const nameAttrs: CellAttrs = isActive
      ? { ...ACTIVE_NAME_ATTRS }
      : isHovered
        ? { ...HOVER_NAME_ATTRS }
        : { ...INACTIVE_NAME_ATTRS };
    writeString(grid, nameRow, nameStart, displayName, nameAttrs);

    if (hasBadge && badgeCol >= 0) {
      let glyph: string;
      let badgeAttrs: CellAttrs;
      if (view.modeBadge === "P") {
        glyph = "P";
        badgeAttrs = MODE_PLAN_ATTRS;
      } else if (view.modeBadge === "A") {
        glyph = "A";
        badgeAttrs = MODE_ACCEPT_EDITS_ATTRS;
      } else {
        glyph = "⊕";
        badgeAttrs = MODE_COMPACTION_ATTRS;
      }
      writeString(grid, nameRow, badgeCol, glyph, { ...badgeAttrs, ...bgAttrs });
    }

    if (linearIdStr) {
      const linkAttrs: CellAttrs = { ...DIM_ATTRS, ...bgAttrs };
      writeString(grid, nameRow, linearIdCol, linearIdStr, linkAttrs);
    }

    // --- Row 2: branch (left) + timer (center-right) + MR ID + pipeline glyph (right) ---
    if (detailRow >= this.height) return;

    const detailAttrs: CellAttrs = isActive
      ? ACTIVE_DETAIL_ATTRS
      : isHovered
        ? HOVER_DETAIL_ATTRS
        : DIM_ATTRS;

    // Compute right-side content and its column positions (right to left)
    let rightEdge = this.width - 1; // rightmost column available

    // Pipeline glyph (rightmost)
    let glyphStr: string | null = null;
    let glyphAttrs: CellAttrs | null = null;
    if (view.pipelineState) {
      glyphStr = PIPELINE_GLYPH_MAP[view.pipelineState] ?? null;
      glyphAttrs = PIPELINE_GLYPH_COLORS[view.pipelineState] ?? null;
    }
    if (glyphStr && glyphAttrs) {
      writeString(grid, detailRow, rightEdge, glyphStr, { ...glyphAttrs, ...bgAttrs });
      rightEdge -= 2; // glyph + 1 space before it
    }

    // MR ID (before glyph)
    if (view.mrId) {
      const mrCol = rightEdge - view.mrId.length + 1;
      if (mrCol > nameStart) {
        writeString(grid, detailRow, mrCol, view.mrId, { ...DIM_ATTRS, ...bgAttrs });
        rightEdge = mrCol - 2; // 1 space gap before MR ID
      }
    }

    // Timer (before MR ID)
    if (view.timerText) {
      const timerAttrs = cacheTimerAttrs(view.timerRemaining, isActive, isHovered);
      const timerCol = rightEdge - view.timerText.length + 1;
      if (timerCol > nameStart) {
        writeString(grid, detailRow, timerCol, view.timerText, timerAttrs);
        rightEdge = timerCol - 2;
      }
    }

    // Branch (left, truncates to fit)
    if (view.branch) {
      const detailStart = 3;
      const maxLen = rightEdge - detailStart + 1;
      if (maxLen > 0) {
        let branch = view.branch;
        if (branch.length > maxLen) {
          branch = branch.slice(0, Math.max(0, maxLen - 1)) + "\u2026";
        }
        writeString(grid, detailRow, detailStart, branch, detailAttrs);
      }
    }

    // Row 3: cost / tool / idle from the OTEL state.
    if (row3 < this.height) {
      this.paintRowChrome(grid, row3, isActive, isHovered);
      this.rowToSessionIndex.set(row3, sessionIdx);

      const otel = this.otelStates.get(session.id);
      if (otel) {
        // Pass the budget that buildSessionRow3 will treat as its full usable
        // width. We start writing at col 3, so usable budget = this.width - 3.
        const text = buildSessionRow3(otel, this.width - 3);
        if (text.length > 0) {
          const row3Attrs: CellAttrs = isActive
            ? ACTIVE_DETAIL_ATTRS
            : isHovered
              ? HOVER_DETAIL_ATTRS
              : DIM_ATTRS;
          writeString(grid, row3, 3, text, row3Attrs);
        }
      }
    }
  }
}
