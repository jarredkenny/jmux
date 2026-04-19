// src/panel-view-renderer.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import type { PanelView } from "./panel-view";
import type { Issue, MergeRequest } from "./adapters/types";
import { fuzzyMatch } from "./fuzzy";

export type IssueSessionState = "none" | "worktree" | "session";

export interface RenderableItem {
  id: string;
  type: "issue" | "mr";
  primary: string;
  title: string;
  status: string;
  meta: string;
  group: string;
  subGroup: string;
  sessionLinked: boolean;
  priority: number;
  updatedAt: number;
  raw: Issue | MergeRequest;
  issueSessionState?: IssueSessionState;  // only for issues
}

export type ViewNode =
  | { kind: "group"; key: string; label: string; count: number; collapsed: boolean; depth: number }
  | { kind: "item"; item: RenderableItem; depth: number };

export interface ViewState {
  selectedIndex: number;
  collapsedGroups: Set<string>;
  scrollOffset: number;
  detailScrollOffset: number;
  filterQuery: string | null;  // null = filter off, "" = bar open but empty, "abc" = filtering
}

export function createViewState(): ViewState {
  return { selectedIndex: 0, collapsedGroups: new Set(), scrollOffset: 0, detailScrollOffset: 0, filterQuery: null };
}

// --- Data Pipeline ---

export function transformIssues(
  issues: Issue[],
  linkedIds: Set<string>,
  sessionStates?: Map<string, IssueSessionState>,
): RenderableItem[] {
  return issues.map((issue) => ({
    id: issue.id,
    type: "issue" as const,
    primary: issue.identifier,
    title: issue.title,
    status: issue.status,
    meta: issue.assignee ?? "",
    group: issue.team ?? "",
    subGroup: issue.status ?? "",
    sessionLinked: linkedIds.has(issue.id),
    priority: issue.priority ?? 0,
    updatedAt: issue.updatedAt ?? 0,
    raw: issue,
    issueSessionState: sessionStates?.get(issue.id) ?? "none",
  }));
}

export function transformMrs(mrs: MergeRequest[], linkedIds: Set<string>): RenderableItem[] {
  return mrs.map((mr) => ({
    id: mr.id,
    type: "mr" as const,
    primary: `!${mr.id.split(":")[1] ?? mr.id}`,
    title: mr.title,
    status: mr.status,
    meta: `${mr.sourceBranch} → ${mr.targetBranch}`,
    group: "",
    subGroup: mr.status,
    sessionLinked: linkedIds.has(mr.id),
    priority: 0,
    updatedAt: mr.updatedAt ?? 0,
    raw: mr,
  }));
}

export function filterItems(items: RenderableItem[], query: string | null): RenderableItem[] {
  if (!query) return items;
  const scored: { item: RenderableItem; score: number }[] = [];
  for (const item of items) {
    const haystack = `${item.primary} ${item.title}`;
    const result = fuzzyMatch(query, haystack);
    if (result) scored.push({ item, score: result.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

function getField(item: RenderableItem, field: string): string {
  switch (field) {
    case "team": return item.type === "issue" ? (item.raw as Issue).team ?? "" : "";
    case "project": return item.type === "issue" ? (item.raw as Issue).project ?? "" : "";
    case "status": return item.status;
    case "priority": return String(item.priority);
    default: return "";
  }
}

export function buildViewNodes(
  items: RenderableItem[],
  view: PanelView,
  collapsedGroups: Set<string>,
): ViewNode[] {
  // Partition: session-linked first, sorting within each partition separately
  let ordered = items;
  if (view.sessionLinkedFirst) {
    const linked = sortItems(items.filter((i) => i.sessionLinked), view.sortBy, view.sortOrder);
    const unlinked = sortItems(items.filter((i) => !i.sessionLinked), view.sortBy, view.sortOrder);
    ordered = [...linked, ...unlinked];
  } else {
    ordered = sortItems(items, view.sortBy, view.sortOrder);
  }

  if (view.groupBy === "none") {
    return ordered.map((item) => ({ kind: "item" as const, item, depth: 0 }));
  }

  // Group
  const groups = new Map<string, RenderableItem[]>();
  for (const item of ordered) {
    const key = getField(item, view.groupBy);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const nodes: ViewNode[] = [];
  for (const [label, groupItems] of groups) {
    const groupKey = label;
    const collapsed = collapsedGroups.has(groupKey);
    nodes.push({ kind: "group", key: groupKey, label: label || "(none)", count: groupItems.length, collapsed, depth: 0 });

    if (collapsed) continue;

    if (view.subGroupBy !== "none") {
      const subGroups = new Map<string, RenderableItem[]>();
      for (const item of groupItems) {
        const subKey = getField(item, view.subGroupBy);
        const list = subGroups.get(subKey) ?? [];
        list.push(item);
        subGroups.set(subKey, list);
      }
      for (const [subLabel, subItems] of subGroups) {
        const subKey = `${groupKey}:${subLabel}`;
        const subCollapsed = collapsedGroups.has(subKey);
        nodes.push({ kind: "group", key: subKey, label: subLabel || "(none)", count: subItems.length, collapsed: subCollapsed, depth: 1 });
        if (!subCollapsed) {
          for (const item of subItems) {
            nodes.push({ kind: "item", item, depth: 2 });
          }
        }
      }
    } else {
      for (const item of groupItems) {
        nodes.push({ kind: "item", item, depth: 1 });
      }
    }
  }

  return nodes;
}

function sortItems(items: RenderableItem[], sortBy: string, order: "asc" | "desc"): RenderableItem[] {
  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case "priority": cmp = (a.priority || 99) - (b.priority || 99); break;
      case "updated": cmp = b.updatedAt - a.updatedAt; break;
      case "created": cmp = a.updatedAt - b.updatedAt; break;
      case "status": cmp = a.status.localeCompare(b.status); break;
    }
    return order === "desc" ? -cmp : cmp;
  });
  return sorted;
}

// --- Rendering ---

const CURSOR_ATTRS: CellAttrs = { fg: (0xFB << 16) | (0xD4 << 8) | 0xB8, fgMode: ColorMode.RGB };
const LINKED_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const UNLINKED_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const TITLE_ATTRS: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB };
const GROUP_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, bold: true };
const PRIORITY_ATTRS: Record<number, CellAttrs> = {
  1: { fg: 1, fgMode: ColorMode.Palette, bold: true },
  2: { fg: (0xFF << 16) | (0x8C << 8) | 0x00, fgMode: ColorMode.RGB },
  3: { fg: 3, fgMode: ColorMode.Palette },
  4: { fg: 8, fgMode: ColorMode.Palette, dim: true },
};
const DIM_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const DETAIL_LABEL: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const DETAIL_VALUE: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB };
const DETAIL_KEY: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const SEPARATOR_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const HINT_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const URL_ATTRS: CellAttrs = { fg: (0x58 << 16) | (0xA6 << 8) | 0xFF, fgMode: ColorMode.RGB, underline: true };

const ACTION_BAR_ROWS = 2;
const MIN_ROWS_FOR_DETAIL = 15;

export function renderView(
  nodes: ViewNode[],
  cols: number,
  rows: number,
  state: ViewState,
): CellGrid {
  const grid = createGrid(cols, rows);
  const showDetail = rows >= MIN_ROWS_FOR_DETAIL;

  // Filter bar: null = off, "" = bar visible but empty, "abc" = filtering
  const filterBarActive = state.filterQuery !== null;
  const filterBarRows = filterBarActive ? 1 : 0;

  // Layout: [filter bar] | list | separator | detail content | action bar
  const actionBarStart = showDetail ? rows - ACTION_BAR_ROWS : rows;
  const minDetailRows = 4;
  const maxListRows = showDetail ? rows - minDetailRows - 1 - ACTION_BAR_ROWS - filterBarRows : rows - filterBarRows;
  const listRows = showDetail ? Math.min(maxListRows, Math.max(3, Math.floor((rows - ACTION_BAR_ROWS - 1 - filterBarRows) * 0.5))) : rows - filterBarRows;
  const listStartRow = filterBarRows;
  const sepRow = showDetail ? listStartRow + listRows : rows;
  const detailStart = sepRow + 1;
  const detailRows = showDetail ? actionBarStart - detailStart : 0;

  // Render filter bar
  if (filterBarActive) {
    writeString(grid, 0, 1, "/", DETAIL_KEY);
    if (state.filterQuery) {
      writeString(grid, 0, 3, state.filterQuery.slice(0, cols - 4), TITLE_ATTRS);
    }
  }

  // Render list
  if (nodes.length === 0 && filterBarActive) {
    // Empty state
    const msg = "No matches";
    const msgCol = Math.max(0, Math.floor((cols - msg.length) / 2));
    writeString(grid, listStartRow + Math.floor(listRows / 2), msgCol, msg, DIM_ATTRS);
  } else {
    let visibleIdx = 0;
    for (let i = 0; i < nodes.length && visibleIdx < listRows + state.scrollOffset; i++) {
      if (visibleIdx < state.scrollOffset) { visibleIdx++; continue; }
      const row = listStartRow + visibleIdx - state.scrollOffset;
      if (row >= listStartRow + listRows) break;
      const node = nodes[i];
      const isSelected = i === state.selectedIndex;

      if (node.kind === "group") {
        renderGroupHeader(grid, row, cols, node, isSelected);
      } else {
        renderItem(grid, row, cols, node.item, node.depth, isSelected);
      }
      visibleIdx++;
    }
  }

  // Render detail pane
  if (showDetail) {
    // Separator
    writeString(grid, sepRow, 0, "─".repeat(cols), SEPARATOR_ATTRS);

    // Detail content (scrollable)
    const selectedNode = nodes[state.selectedIndex];
    if (selectedNode?.kind === "item") {
      renderDetail(grid, detailStart, cols, detailRows, selectedNode.item, state.detailScrollOffset);
    } else if (selectedNode?.kind === "group") {
      writeString(grid, detailStart, 2, `${selectedNode.label} — ${selectedNode.count} items`, GROUP_ATTRS);
    }

    // Action bar — always at the bottom
    const actionSepRow = actionBarStart - 1;
    if (actionSepRow > detailStart) {
      writeString(grid, actionSepRow, 0, "─".repeat(cols), SEPARATOR_ATTRS);
    }
    const selectedItem = selectedNode?.kind === "item" ? selectedNode.item : null;
    renderActionBar(grid, actionBarStart, cols, selectedItem);
  }

  return grid;
}

function renderGroupHeader(grid: CellGrid, row: number, cols: number, node: Extract<ViewNode, { kind: "group" }>, selected: boolean): void {
  const indent = node.depth * 2;
  let col = indent;
  if (selected) {
    writeString(grid, row, col, node.collapsed ? "▸" : "▾", CURSOR_ATTRS);
  } else {
    writeString(grid, row, col, node.collapsed ? "▸" : "▾", DIM_ATTRS);
  }
  col += 2;
  const label = `${node.label} (${node.count})`;
  writeString(grid, row, col, label, selected ? { ...GROUP_ATTRS, fg: (0xFB << 16) | (0xD4 << 8) | 0xB8, fgMode: ColorMode.RGB } : GROUP_ATTRS);
}

function renderItem(grid: CellGrid, row: number, cols: number, item: RenderableItem, depth: number, selected: boolean): void {
  const indent = depth * 2;
  let col = indent;

  // Cursor
  if (selected) {
    writeString(grid, row, col, "▸", CURSOR_ATTRS);
    col += 2;
  } else {
    col += 2;
  }

  // Linked indicator
  writeString(grid, row, col, item.sessionLinked ? "●" : "○", item.sessionLinked ? LINKED_ATTRS : UNLINKED_ATTRS);
  col += 2;

  // Priority badge (right-aligned)
  const priBadge = item.priority > 0 && item.priority <= 4 ? `P${item.priority}` : "";
  const priCol = priBadge ? cols - priBadge.length - 1 : cols;

  // Primary + title
  const maxTextLen = priCol - col - 1;
  let text = `${item.primary} ${item.title}`;
  if (text.length > maxTextLen) {
    text = text.slice(0, maxTextLen - 1) + "\u2026";
  }
  writeString(grid, row, col, text, selected ? { ...TITLE_ATTRS, bold: true } : TITLE_ATTRS);

  if (priBadge) {
    const priAttrs = PRIORITY_ATTRS[item.priority] ?? DIM_ATTRS;
    writeString(grid, row, priCol, priBadge, priAttrs);
  }
}

type DetailLine = { text: string; attrs: CellAttrs; indent?: number };

function buildIssueDetailLines(item: RenderableItem, cols: number): DetailLine[] {
  const issue = item.raw as Issue;
  const pad = 2;
  const contentWidth = cols - pad * 2;
  const lines: DetailLine[] = [];

  // Header
  lines.push({ text: `${issue.identifier} ${issue.title}`.slice(0, contentWidth), attrs: { ...DETAIL_VALUE, bold: true } });

  // Metadata
  let statusLine = `Status: ${issue.status}`;
  if (issue.priority != null && issue.priority > 0) statusLine += `   Priority: P${issue.priority}`;
  lines.push({ text: statusLine, attrs: DETAIL_LABEL });
  lines.push({ text: `Assignee: ${issue.assignee ?? "Unassigned"}`, attrs: DETAIL_LABEL });
  if (issue.team) lines.push({ text: `Team: ${issue.team}`, attrs: DETAIL_LABEL });

  // Links
  if (issue.links && issue.links.length > 0) {
    lines.push({ text: "", attrs: DIM_ATTRS });
    lines.push({ text: "Links:", attrs: { ...DETAIL_LABEL, bold: true } });
    for (const link of issue.links) {
      const label = link.title ?? link.url;
      lines.push({ text: `${label}`.slice(0, contentWidth - 1), attrs: URL_ATTRS, indent: 1 });
      if (link.title) {
        lines.push({ text: link.url.slice(0, contentWidth - 1), attrs: DIM_ATTRS, indent: 1 });
      }
    }
  }

  // Description
  if (issue.description) {
    lines.push({ text: "", attrs: DIM_ATTRS });
    lines.push({ text: "Description:", attrs: { ...DETAIL_LABEL, bold: true } });
    for (const line of wrapText(issue.description, contentWidth)) {
      lines.push({ text: line, attrs: DETAIL_VALUE });
    }
  }

  // Comments
  if (issue.comments && issue.comments.length > 0) {
    lines.push({ text: "", attrs: DIM_ATTRS });
    lines.push({ text: `Comments (${issue.comments.length}):`, attrs: { ...DETAIL_LABEL, bold: true } });
    for (const comment of issue.comments) {
      lines.push({ text: "", attrs: DIM_ATTRS });
      const date = comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : "";
      lines.push({ text: `${comment.author}  ${date}`, attrs: { ...DETAIL_LABEL, bold: true } });
      for (const line of wrapText(comment.body, contentWidth)) {
        lines.push({ text: line, attrs: DETAIL_VALUE });
      }
    }
  }

  return lines;
}

function buildMrDetailLines(item: RenderableItem, cols: number): DetailLine[] {
  const mr = item.raw as MergeRequest;
  const pad = 2;
  const contentWidth = cols - pad * 2;
  const lines: DetailLine[] = [];

  lines.push({ text: `${item.primary} ${mr.title}`.slice(0, contentWidth), attrs: { ...DETAIL_VALUE, bold: true } });

  const statusLabel = mr.status.charAt(0).toUpperCase() + mr.status.slice(1);
  lines.push({ text: `${statusLabel}  ${mr.sourceBranch} → ${mr.targetBranch}`.slice(0, contentWidth), attrs: DETAIL_LABEL });

  if (mr.pipeline) {
    const glyphs: Record<string, string> = { passed: "✓", running: "⟳", failed: "✗", pending: "○", canceled: "—" };
    lines.push({ text: `${glyphs[mr.pipeline.state] ?? "?"} Pipeline ${mr.pipeline.state}`, attrs: DETAIL_VALUE });
  }

  lines.push({ text: `Approvals: ${mr.approvals.current}/${mr.approvals.required}`, attrs: DETAIL_VALUE });
  if (mr.author) lines.push({ text: `Author: ${mr.author}`, attrs: DETAIL_LABEL });
  if (mr.reviewers && mr.reviewers.length > 0) {
    lines.push({ text: `Reviewers: ${mr.reviewers.join(", ")}`, attrs: DETAIL_LABEL });
  }

  return lines;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  // Split on newlines first, then wrap each line
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") { lines.push(""); continue; }
    let remaining = paragraph;
    while (remaining.length > width) {
      // Find last space within width
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining) lines.push(remaining);
  }
  return lines;
}

function renderDetail(grid: CellGrid, startRow: number, cols: number, maxRows: number, item: RenderableItem, scrollOffset: number): void {
  const pad = 2;
  const lines = item.type === "issue"
    ? buildIssueDetailLines(item, cols)
    : buildMrDetailLines(item, cols);

  // Show scroll indicator if content overflows
  const totalLines = lines.length;
  const canScroll = totalLines > maxRows;

  for (let i = 0; i < maxRows; i++) {
    const lineIdx = i + scrollOffset;
    if (lineIdx >= totalLines) break;
    const line = lines[lineIdx];
    const indent = (line.indent ?? 0) * 2;
    writeString(grid, startRow + i, pad + indent, line.text.slice(0, cols - pad * 2 - indent), line.attrs);
  }

  // Scroll indicators
  if (canScroll) {
    if (scrollOffset > 0) {
      writeString(grid, startRow, cols - pad, "↑", HINT_ATTRS);
    }
    if (scrollOffset + maxRows < totalLines) {
      writeString(grid, startRow + maxRows - 1, cols - pad, "↓", HINT_ATTRS);
    }
  }
}

function renderActionBar(grid: CellGrid, startRow: number, cols: number, item: RenderableItem | null): void {
  const pad = 2;
  if (!item) return;

  // Helper: write key+label pair, return updated column
  function writeAction(row: number, col: number, key: string, label: string): number {
    writeString(grid, row, col, key, DETAIL_KEY);
    col += key.length;
    writeString(grid, row, col, label, DETAIL_LABEL);
    col += label.length;
    return col;
  }

  if (item.type === "issue") {
    const nLabel = item.issueSessionState === "session" ? "Switch"
      : item.issueSessionState === "worktree" ? "Resume"
      : "Start";
    let col = pad;
    col = writeAction(startRow, col, "[o]", " Open  ");
    col = writeAction(startRow, col, "[n]", ` ${nLabel}  `);
    col = writeAction(startRow, col, "[l]", " Link  ");
    col = writeAction(startRow, col, "[s]", " Status  ");
    col = writeAction(startRow, col, "[c]", " Copy  ");
    col = writeAction(startRow, col, "[C]", " Create  ");
    // Detail scroll hint
  } else {
    const mr = item.raw as MergeRequest;
    let col = pad;
    col = writeAction(startRow, col, "[o]", " Open  ");
    col = writeAction(startRow, col, "[l]", " Link  ");
    col = writeAction(startRow, col, "[a]", " Approve  ");
    if (mr.status === "draft") {
      col = writeAction(startRow, col, "[r]", " Ready  ");
    }
  }
}
