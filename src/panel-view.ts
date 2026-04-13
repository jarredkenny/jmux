export interface PanelViewFilter {
  scope: "assigned" | "authored" | "reviewing";
}

export type GroupByField = "team" | "project" | "status" | "priority" | "none";
export type SortByField = "priority" | "updated" | "created" | "status";

export interface PanelView {
  id: string;
  label: string;
  source: "issues" | "mrs";
  filter: PanelViewFilter;
  groupBy: GroupByField;
  subGroupBy: GroupByField;
  sortBy: SortByField;
  sortOrder: "asc" | "desc";
  sessionLinkedFirst: boolean;
}

const VALID_COMBOS: Array<{ source: string; scope: string }> = [
  { source: "issues", scope: "assigned" },
  { source: "mrs", scope: "authored" },
  { source: "mrs", scope: "reviewing" },
];

export const DEFAULT_VIEWS: PanelView[] = [
  {
    id: "my-issues", label: "Issues", source: "issues",
    filter: { scope: "assigned" },
    groupBy: "team", subGroupBy: "status",
    sortBy: "priority", sortOrder: "asc", sessionLinkedFirst: true,
  },
  {
    id: "my-mrs", label: "My MRs", source: "mrs",
    filter: { scope: "authored" },
    groupBy: "none", subGroupBy: "none",
    sortBy: "updated", sortOrder: "desc", sessionLinkedFirst: true,
  },
  {
    id: "review", label: "Review", source: "mrs",
    filter: { scope: "reviewing" },
    groupBy: "none", subGroupBy: "none",
    sortBy: "created", sortOrder: "asc", sessionLinkedFirst: false,
  },
];

export function parseViews(raw: unknown): PanelView[] {
  if (!Array.isArray(raw)) return DEFAULT_VIEWS;
  const views: PanelView[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, source, filter, groupBy, subGroupBy, sortBy, sortOrder, sessionLinkedFirst } = entry as any;
    if (typeof id !== "string" || !id) continue;
    if (typeof label !== "string" || !label) continue;
    if (source !== "issues" && source !== "mrs") continue;
    const scope = filter?.scope;
    if (!VALID_COMBOS.some((c) => c.source === source && c.scope === scope)) {
      process.stderr.write(`jmux: invalid panelView "${id}" — ${source}+${scope} is not a valid combination\n`);
      continue;
    }
    views.push({
      id, label, source,
      filter: { scope },
      groupBy: isGroupByField(groupBy) ? groupBy : "none",
      subGroupBy: isGroupByField(subGroupBy) ? subGroupBy : "none",
      sortBy: isSortByField(sortBy) ? sortBy : "priority",
      sortOrder: sortOrder === "desc" ? "desc" : "asc",
      sessionLinkedFirst: sessionLinkedFirst !== false,
    });
  }
  return views.length > 0 ? views : DEFAULT_VIEWS;
}

function isGroupByField(v: unknown): v is GroupByField {
  return v === "team" || v === "project" || v === "status" || v === "priority" || v === "none";
}

function isSortByField(v: unknown): v is SortByField {
  return v === "priority" || v === "updated" || v === "created" || v === "status";
}

const GROUP_BY_CYCLE: GroupByField[] = ["team", "project", "status", "priority", "none"];
const SORT_BY_CYCLE: SortByField[] = ["priority", "updated", "created", "status"];

export function cycleGroupBy(current: GroupByField): GroupByField {
  const idx = GROUP_BY_CYCLE.indexOf(current);
  return GROUP_BY_CYCLE[(idx + 1) % GROUP_BY_CYCLE.length];
}

export function cycleSortBy(current: SortByField): SortByField {
  const idx = SORT_BY_CYCLE.indexOf(current);
  return SORT_BY_CYCLE[(idx + 1) % SORT_BY_CYCLE.length];
}

export function toggleSortOrder(current: "asc" | "desc"): "asc" | "desc" {
  return current === "asc" ? "desc" : "asc";
}
