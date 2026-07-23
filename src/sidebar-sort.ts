// Sidebar sort & filter policy — pure, so it is unit-testable without the
// Sidebar, the grid, or tmux. The Sidebar derives a SessionSortInfo per session
// from its own state maps and hands arrays of indices here; this module decides
// order and membership only.

import type { AgentState } from "./types";

export type SortMode = "project" | "status" | "activity" | "name";
export type FilterMode = "all" | "attention" | "active";

// A session's status for ordering/filtering: the three promoted agent states,
// plus "activity" (tmux saw output but no promoted state) and "idle" (nothing).
// This is exactly the distinction the row dots and the header rollup make, so
// all three agree on what a session "is".
export type SessionStatus = AgentState | "activity" | "idle";

export interface SessionSortInfo {
  name: string;
  status: SessionStatus;
  /** Newest signal of life (agent-state change, OTEL request, tmux activity). */
  lastActivity: number;
}

export const SORT_MODES: readonly SortMode[] = ["project", "status", "activity", "name"];
export const FILTER_MODES: readonly FilterMode[] = ["all", "attention", "active"];

// Priority order: "needs you" first, "done" and idle last.
const STATUS_RANK: Record<SessionStatus, number> = {
  waiting: 0,
  running: 1,
  activity: 2,
  complete: 3,
  idle: 4,
};

function cycle<T>(list: readonly T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length]!;
}

export function cycleSort(m: SortMode): SortMode {
  return cycle(SORT_MODES, m);
}

export function cycleFilter(f: FilterMode): FilterMode {
  return cycle(FILTER_MODES, f);
}

const SORT_LABELS: Record<SortMode, string> = {
  project: "by project",
  status: "by status",
  activity: "by activity",
  name: "by name",
};
const FILTER_LABELS: Record<FilterMode, string> = {
  all: "all",
  attention: "needs you",
  active: "active",
};

export function sortModeLabel(m: SortMode): string {
  return SORT_LABELS[m];
}
export function filterModeLabel(f: FilterMode): string {
  return FILTER_LABELS[f];
}

// Short, capitalised names for the compact header control ("Project", "Status", …).
const SORT_SHORT: Record<SortMode, string> = {
  project: "Project",
  status: "Status",
  activity: "Activity",
  name: "Name",
};
const FILTER_SHORT: Record<FilterMode, string> = {
  all: "All",
  attention: "Needs you",
  active: "Active",
};
export function sortModeShort(m: SortMode): string {
  return SORT_SHORT[m];
}
export function filterModeShort(f: FilterMode): string {
  return FILTER_SHORT[f];
}

export function matchesFilter(status: SessionStatus, filter: FilterMode): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return status === "waiting";
    case "active":
      return status === "waiting" || status === "running";
  }
}

/**
 * Order `indices` for a FLAT sort mode (status / activity / name). `project` is
 * a grouping concern handled by buildRenderPlan and is treated as a no-op here
 * (returns the indices unchanged) so a caller that passes it can't crash.
 * Never mutates the input.
 */
export function sortIndices(
  indices: number[],
  info: (i: number) => SessionSortInfo,
  mode: SortMode,
): number[] {
  const byName = (a: number, b: number) => info(a).name.localeCompare(info(b).name);
  const byRecency = (a: number, b: number) => info(b).lastActivity - info(a).lastActivity;

  let cmp: (a: number, b: number) => number;
  switch (mode) {
    case "status":
      cmp = (a, b) =>
        (STATUS_RANK[info(a).status] - STATUS_RANK[info(b).status]) ||
        byRecency(a, b) ||
        byName(a, b);
      break;
    case "activity":
      cmp = (a, b) => byRecency(a, b) || byName(a, b);
      break;
    case "name":
      cmp = byName;
      break;
    case "project":
      return [...indices];
  }
  return [...indices].sort(cmp);
}
