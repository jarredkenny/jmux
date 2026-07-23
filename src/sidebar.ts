import type { SessionOtelState, CellGrid, SessionInfo, AgentState, AgentStateRecord } from "./types";
import { ColorMode, makeSessionOtelState } from "./types";
import { createGrid, writeString, textCols, truncateToCols, type CellAttrs } from "./cell-grid";
import type { SessionContext } from "./adapters/types";
import { buildSessionView, buildSessionRow3 } from "./session-view";
import { theme } from "./theme";
import { tokens, frame } from "./chrome-tokens";
import { stateAttrs, type StateColor } from "./state-colors";
import {
  matchesFilter,
  sortIndices,
  cycleSort,
  cycleFilter,
  sortModeShort,
  filterModeShort,
  type SortMode,
  type FilterMode,
  type SessionStatus,
  type SessionSortInfo,
} from "./sidebar-sort";

export interface PinnedPaneEntry {
  paneId: string;
  label: string;
  homeSessionName: string;
  /** Agent state of this pane's session, for the Command Center breakdown. */
  agentState?: AgentState | null;
}

export type SidebarSelection =
  | { type: "overview" }
  | { type: "session"; id: string }
  | { type: "pinnedPane"; paneId: string };

const HEADER_ROWS = 2; // "Sessions" header + separator

const DIM_ATTRS: CellAttrs = { dim: true };
const ACCENT_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
};
// Active/hover row highlight backgrounds. These sit on top of the terminal's
// own background, so they track the detected theme (selection/hover tints).
// Under DEFAULT_THEME they equal the original #1e2a35 / #1a1f26 values, so
// terminals that don't answer the OSC 11 query are visually unchanged. Both are
// reassigned by rebuildSidebarColors() once a background is detected.
let ACTIVE_BG = theme.selected;
// The selection rail is the single jmux accent (focus), not a state colour —
// it must read distinctly from a running agent's green dot next to it.
const ACTIVE_MARKER_ATTRS: CellAttrs = {
  fg: tokens.accent.fg,
  fgMode: tokens.accent.fgMode,
  bold: true,
  bg: ACTIVE_BG,
  bgMode: ColorMode.RGB,
};
// "activity" means tmux saw output with no agent-state opinion — it is
// explicitly NOT an agent state, so it takes the neutral/receded tertiary
// tone rather than the running state's green.
const ACTIVITY_ATTRS: CellAttrs = {
  fg: tokens.textTertiary.fg,
  fgMode: tokens.textTertiary.fgMode,
  dim: tokens.textTertiary.dim,
};
// Style emphasis per state is fixed and meaningful (waiting bold = needs you,
// complete dim = receded); only the hue is user-configurable.
const STATE_MODIFIERS: Record<AgentState, { bold?: boolean; dim?: boolean }> = {
  running: {},
  waiting: { bold: true },
  complete: { dim: true },
};
// Bootstrap default, used only until the app calls setStateColors() with the
// configured/resolved colors (main.ts does this immediately after
// construction). Expressed as StateColor so it flows through the same
// stateAttrs() resolver as every other state color.
const DEFAULT_STATE_PALETTE: Record<AgentState, StateColor> = {
  running: { kind: "palette", index: 2 },  // green
  waiting: { kind: "palette", index: 3 },  // yellow
  complete: { kind: "palette", index: 4 }, // blue
};
const STATE_LABEL_TEXT: Record<AgentState, string> = {
  running: "RUNNING",
  waiting: "WAITING",
  complete: "COMPLETE",
};
function buildStateAttrs(colors: Record<AgentState, StateColor>): Record<AgentState, CellAttrs> {
  const make = (state: AgentState): CellAttrs => stateAttrs(colors[state], STATE_MODIFIERS[state]);
  return { running: make("running"), waiting: make("waiting"), complete: make("complete") };
}
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
// The selected row's name is white-bold (textPrimary), not green — green is
// reserved for the running state; a selected running session was previously
// green-on-green with its own indicator dot.
const ACTIVE_NAME_ATTRS: CellAttrs = {
  fg: tokens.textPrimary.fg,
  fgMode: tokens.textPrimary.fgMode,
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
// Subtle hover background — a gentle lift off the terminal background.
let HOVER_BG = theme.hover;
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

/**
 * Re-sync the sidebar's highlight backgrounds from the current theme. Called
 * after a terminal background is detected. The bare consts (ACTIVE_BG/HOVER_BG)
 * are read at render time, but the cached HOVER_* attr objects must be patched
 * in place since they captured HOVER_BG at module load.
 */
export function rebuildSidebarColors(): void {
  ACTIVE_BG = theme.selected;
  HOVER_BG = theme.hover;
  HOVER_NAME_ATTRS.bg = HOVER_BG;
  HOVER_DETAIL_ATTRS.bg = HOVER_BG;
  // The active-row attr objects captured ACTIVE_BG at module load too, so they
  // must be patched in place — otherwise the selected row's marker and text keep
  // the stale dark selection background on a re-themed (e.g. light) terminal.
  ACTIVE_MARKER_ATTRS.bg = ACTIVE_BG;
  ACTIVE_NAME_ATTRS.bg = ACTIVE_BG;
  ACTIVE_DETAIL_ATTRS.bg = ACTIVE_BG;

  // Token-derived colours are likewise captured by value at module load, so
  // they must be re-patched from tokens.* here to track a re-theme (e.g. a
  // light-mode re-detection). tokens.* itself must already be fresh — i.e.
  // rebuildChromeTokens() must run before this — otherwise these read stale
  // values; see the caller in main.ts's OSC 11 re-detection handler.
  ACTIVE_MARKER_ATTRS.fg = tokens.accent.fg;
  ACTIVE_MARKER_ATTRS.fgMode = tokens.accent.fgMode;

  ACTIVE_NAME_ATTRS.fg = tokens.textPrimary.fg;
  ACTIVE_NAME_ATTRS.fgMode = tokens.textPrimary.fgMode;

  ACTIVITY_ATTRS.fg = tokens.textTertiary.fg;
  ACTIVITY_ATTRS.fgMode = tokens.textTertiary.fgMode;
  ACTIVITY_ATTRS.dim = tokens.textTertiary.dim;

  GROUP_HEADER_ATTRS.fg = tokens.textSecondary.fg;
  GROUP_HEADER_ATTRS.fgMode = tokens.textSecondary.fgMode;

  GROUP_HAIRLINE_ATTRS.fg = tokens.ruleHairline.fg;
  GROUP_HAIRLINE_ATTRS.fgMode = tokens.ruleHairline.fgMode;
  GROUP_HAIRLINE_ATTRS.dim = tokens.ruleHairline.dim;

  VERSION_ATTRS.fg = tokens.textTertiary.fg;
  VERSION_ATTRS.fgMode = tokens.textTertiary.fgMode;
  VERSION_ATTRS.dim = tokens.textTertiary.dim;

  UPDATE_AVAILABLE_ATTRS.fg = tokens.attention.fg;
  UPDATE_AVAILABLE_ATTRS.fgMode = tokens.attention.fgMode;
}
// Group-header label tone — textSecondary, not the old bold palette-8. (The
// Command Center header, which shares this const, re-adds bold explicitly at
// its own render site.)
const GROUP_HEADER_ATTRS: CellAttrs = {
  fg: tokens.textSecondary.fg,
  fgMode: tokens.textSecondary.fgMode,
};
// The hairline fill tone that trails a group-header label out to the
// sidebar's inner edge, replacing the old disclosure-triangle form.
const GROUP_HAIRLINE_ATTRS: CellAttrs = {
  fg: tokens.ruleHairline.fg,
  fgMode: tokens.ruleHairline.fgMode,
  dim: tokens.ruleHairline.dim,
};

// Singleton empty OTEL state for promoted sessions that have no OTEL data
// yet. Reused per render frame to avoid allocating a fresh blank object.
// Frozen so accidental mutation is a runtime error rather than a silent bug.
// Note: Object.freeze only freezes direct properties; the failedMcpServers
// Set is readable but never mutated by buildSessionRow3, so shallow freeze suffices.
const EMPTY_OTEL_STATE: SessionOtelState = Object.freeze(makeSessionOtelState()) as SessionOtelState;

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
  | { type: "session"; sessionIndex: number; grouped: boolean; groupLabel?: string; pinnedCount?: number }
  | { type: "spacer" }
  | { type: "overview"; paneCount: number };

const PINNED_GROUP_LABEL = "Pinned";

function buildRenderPlan(
  sessions: SessionInfo[],
  collapsedGroups: Set<string>,
  pinnedNames: Set<string>,
  pinnedPanes: PinnedPaneEntry[],
  sortInfos: SessionSortInfo[],
  sortMode: SortMode,
  filterMode: FilterMode,
): {
  items: RenderItem[];
  displayOrder: number[];
} {
  const pinnedIndices: number[] = [];
  const groupMap = new Map<string, number[]>();
  const ungrouped: number[] = [];

  // Build a map of homeSessionName → count for pinned panes
  const pinnedPaneCountBySession = new Map<string, number>();
  for (const pane of pinnedPanes) {
    pinnedPaneCountBySession.set(
      pane.homeSessionName,
      (pinnedPaneCountBySession.get(pane.homeSessionName) ?? 0) + 1,
    );
  }

  for (let i = 0; i < sessions.length; i++) {
    // Filter first — a filtered-out session never buckets, so empty groups and
    // the Pinned group simply don't emit.
    if (!matchesFilter(sortInfos[i]!.status, filterMode)) continue;

    // In a flat sort mode, pins do not float (a pinned running session must not
    // sit above a waiting one), so the Pinned group is skipped and pinned
    // sessions fall through to the flat list like any other.
    if (sortMode === "project" && pinnedNames.has(sessions[i].name)) {
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

  // Command Center block first — always present (header + counts only).
  items.push({ type: "overview", paneCount: pinnedPanes.length });
  items.push({ type: "spacer" });

  // Flat sort modes (status / activity / name) dissolve project grouping: one
  // ordered list of every (filtered) session, no group headers, no Pinned
  // group — so a waiting agent rises to the very top regardless of project.
  if (sortMode !== "project") {
    const all = [...pinnedIndices, ...[...groupMap.values()].flat(), ...ungrouped];
    const ordered = sortIndices(all, (i) => sortInfos[i]!, sortMode);
    for (const idx of ordered) {
      items.push({
        type: "session",
        sessionIndex: idx,
        grouped: false,
        pinnedCount: pinnedPaneCountBySession.get(sessions[idx].name),
      });
      displayOrder.push(idx);
      items.push({ type: "spacer" });
    }
    return { items, displayOrder };
  }

  // Pinned sessions group
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
        const pc = pinnedPaneCountBySession.get(sessions[idx].name);
        items.push({
          type: "session",
          sessionIndex: idx,
          grouped: true,
          groupLabel: PINNED_GROUP_LABEL,
          pinnedCount: pc,
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
        const pc = pinnedPaneCountBySession.get(sessions[idx].name);
        items.push({
          type: "session",
          sessionIndex: idx,
          grouped: true,
          groupLabel: group.label,
          pinnedCount: pc,
        });
        displayOrder.push(idx);
        items.push({ type: "spacer" });
      }
    }
  }

  for (const idx of ungrouped) {
    const pc = pinnedPaneCountBySession.get(sessions[idx].name);
    items.push({
      type: "session",
      sessionIndex: idx,
      grouped: false,
      pinnedCount: pc,
    });
    displayOrder.push(idx);
    items.push({ type: "spacer" });
  }

  return { items, displayOrder };
}

/**
 * Rows a render item occupies.
 *
 * A session's third row carries its context figure and agent-state label, which
 * only exist once the session is promoted (it has an agent state). Before that
 * the row is blank, which is what made a list of un-promoted sessions look
 * ragged — so a non-promoted session collapses to two rows. `hasStateRow` is
 * supplied by the caller because promotion lives on the Sidebar instance, not
 * on the plan item.
 */
function itemHeight(item: RenderItem, hasStateRow: (sessionIndex: number) => boolean): number {
  if (item.type === "session") return hasStateRow(item.sessionIndex) ? 3 : 2;
  // Command Center: header row + an agent-state breakdown row when panes exist.
  if (item.type === "overview") return item.paneCount > 0 ? 2 : 1;
  return 1; // group-header or spacer
}

// --- Sidebar class ---

// Version indicator on the sidebar's last row. The plain version reads as
// receded chrome (tertiary); an available update is an urgency cue, so it
// gets the attention (yellow) token instead.
const VERSION_ATTRS: CellAttrs = {
  fg: tokens.textTertiary.fg,
  fgMode: tokens.textTertiary.fgMode,
  dim: tokens.textTertiary.dim,
};
const UPDATE_AVAILABLE_ATTRS: CellAttrs = {
  fg: tokens.attention.fg,
  fgMode: tokens.attention.fgMode,
};

export class Sidebar {
  private width: number;
  private height: number;
  private sessions: SessionInfo[] = [];
  private activeSessionId: string | null = null;
  private overviewActive = false;
  private items: RenderItem[] = [];
  private displayOrder: number[] = [];
  private rowToSessionIndex = new Map<number, number>();
  private rowToGroupLabel = new Map<number, string>();
  private activitySet = new Set<string>();
  private scrollOffset = 0;
  private hoveredRow: number | null = null;
  private collapsedGroups = new Set<string>();
  private pinnedSessions = new Set<string>();
  private pinnedPanes: PinnedPaneEntry[] = [];
  private rowToSelection = new Map<number, SidebarSelection>();
  private currentVersion: string = "";
  private latestVersion: string | null = null;
  private otelStates = new Map<string, SessionOtelState>();
  private agentStateRecords = new Map<string, AgentStateRecord>();
  cacheTimersEnabled: boolean = true;
  private sessionContexts = new Map<string, SessionContext>();
  private stateAttrs: Record<AgentState, CellAttrs> = buildStateAttrs(DEFAULT_STATE_PALETTE);

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /** Set the per-state indicator colors. Emphasis (bold/dim per state) is fixed. */
  setStateColors(colors: Record<AgentState, StateColor>): void {
    this.stateAttrs = buildStateAttrs(colors);
  }

  updateSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    // Prune otelStates and agentStateRecords for sessions that no longer exist
    const activeIds = new Set(sessions.map((s) => s.id));
    for (const id of this.otelStates.keys()) {
      if (!activeIds.has(id)) this.otelStates.delete(id);
    }
    for (const id of this.agentStateRecords.keys()) {
      if (!activeIds.has(id)) this.agentStateRecords.delete(id);
    }
    this.rebuildPlan();
  }

  setActiveSession(id: string): void {
    if (this.activeSessionId === id) return;
    this.activeSessionId = id;
  }

  /** Mark the Command Center (Overview) as the active selection. */
  setOverviewActive(active: boolean): void {
    this.overviewActive = active;
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

  setPinnedPanes(panes: PinnedPaneEntry[]): void {
    this.pinnedPanes = panes;
    this.rebuildPlan();
  }

  private sortMode: SortMode = "project";
  private filterMode: FilterMode = "all";

  /** A session's status for ordering/filtering — the same distinction the row
   * dots make: a promoted agent state, else "activity" if tmux saw output,
   * else "idle". */
  private statusOf(session: SessionInfo): SessionStatus {
    const rec = this.agentStateRecords.get(session.id);
    if (rec) return rec.state;
    if (this.activitySet.has(session.id)) return "activity";
    return "idle";
  }

  /** Newest signal of life across the sources we track, for activity sort and
   * the status tie-break. */
  private lastActivityOf(session: SessionInfo): number {
    const rec = this.agentStateRecords.get(session.id);
    const otel = this.otelStates.get(session.id);
    return Math.max(
      rec?.since ?? 0,
      otel?.lastRequestTime ?? 0,
      session.activity ?? 0,
    );
  }

  private buildSortInfos(): SessionSortInfo[] {
    return this.sessions.map((s) => ({
      name: s.name,
      status: this.statusOf(s),
      lastActivity: this.lastActivityOf(s),
    }));
  }

  getSortMode(): SortMode { return this.sortMode; }
  getFilterMode(): FilterMode { return this.filterMode; }

  setSortMode(mode: SortMode): void {
    this.sortMode = mode;
    // Show the TOP of the re-ordered list — the whole point of sorting by
    // status is to see what rose to the top, not to chase the active session.
    this.scrollOffset = 0;
    this.rebuildPlan();
  }
  setFilterMode(mode: FilterMode): void {
    this.filterMode = mode;
    this.scrollOffset = 0;
    this.rebuildPlan();
  }

  /** Cycle sort/filter and return the new mode (so the caller can persist/report it). */
  cycleSortMode(): SortMode {
    this.setSortMode(cycleSort(this.sortMode));
    return this.sortMode;
  }
  cycleFilterMode(): FilterMode {
    this.setFilterMode(cycleFilter(this.filterMode));
    return this.filterMode;
  }

  private rebuildPlan(): void {
    const { items, displayOrder } = buildRenderPlan(
      this.sessions,
      this.collapsedGroups,
      this.pinnedSessions,
      this.pinnedPanes,
      this.buildSortInfos(),
      this.sortMode,
      this.filterMode,
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

  setAgentStateRecord(
    sessionId: string,
    record: AgentStateRecord | null,
  ): void {
    const had = this.agentStateRecords.has(sessionId);
    if (record === null) this.agentStateRecords.delete(sessionId);
    else this.agentStateRecords.set(sessionId, record);

    // Promotion (or de-promotion) changes this session's row count, which
    // shifts every item below it — so the scroll offset can fall out of range.
    // Re-clamp, and keep the active session on screen so a promotion elsewhere
    // in the list can't scroll the row you're looking at out of view.
    if (had !== this.agentStateRecords.has(sessionId)) {
      this.clampScroll();
      this.scrollToActive();
    }
  }

  setSessionContexts(contexts: Map<string, SessionContext>): void {
    this.sessionContexts = contexts;
    this.clampScroll();
  }

  hasActivity(sessionId: string): boolean {
    return this.activitySet.has(sessionId);
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

  /** The current jmux version — data the footer reads to build its version
   * segment. Rendering moved off the sidebar's last row to the footer. */
  getVersion(): string {
    return this.currentVersion;
  }

  /** The latest known release, or null when no update check has completed
   * (or none is available). Only meaningful together with hasUpdate(). */
  getLatestVersion(): string | null {
    return this.latestVersion;
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

  getSelectionByRow(row: number): SidebarSelection | null {
    return this.rowToSelection.get(row) ?? null;
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
      const h = this.heightOf(item);
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

  /** Column range (inclusive, 0-indexed) of the clickable "⇅ <Sort>" control on
   * the header row, recomputed each render; [-1,-1] when it isn't drawn. */
  private sortToggleStart = -1;
  private sortToggleEnd = -1;

  /**
   * Header row: a static `Sessions` label, then a clickable `⇅ <Sort>` control
   * naming the current sort mode, then (when filtered) a dim `· <Filter>`
   * suffix, then the right-aligned state rollup. The control cycles the sort
   * mode on click (headerSortToggleHit); the ⇅ glyph and the accent-muted mode
   * name are its affordance.
   */
  private renderHeader(grid: CellGrid): void {
    const label = "Sessions";
    writeString(grid, 0, 1, label, { ...ACCENT_ATTRS, bold: true });

    const control = `⇅ ${sortModeShort(this.sortMode)}`;
    const controlCol = 1 + textCols(label) + 2; // gap after the label
    // The control is the sort-cycle click target — icon + mode name.
    this.sortToggleStart = controlCol;
    this.sortToggleEnd = controlCol + textCols(control) - 1;
    writeString(grid, 0, controlCol, control, {
      fg: tokens.accentMuted.fg,
      fgMode: tokens.accentMuted.fgMode,
    });

    let after = controlCol + textCols(control);
    if (this.filterMode !== "all") {
      const suffix = ` · ${filterModeShort(this.filterMode)}`;
      if (after + textCols(suffix) < this.width - 1) {
        writeString(grid, 0, after, suffix, { ...DIM_ATTRS });
        after += textCols(suffix);
      }
    }
    // Rollup fills the right, yielding to the header-left it must not overprint.
    this.renderHeaderRollup(grid, after);
  }

  /** True when a click at (row, col) lands on the header sort-toggle control. */
  headerSortToggleHit(row: number, col: number): boolean {
    return row === 0 && col >= this.sortToggleStart && col <= this.sortToggleEnd;
  }

  /**
   * Right-aligned agent-state tally on the header row: `3⏵ 2! 1✓`, one segment
   * per state that has at least one session, in the row indicators' own glyphs
   * and colours (running green, waiting yellow-bold, complete dim-neutral). Only
   * promoted sessions carry a state, so this counts exactly what the dots below
   * would show. `leftEnd` is the last column the header-left content occupies;
   * the rollup is dropped rather than overprint it.
   */
  private renderHeaderRollup(grid: CellGrid, leftEnd: number): void {
    const counts: Record<AgentState, number> = { running: 0, waiting: 0, complete: 0 };
    for (const rec of this.agentStateRecords.values()) counts[rec.state]++;

    const GLYPH: Record<AgentState, string> = { running: "⏵", waiting: "!", complete: "✓" };
    const order: AgentState[] = ["running", "waiting", "complete"];
    const seg = (s: AgentState) => ({ text: `${counts[s]}${GLYPH[s]}`, attrs: this.stateAttrs[s] });
    const full = order.filter((s) => counts[s] > 0).map(seg);
    if (full.length === 0) return;

    const width = (segs: { text: string }[]) =>
      segs.reduce((w, s) => w + textCols(s.text), 0) + Math.max(0, segs.length - 1);
    // `leftEnd` is the first free column past the header-left content; the
    // rollup needs its start column strictly beyond it (a ≥1-column gap).
    const fits = (segs: { text: string }[]) => this.width - 1 - width(segs) > leftEnd;

    // Prefer the full tally; when the sort control leaves no room, fall back to
    // just the waiting count — the one that actually demands action — before
    // giving up entirely. So a narrow sidebar still shows "2!" if not "2⏵ 2! 1✓".
    const segments = fits(full)
      ? full
      : counts.waiting > 0 && fits([seg("waiting")])
        ? [seg("waiting")]
        : null;
    if (!segments) return;

    let col = this.width - 1 - width(segments);
    for (const s of segments) {
      writeString(grid, 0, col, s.text, s.attrs);
      col += textCols(s.text) + 1;
    }
  }

  private footerRows(): number {
    return this.currentVersion ? 1 : 0;
  }

  private viewportHeight(): number {
    return this.height - HEADER_ROWS - this.footerRows();
  }

  /**
   * True when a session renders its third row (context + agent-state label).
   * Promotion is what creates that row; before it the row would be blank.
   */
  private sessionHasStateRow = (sessionIndex: number): boolean => {
    const session = this.sessions[sessionIndex];
    return session !== undefined && this.agentStateRecords.has(session.id);
  };

  private heightOf(item: RenderItem): number {
    return itemHeight(item, this.sessionHasStateRow);
  }

  private clampScroll(): void {
    const totalRows = this.items.reduce((sum, item) => sum + this.heightOf(item), 0);
    const maxOffset = Math.max(0, totalRows - this.viewportHeight());
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));
  }

  getGrid(): CellGrid {
    const grid = createGrid(this.width, this.height);
    this.rowToSessionIndex.clear();
    this.rowToGroupLabel.clear();
    this.rowToSelection.clear();

    // Header \u2014 a title on the left, a live agent-state rollup on the right so
    // "how many agents need me" is legible even when the list is scrolled. The
    // title names the active sort/filter when either is non-default, so the
    // list order/membership is never a mystery: "Sessions" by default,
    // "By status" when sorted, with " \u00b7 needs you" appended when filtered.
    this.renderHeader(grid);
    writeString(grid, 1, 0, "\u2500".repeat(this.width), DIM_ATTRS);

    const vpHeight = this.viewportHeight();
    const contentBottom = HEADER_ROWS + vpHeight;
    let vRow = 0;
    let totalRows = 0;

    for (const item of this.items) {
      const h = this.heightOf(item);
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

      if (item.type === "overview") {
        // Selected chrome (ACTIVE_BG fill + \u258e marker) when the glass is the
        // active view \u2014 same treatment as the active session row.
        const active = this.overviewActive;
        const bgPatch: CellAttrs = active ? { bg: ACTIVE_BG, bgMode: ColorMode.RGB } : {};
        this.paintRowChrome(grid, screenRow, active, false);

        // Header row: "\u2318 Command Center \u00b7 N" (bold).
        const headerAttrs: CellAttrs = { ...GROUP_HEADER_ATTRS, bold: true, ...bgPatch };
        const headerText = item.paneCount > 0
          ? `\u2318 Command Center \u00b7 ${item.paneCount}`
          : "\u2318 Command Center";
        const maxHeaderLen = this.width - 2;
        const headerDisplay = headerText.length > maxHeaderLen
          ? headerText.slice(0, maxHeaderLen - 1) + "\u2026"
          : headerText;
        writeString(grid, screenRow, 1, headerDisplay, headerAttrs);
        this.rowToSelection.set(screenRow, { type: "overview" });

        // Breakdown row: colored "n RUN  n WAIT  n DONE" for non-zero states.
        if (item.paneCount > 0) {
          const breakdownRow = screenRow + 1;
          const tally = { running: 0, waiting: 0, complete: 0 };
          for (const p of this.pinnedPanes) {
            if (p.agentState === "running") tally.running++;
            else if (p.agentState === "waiting") tally.waiting++;
            else if (p.agentState === "complete") tally.complete++;
          }
          const segs: { text: string; attrs: CellAttrs }[] = [];
          if (tally.running > 0) segs.push({ text: `${tally.running} RUN`, attrs: this.stateAttrs.running });
          if (tally.waiting > 0) segs.push({ text: `${tally.waiting} WAIT`, attrs: this.stateAttrs.waiting });
          if (tally.complete > 0) segs.push({ text: `${tally.complete} DONE`, attrs: this.stateAttrs.complete });
          if (breakdownRow < contentBottom) {
            this.paintRowChrome(grid, breakdownRow, active, false);
            let col = 3;
            for (const seg of segs) {
              if (col + seg.text.length > this.width) break;
              writeString(grid, breakdownRow, col, seg.text, { ...seg.attrs, ...bgPatch });
              col += seg.text.length + 2; // two-space gap
            }
            this.rowToSelection.set(breakdownRow, { type: "overview" });
          }
        }
      } else if (item.type === "group-header") {
        // "label ────": the label in textSecondary, then a hairline fill in
        // ruleHairline out to the sidebar's inner edge — replaces the old
        // "\u25be label" disclosure form. Collapse behaviour is unchanged
        // (rebuildPlan/toggleGroup); a collapsed group shows a small
        // right-aligned count cue overlaid on the hairline's tail instead of
        // a right-pointing chevron.
        const isHovered = this.hoveredRow === screenRow;
        const bgPatch: CellAttrs = isHovered ? { bg: HOVER_BG, bgMode: ColorMode.RGB } : {};
        if (isHovered) {
          writeString(grid, screenRow, 0, " ".repeat(this.width), bgPatch);
        }
        const labelAttrs: CellAttrs = { ...GROUP_HEADER_ATTRS, ...bgPatch };
        const hairlineAttrs: CellAttrs = { ...GROUP_HAIRLINE_ATTRS, ...bgPatch };
        const countAttrs: CellAttrs = { ...DIM_ATTRS, ...bgPatch };

        const labelStart = 1;
        const innerEdge = this.width - 1; // last usable column (matches the right margin used elsewhere, e.g. linearIdCol)
        // Reserve the label + a 1-space gap + at least 1 hairline char.
        const maxLabelLen = innerEdge - labelStart + 1 - 2;
        let label = item.label;
        if (label.length > maxLabelLen) {
          label = label.slice(0, Math.max(0, maxLabelLen - 1)) + "\u2026";
        }
        writeString(grid, screenRow, labelStart, label, labelAttrs);

        const fillStart = labelStart + label.length + 1; // one blank column gap before the fill
        if (fillStart <= innerEdge) {
          writeString(
            grid,
            screenRow,
            fillStart,
            frame.ruleLight.repeat(innerEdge - fillStart + 1),
            hairlineAttrs,
          );
        }

        if (item.collapsed) {
          const countSuffix = ` (${item.sessionCount})`;
          const countCol = innerEdge - countSuffix.length + 1;
          if (countCol > fillStart) {
            writeString(grid, screenRow, countCol, countSuffix, countAttrs);
          }
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
        writeString(grid, footerRow, 1, versionText, VERSION_ATTRS);
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
    const agentStateRecord = this.agentStateRecords.get(session.id) ?? null;
    const view = buildSessionView(session, ctx, timerState, this.activitySet, agentStateRecord);

    // Map rows to session for click handling
    this.rowToSessionIndex.set(nameRow, sessionIdx);
    if (detailRow < this.height) {
      this.rowToSessionIndex.set(detailRow, sessionIdx);
    }

    // Map rows to SidebarSelection for the unified selection API
    this.rowToSelection.set(nameRow, { type: "session", id: session.id });
    if (detailRow < this.height) {
      this.rowToSelection.set(detailRow, { type: "session", id: session.id });
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
      case "agent-running":
        writeString(grid, nameRow, 1, "\u23F5", this.stateAttrs.running);
        break;
      case "agent-waiting":
        writeString(grid, nameRow, 1, "!", this.stateAttrs.waiting);
        break;
      case "agent-complete":
        writeString(grid, nameRow, 1, "\u2713", this.stateAttrs.complete);
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

    // Context figure (before the timer) — only for a NON-promoted session,
    // which has no row 3 to carry it. A promoted session leaves it on row 3
    // beside its state label. Dropped first when the cluster runs out of room,
    // since it is the least urgent field here.
    if (!agentStateRecord) {
      const otelForRow2 = this.otelStates.get(session.id);
      const contextText = otelForRow2 ? buildSessionRow3(otelForRow2, this.width - 3, null).text.trim() : "";
      if (contextText) {
        const ctxCol = rightEdge - contextText.length + 1;
        if (ctxCol > nameStart) {
          writeString(grid, detailRow, ctxCol, contextText, { ...DIM_ATTRS, ...bgAttrs });
          rightEdge = ctxCol - 2;
        }
      }
    }

    // Pinned pane count (right side, before branch)
    if (item.pinnedCount && item.pinnedCount > 0) {
      const pinnedStr = `(${item.pinnedCount} pinned)`;
      const pinnedCol = rightEdge - pinnedStr.length + 1;
      if (pinnedCol > 3) {
        writeString(grid, detailRow, pinnedCol, pinnedStr, { ...DIM_ATTRS, ...bgAttrs });
        rightEdge = pinnedCol - 2;
      }
    }

    // Branch (left, truncates to fit)
    if (view.branch) {
      const detailStart = 3;
      const maxLen = rightEdge - detailStart + 1;
      if (maxLen > 0) {
        const branch = truncateToCols(view.branch, maxLen);
        writeString(grid, detailRow, detailStart, branch, detailAttrs);
      }
    }

    // Row 3: context tokens (left) / agent state label (right). Only a promoted
    // session has this row at all — see itemHeight. A non-promoted session
    // stops at row 2 (its context figure moved into that row's right cluster
    // above), so rendering here would paint over the NEXT item.
    if (agentStateRecord && row3 < this.height) {
      this.paintRowChrome(grid, row3, isActive, isHovered);
      this.rowToSessionIndex.set(row3, sessionIdx);

      const otel = this.otelStates.get(session.id) ?? (agentStateRecord ? EMPTY_OTEL_STATE : undefined);
      if (otel) {
        // Pass the budget that buildSessionRow3 will treat as its full usable
        // width. We start writing at col 3, so usable budget = this.width - 3.
        const result = buildSessionRow3(otel, this.width - 3, agentStateRecord?.state ?? null);
        if (result.text.length > 0) {
          const row3Attrs: CellAttrs = isActive
            ? ACTIVE_DETAIL_ATTRS
            : isHovered
              ? HOVER_DETAIL_ATTRS
              : DIM_ATTRS;
          writeString(grid, row3, 3, result.text, row3Attrs);

          // Repaint the state label in its specific color so it stands out
          // from the dim row-3 background attrs.
          if (agentStateRecord && result.labelCol >= 0) {
            const labelDef = {
              text: STATE_LABEL_TEXT[agentStateRecord.state],
              attrs: this.stateAttrs[agentStateRecord.state],
            };
            const col = 3 + result.labelCol;
            const bgAttrs: CellAttrs = isActive
              ? { bg: ACTIVE_BG, bgMode: ColorMode.RGB }
              : isHovered
                ? { bg: HOVER_BG, bgMode: ColorMode.RGB }
                : {};
            writeString(grid, row3, col, labelDef.text, { ...labelDef.attrs, ...bgAttrs });
          }
        }
      }
    }
  }
}
