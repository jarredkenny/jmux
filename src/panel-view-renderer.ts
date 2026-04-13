// src/panel-view-renderer.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import type { PanelView } from "./panel-view";
import type { Issue, MergeRequest } from "./adapters/types";

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
}

export function createViewState(): ViewState {
  return { selectedIndex: 0, collapsedGroups: new Set(), scrollOffset: 0 };
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
const URL_ATTRS: CellAttrs = { fg: (0x58 << 16) | (0xA6 << 8) | 0xFF, fgMode: ColorMode.RGB, underline: true };

const DETAIL_ROWS = 8;
const MIN_ROWS_FOR_DETAIL = 15;

export function renderView(
  nodes: ViewNode[],
  cols: number,
  rows: number,
  state: ViewState,
): CellGrid {
  const grid = createGrid(cols, rows);
  const showDetail = rows >= MIN_ROWS_FOR_DETAIL;
  const listRows = showDetail ? rows - DETAIL_ROWS - 1 : rows; // -1 for separator

  // Render list
  let visibleIdx = 0;
  for (let i = 0; i < nodes.length && visibleIdx < listRows + state.scrollOffset; i++) {
    if (visibleIdx < state.scrollOffset) { visibleIdx++; continue; }
    const row = visibleIdx - state.scrollOffset;
    if (row >= listRows) break;
    const node = nodes[i];
    const isSelected = i === state.selectedIndex;

    if (node.kind === "group") {
      renderGroupHeader(grid, row, cols, node, isSelected);
    } else {
      renderItem(grid, row, cols, node.item, node.depth, isSelected);
    }
    visibleIdx++;
  }

  // Render detail pane
  if (showDetail) {
    const sepRow = listRows;
    const sepChar = "─".repeat(cols);
    writeString(grid, sepRow, 0, sepChar, SEPARATOR_ATTRS);

    const selectedNode = nodes[state.selectedIndex];
    if (selectedNode?.kind === "item") {
      renderDetail(grid, sepRow + 1, cols, DETAIL_ROWS, selectedNode.item);
    } else if (selectedNode?.kind === "group") {
      const detailRow = sepRow + 1;
      writeString(grid, detailRow, 2, `${selectedNode.label} — ${selectedNode.count} items`, GROUP_ATTRS);
    }
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

function renderDetail(grid: CellGrid, startRow: number, cols: number, maxRows: number, item: RenderableItem): void {
  const pad = 2;
  let row = startRow;

  if (item.type === "issue") {
    const issue = item.raw as Issue;
    writeString(grid, row, pad, `${issue.identifier} ${issue.title}`.slice(0, cols - pad * 2), { ...DETAIL_VALUE, bold: true });
    row++;
    let col = pad;
    writeString(grid, row, col, `Status: `, DETAIL_LABEL);
    col += 8;
    writeString(grid, row, col, issue.status, DETAIL_VALUE);
    if (issue.priority != null && issue.priority > 0) {
      col += issue.status.length + 3;
      writeString(grid, row, col, `Priority: P${issue.priority}`, DETAIL_LABEL);
    }
    row++;
    writeString(grid, row, pad, `Assignee: `, DETAIL_LABEL);
    writeString(grid, row, pad + 10, issue.assignee ?? "Unassigned", DETAIL_VALUE);
    row++;
    if (issue.team) {
      writeString(grid, row, pad, `Team: `, DETAIL_LABEL);
      writeString(grid, row, pad + 6, issue.team, DETAIL_VALUE);
      row++;
    }
    if (issue.linkedMrUrls.length > 0) {
      writeString(grid, row, pad, `MRs:`, DETAIL_LABEL);
      row++;
      for (const url of issue.linkedMrUrls) {
        if (row >= startRow + maxRows - 2) break; // leave room for actions
        const m = url.match(/merge_requests\/(\d+)/);
        const label = m ? `!${m[1]}` : "MR";
        const display = `${label}  ${url}`;
        writeString(grid, row, pad + 1, display.slice(0, cols - pad * 2 - 1), URL_ATTRS);
        row++;
      }
    }
    row++;
    writeString(grid, row, pad, "[o]", DETAIL_KEY);
    writeString(grid, row, pad + 3, " Open  ", DETAIL_LABEL);
    const nLabel = item.issueSessionState === "session" ? " Switch  "
      : item.issueSessionState === "worktree" ? " Resume  "
      : " Start   ";
    writeString(grid, row, pad + 10, "[n]", DETAIL_KEY);
    writeString(grid, row, pad + 13, nLabel, DETAIL_LABEL);
    writeString(grid, row, pad + 23, "[l]", DETAIL_KEY);
    writeString(grid, row, pad + 26, " Link", DETAIL_LABEL);
    row++;
    writeString(grid, row, pad, "[s]", DETAIL_KEY);
    writeString(grid, row, pad + 3, " Status  ", DETAIL_LABEL);
    writeString(grid, row, pad + 12, "[c]", DETAIL_KEY);
    writeString(grid, row, pad + 15, " Copy prompt", DETAIL_LABEL);
  } else {
    const mr = item.raw as MergeRequest;
    writeString(grid, row, pad, `${item.primary} ${mr.title}`.slice(0, cols - pad * 2), { ...DETAIL_VALUE, bold: true });
    row++;
    let col = pad;
    const statusLabel = mr.status.charAt(0).toUpperCase() + mr.status.slice(1);
    writeString(grid, row, col, statusLabel, DETAIL_VALUE);
    col += statusLabel.length + 2;
    writeString(grid, row, col, `${mr.sourceBranch} → ${mr.targetBranch}`.slice(0, cols - col - pad), DETAIL_LABEL);
    row++;
    if (mr.pipeline) {
      const glyphs: Record<string, string> = { passed: "✓", running: "⟳", failed: "✗", pending: "○", canceled: "—" };
      writeString(grid, row, pad, `${glyphs[mr.pipeline.state] ?? "?"} Pipeline ${mr.pipeline.state}`, DETAIL_VALUE);
      row++;
    }
    writeString(grid, row, pad, `Approvals: ${mr.approvals.current}/${mr.approvals.required}`, DETAIL_VALUE);
    row++;
    if (mr.author) {
      writeString(grid, row, pad, `Author: `, DETAIL_LABEL);
      writeString(grid, row, pad + 8, mr.author, DETAIL_VALUE);
      row++;
    }
    row++;
    writeString(grid, row, pad, "[o]", DETAIL_KEY);
    writeString(grid, row, pad + 3, " Open  ", DETAIL_LABEL);
    writeString(grid, row, pad + 10, "[l]", DETAIL_KEY);
    writeString(grid, row, pad + 13, " Link  ", DETAIL_LABEL);
    writeString(grid, row, pad + 20, "[a]", DETAIL_KEY);
    writeString(grid, row, pad + 23, " Approve", DETAIL_LABEL);
    row++;
    if (mr.status === "draft") {
      writeString(grid, row, pad, "[r]", DETAIL_KEY);
      writeString(grid, row, pad + 3, " Ready", DETAIL_LABEL);
    }
  }
}
