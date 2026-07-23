# Sidebar filter & sort

## Problem

With many agents running in parallel the sidebar scrolls, so the sessions that
need you — the ones **waiting** for input — can be anywhere in a project-grouped
list. There is no way to reorder or narrow the list by what an agent is doing.

## Scope

Add a **sort mode** and an independent **filter mode** to the sidebar.

- **Sort** (cycle `project → status → activity → name`):
  - `project` *(default)* — today's grouped-by-project list, unchanged.
  - `status` — **flat** list ranked waiting → running → activity → complete →
    idle; within a tier, most-recently-active first.
  - `activity` — flat, most-recently-active first.
  - `name` — flat, A–Z.
- **Filter** (cycle `all → attention → active`):
  - `all` *(default)* — everything.
  - `attention` — waiting only.
  - `active` — running or waiting.

Sort and filter are independent and combine. Command Center stays pinned at the
top always (it is navigation, not a session).

### Decisions (approved)

- **Flat sort dissolves project groups.** `status`/`activity`/`name` produce one
  flat list so a waiting agent rises to the very top regardless of project.
  Only `project` mode is grouped.
- **Pins do not float in flat sort.** A pinned *running* session must not sit
  above a *waiting* one, or "waiting rises to the top" would be a lie. The
  Pinned group exists only in `project` mode.
- **Sort persists; filter is ephemeral.** Sort mode is saved to config and
  survives restart. Filter resets to `all` on launch — a persisted filter that
  hides sessions is the "where did my sessions go?" trap. The header always
  names an active filter.
- **Invocation:** `Ctrl-a s` cycles sort, `Ctrl-a f` cycles filter (shadowing
  tmux's redundant `Ctrl-a s` choose-session). Plus `Sort by…` / `Filter…`
  submenus in the `Ctrl-a p` palette.

## Design

### `src/sidebar-sort.ts` (new, pure)

The whole sort/filter policy lives here as pure functions over a small info
struct, so it is unit-testable without the Sidebar, the grid, or tmux.

```ts
export type SortMode = "project" | "status" | "activity" | "name";
export type FilterMode = "all" | "attention" | "active";
export type SessionStatus = "waiting" | "running" | "activity" | "complete" | "idle";

export interface SessionSortInfo { name: string; status: SessionStatus; lastActivity: number }

export const SORT_MODES: readonly SortMode[];
export const FILTER_MODES: readonly FilterMode[];
export function cycleSort(m: SortMode): SortMode;      // wraps around SORT_MODES
export function cycleFilter(m: FilterMode): FilterMode;
export function sortModeLabel(m: SortMode): string;    // "by status", …
export function filterModeLabel(m: FilterMode): string;// "needs you", …
export function matchesFilter(status: SessionStatus, f: FilterMode): boolean;
/** Order indices for a FLAT mode (status/activity/name); project is grouping, handled by the plan. */
export function sortIndices(indices: number[], info: (i: number) => SessionSortInfo, mode: SortMode): number[];
```

Status rank: `waiting 0, running 1, activity 2, complete 3, idle 4`.
- `status`: rank asc → `lastActivity` desc → name asc.
- `activity`: `lastActivity` desc → name asc.
- `name`: name asc.

`SessionStatus` is `AgentState` (running/waiting/complete) plus `activity` (tmux
output, no promoted state) plus `idle` (nothing) — the same distinction the row
dots already make, so the rollup, the dots, and the sort all agree.

### `buildRenderPlan` (in `src/sidebar.ts`)

Gains `sortInfos: SessionSortInfo[]`, `sortMode`, `filterMode`. The partition
loop skips any session where `!matchesFilter(status, filterMode)`, so filtered
sessions never bucket and empty groups never emit.

- `project`: existing grouped emission over the (now filtered) buckets.
- flat modes: Command Center + spacer, then **all** filtered indices
  (`pinned + groups + ungrouped`) merged, `sortIndices`-ordered, emitted as flat
  sessions (`grouped: false`) with spacers. No group headers, no Pinned group.
  `displayOrder` follows the sorted order so keyboard nav matches.

The Sidebar derives each session's `SessionSortInfo` from its own maps:
`status = agentStateRecords.get(id)?.state ?? (activitySet.has(id) ? "activity" : "idle")`;
`lastActivity = max(agentStateRecord.since, otel lastRequestTime, session.activity)`.

### Sidebar state, header, invocation

- `private sortMode: SortMode = "project"`, `private filterMode: FilterMode = "all"`.
- `setSortMode` / `cycleSortMode` / `setFilterMode` / `cycleFilterMode` — each
  rebuilds the plan and re-clamps scroll; `cycle*` return the new mode so the
  caller can persist/report it.
- **Header** reads `Sessions  ⇅ <Mode>  <rollup>`: a static `Sessions` label, a
  clickable `⇅ <Mode>` control (`Project`/`Status`/`Activity`/`Name`) in
  accent-muted, and an active filter as a dim ` · <Filter>` suffix. The state
  rollup stays right-aligned, degrading to the waiting-count alone, then
  dropping, as width tightens (the mode control always wins — it is the more
  actionable fact). **Clicking the `⇅ <Mode>` control cycles the sort** (the
  icon or the mode name), so sort has a mouse affordance, not just a keybind.
  This needs the click *column*, so `onSidebarClick` gains a `col` arg and the
  sidebar exposes `headerSortToggleHit(row, col)`.
- **input-router**: `Ctrl-a s` → `onSortCycle`, `Ctrl-a f` → `onFilterCycle`,
  added alongside the existing `p`/`n`/`i` chords (both glass and non-glass
  paths).
- Switching sort/filter resets the scroll to the top — the point of sorting by
  status is to see what rose, not to chase the active session (and it avoids a
  stale scroll offset bleeding a row up into the header separator).
- **palette**: `buildPaletteCommands` gains a `Sort by…` command whose `sublist`
  is the four sort modes, and a `Filter…` command whose sublist is the three
  filters; `handlePaletteAction` routes the chosen id to the setters.

### Config

`JmuxConfig` gains `sidebarSort?: SortMode` (validated against `SORT_MODES`,
falling back to `project`). Loaded at startup into the Sidebar; written whenever
sort changes. No `sidebarFilter` field — filter is ephemeral by decision.

## Testing

- `src/__tests__/sidebar-sort.test.ts` (new) — `cycle*` wrap-around,
  `matchesFilter` truth table, and `sortIndices` for each flat mode including
  the tie-breaks (two waiting sessions order by recency; equal recency by name).
- `src/__tests__/sidebar.test.ts` (extend) — status sort puts a waiting session
  above a running one across projects (flat, groups gone); the `attention`
  filter hides non-waiting sessions and Command Center still shows;
  `project` mode + `attention` filter hides empty groups; the header names the
  active sort/filter.
- `src/__tests__/config.test.ts` (extend) — `sidebarSort` validates and falls
  back.

## Out of scope

- A `done` filter, a search box, or custom sort orders — the cycle is
  extensible later.
- Persisting the filter (deliberate — see decisions).
