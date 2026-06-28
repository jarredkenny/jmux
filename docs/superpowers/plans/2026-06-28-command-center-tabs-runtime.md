# Command Center Tabs — Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Depends on:** `2026-06-28-command-center-tabs-foundation.md` must be merged/green first. This plan consumes its interfaces: `TabEntry`, `normalizeTabs`, `defaultTabId`, `resolveTabId`, `addTab`, `renameTab`, `deleteTab`, `moveTab`, `summarizeTabState` (`src/glass/tabs.ts`); `PaneState.pins` (`src/glass/reflect.ts`); `PinnedPaneTracker.getValue` (`src/glass/pinned-pane-tracker.ts`); `PaletteCommand.disabled`/`hint` (`src/types.ts`); `JmuxConfig.commandCenterTabs` (`src/config.ts`).

**Goal:** Wire named tabs into the live Command Center — `GlassView` tabId-tagged tiles with lazy keep-warm + active-tab render filter, a top tab-strip with summary dots, glass-scoped `Ctrl-a <n>` tab switching, strip click-routing, and the `main.ts` orchestration for pin/move/unpin/tab-CRUD/switch plus config-watch reload.

**Architecture:** One `GlassView` owns all warm tiles keyed by paneId, each tagged with `tabId`; the active tab is a render filter. Tiles spawn lazily on first visit to a tab and stay warm for the glass session. The strip renders in the glass's top rows (a pure `CellGrid` built by `src/glass/strip.ts`), composited above the tiles. Membership resolution runs through `resolveTabId` so legacy/unknown/auto pins fold to the default tab. Per the project rule, `GlassView` and `main.ts` wiring are verified by running jmux; all decision logic is extracted into pure, unit-tested helpers (`tile-plan.ts`, `strip.ts`, the input-router prefix/mouse paths, the palette command builder, the reload clamp).

**Tech Stack:** TypeScript (strict), Bun 1.3.8+, `bun:test`, `@xterm/headless` via `ScreenBridge`, `bun-pty` via `TmuxPty`. tmux 3.2+ at runtime.

## Global Constraints

- **Runtime is Bun, not Node.** Tests use `bun:test`. Never spawn tmux in a unit test — integration behavior is verified by running jmux (`bun run dev`).
- **Non-destructive invariant** — pin/move/unpin are *only* `@jmux-pinned` writes; tiles are live mirror clients (transient zoom restored on teardown). Never `break-pane`/`join-pane`/move a pane.
- **Default tab = index 0**, protected (non-deletable, never reordered out of 0). Legacy `"1"`/unknown/auto → default via `resolveTabId`.
- **Strip visible iff** `glassActive()` **and** the registry has ≥ 2 tabs. This is one shared predicate (`stripVisibleFor(tabs)` from Task 2), never recomputed independently.
- **`Ctrl-a <n>` is glass-scoped only.** Outside glass, tmux's normal `Ctrl-a <digit>` is untouched. `Ctrl-a [` must keep reaching the focused tile (copy-mode).
- **Active tab on entry** = in-memory last-active for the process; cold-start = first tab. Never persisted to disk.
- **No Claude attribution in git.**
- Tree must be green (`bun test && bun run typecheck`) at the end of every task.

---

### Task 1: Tile-plan reducer (lazy keep-warm + active filter)

**Files:**
- Create: `src/glass/tile-plan.ts`
- Create: `src/__tests__/glass/tile-plan.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface TilePlanSpec { paneId: string; tabId: string }`
  - `interface TilePlan { spawn: string[]; teardown: string[]; render: string[] }`
  - `function planTiles(all: ReadonlyArray<TilePlanSpec>, activeTabId: string, warm: ReadonlySet<string>): TilePlan` — `spawn` = active-tab paneIds not already warm; `teardown` = warm paneIds no longer present in `all`; `render` = active-tab paneIds present in `all`, in `all`-order. (Warm tiles in other tabs are kept — never torn down for leaving the active tab.)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/tile-plan.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { planTiles, type TilePlanSpec } from "../../glass/tile-plan";

const specs = (pairs: [string, string][]): TilePlanSpec[] =>
  pairs.map(([paneId, tabId]) => ({ paneId, tabId }));

describe("planTiles", () => {
  test("spawns active-tab panes that are not yet warm", () => {
    const all = specs([["%1", "default"], ["%2", "default"], ["%3", "backend"]]);
    const plan = planTiles(all, "default", new Set());
    expect(plan.spawn.sort()).toEqual(["%1", "%2"]);
    expect(plan.render).toEqual(["%1", "%2"]); // all-order, active tab only
  });

  test("keeps warm tiles from other tabs (no teardown on tab leave)", () => {
    const all = specs([["%1", "default"], ["%3", "backend"]]);
    const plan = planTiles(all, "backend", new Set(["%1"])); // %1 warm from default
    expect(plan.teardown).toEqual([]);          // %1 stays warm
    expect(plan.spawn).toEqual(["%3"]);         // backend's tile spawns
    expect(plan.render).toEqual(["%3"]);        // only active tab renders
  });

  test("tears down panes that left membership entirely", () => {
    const all = specs([["%1", "default"]]);
    const plan = planTiles(all, "default", new Set(["%1", "%9"])); // %9 unpinned
    expect(plan.teardown).toEqual(["%9"]);
    expect(plan.spawn).toEqual([]); // %1 already warm
  });

  test("does not re-spawn an already-warm active tile", () => {
    const all = specs([["%1", "default"]]);
    const plan = planTiles(all, "default", new Set(["%1"]));
    expect(plan.spawn).toEqual([]);
    expect(plan.render).toEqual(["%1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/glass/tile-plan.test.ts`
Expected: FAIL — `Cannot find module "../../glass/tile-plan"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/glass/tile-plan.ts`:

```typescript
export interface TilePlanSpec {
  paneId: string;
  tabId: string;
}

export interface TilePlan {
  /** Active-tab panes not yet warm — spawn these. */
  spawn: string[];
  /** Warm panes no longer in membership — tear these down. */
  teardown: string[];
  /** Active-tab panes to draw, in membership order. */
  render: string[];
}

/**
 * Decide tile lifecycle for lazy keep-warm. Active-tab panes spawn on first
 * visit; tiles stay warm across tab switches; only panes that leave membership
 * entirely are torn down. The active tab is a render filter over the warm set.
 */
export function planTiles(
  all: ReadonlyArray<TilePlanSpec>,
  activeTabId: string,
  warm: ReadonlySet<string>,
): TilePlan {
  const allIds = new Set(all.map((s) => s.paneId));
  const activeOrder = all.filter((s) => s.tabId === activeTabId).map((s) => s.paneId);

  const spawn = activeOrder.filter((id) => !warm.has(id));
  const teardown = [...warm].filter((id) => !allIds.has(id));
  const render = activeOrder;

  return { spawn, teardown, render };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/glass/tile-plan.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/glass/tile-plan.ts src/__tests__/glass/tile-plan.test.ts
git commit -m "feat(command-center): tile-plan reducer for lazy keep-warm + active filter"
```

---

### Task 2: Strip render plan (pure layout + grid + hit-test)

**Files:**
- Create: `src/glass/strip.ts`
- Create: `src/__tests__/glass/strip.test.ts`

**Interfaces:**
- Consumes: `TabEntry` (`./tabs`), `AgentState` (`../types`), `CellGrid`/`createGrid`/`writeString`/`ColorMode` (cell-grid/types), `Record<AgentState, number>` palette (`resolveStateColors` output).
- Produces:
  - `function stripVisibleFor(tabs: TabEntry[]): boolean` — `tabs.length >= 2`.
  - `const STRIP_ROWS = 1`.
  - `interface StripChip { tabId: string; x: number; width: number }`
  - `interface StripInput { tabs: TabEntry[]; activeTabId: string; summaryByTab: Map<string, AgentState | null>; width: number; palette: Record<AgentState, number> }`
  - `function layoutStrip(input: StripInput): StripChip[]` — chip x/width across the row, left to right, name + a dot when the tab has a summary state; truncates names to fit `width`.
  - `function renderStrip(input: StripInput): CellGrid` — a `width × STRIP_ROWS` grid; active chip bold, others dim; dot colored by `palette[summary]`.
  - `function chipAtX(chips: StripChip[], x: number): string | null` — tabId whose chip covers column `x`, else null.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/strip.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import {
  stripVisibleFor, layoutStrip, renderStrip, chipAtX, STRIP_ROWS,
} from "../../glass/strip";
import type { TabEntry, AgentState } from "../../glass/tabs";

const palette: Record<AgentState, number> = { running: 2, waiting: 3, complete: 4 };
const tabs: TabEntry[] = [
  { id: "default", name: "Main" },
  { id: "backend", name: "Backend" },
];

describe("stripVisibleFor", () => {
  test("hidden with one tab, shown with two+", () => {
    expect(stripVisibleFor([{ id: "default", name: "Main" }])).toBe(false);
    expect(stripVisibleFor(tabs)).toBe(true);
  });
});

describe("layoutStrip / chipAtX", () => {
  test("chips are laid out left to right and hit-test by x", () => {
    const chips = layoutStrip({
      tabs, activeTabId: "default",
      summaryByTab: new Map([["backend", "waiting"]]),
      width: 80, palette,
    });
    expect(chips.length).toBe(2);
    expect(chips[0].tabId).toBe("default");
    expect(chips[0].x).toBe(0);
    // first chip covers its own columns, second starts after it
    expect(chipAtX(chips, chips[0].x)).toBe("default");
    expect(chipAtX(chips, chips[1].x)).toBe("backend");
    expect(chipAtX(chips, 9999)).toBeNull();
  });
});

describe("renderStrip", () => {
  test("renders one row containing both tab names", () => {
    const grid = renderStrip({
      tabs, activeTabId: "default",
      summaryByTab: new Map([["backend", "running"]]),
      width: 80, palette,
    });
    expect(grid.rows).toBe(STRIP_ROWS);
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain("Main");
    expect(row).toContain("Backend");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/glass/strip.test.ts`
Expected: FAIL — `Cannot find module "../../glass/strip"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/glass/strip.ts`:

```typescript
import type { AgentState, CellGrid } from "../types";
import { ColorMode } from "../types";
import { createGrid, writeString, cellWidth } from "../cell-grid";
import type { TabEntry } from "./tabs";

export const STRIP_ROWS = 1;
const DOT = "●";
const GAP = 1; // blank column between chips

export interface StripChip {
  tabId: string;
  x: number;
  width: number;
}

export interface StripInput {
  tabs: TabEntry[];
  activeTabId: string;
  summaryByTab: Map<string, AgentState | null>;
  width: number;
  palette: Record<AgentState, number>;
}

/** The strip is hidden until there is more than one tab. */
export function stripVisibleFor(tabs: TabEntry[]): boolean {
  return tabs.length >= 2;
}

function chipText(name: string, hasDot: boolean): string {
  return hasDot ? ` ${name} ${DOT} ` : ` ${name} `;
}

function textCols(s: string): number {
  let n = 0;
  for (const ch of s) n += cellWidth(ch.codePointAt(0) ?? 0);
  return n;
}

export function layoutStrip(input: StripInput): StripChip[] {
  const chips: StripChip[] = [];
  let x = 0;
  for (const tab of input.tabs) {
    if (x >= input.width) break;
    const hasDot = (input.summaryByTab.get(tab.id) ?? null) !== null;
    const text = chipText(tab.name, hasDot);
    const w = Math.min(textCols(text), input.width - x);
    chips.push({ tabId: tab.id, x, width: w });
    x += w + GAP;
  }
  return chips;
}

export function chipAtX(chips: StripChip[], x: number): string | null {
  for (const c of chips) {
    if (x >= c.x && x < c.x + c.width) return c.tabId;
  }
  return null;
}

export function renderStrip(input: StripInput): CellGrid {
  const grid = createGrid(input.width, STRIP_ROWS);
  const chips = layoutStrip(input);
  for (const chip of chips) {
    const tab = input.tabs.find((t) => t.id === chip.tabId)!;
    const isActive = chip.tabId === input.activeTabId;
    const summary = input.summaryByTab.get(chip.tabId) ?? null;
    const hasDot = summary !== null;
    const text = chipText(tab.name, hasDot);

    // Base chip text: bold when active, dim otherwise.
    writeString(grid, 0, chip.x, text.slice(0, chip.width), {
      fgMode: ColorMode.Palette,
      fg: isActive ? 15 : 8,
      bold: isActive,
      dim: !isActive,
    });

    // Recolor the dot cell by the summary state.
    if (hasDot) {
      const dotCol = chip.x + text.indexOf(DOT);
      if (dotCol >= 0 && dotCol < input.width) {
        const cell = grid.cells[0][dotCol];
        cell.char = DOT;
        cell.width = 1;
        cell.fgMode = ColorMode.Palette;
        cell.fg = input.palette[summary as AgentState];
        cell.bold = isActive;
        cell.dim = false;
      }
    }
  }
  return grid;
}
```

> **Note on the `TabEntry`/`AgentState` import in the test:** the test imports both from `../../glass/tabs`. `tabs.ts` already re-exports neither by default — add `export type { AgentState } from "../types";` to the top of `src/glass/tabs.ts` if it isn't already re-exported, so the single import line in the test resolves. (`TabEntry` is defined in `tabs.ts`; `AgentState` is re-exported for test convenience.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/glass/strip.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/glass/strip.ts src/__tests__/glass/strip.test.ts src/glass/tabs.ts
git commit -m "feat(command-center): pure tab-strip layout, render, and hit-test"
```

---

### Task 3: Input router — glass-buffered prefix + `Ctrl-a <n>` tab switch

**Files:**
- Modify: `src/input-router.ts` — `InputRouterOptions` (add hooks), the `\x01` branch (`:211-219`), the `prefixSeen` block (`:168-220`)
- Modify: `src/__tests__/input-router.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `InputRouterOptions` gains `onGlassTabSwitch?: (index: number) => void`. New behavior, **glass-only**:
  - `\x01` is **buffered, not forwarded**, while `glassActive()`.
  - Next byte `1`–`9` → `onGlassTabSwitch(n)`, both bytes swallowed.
  - Next byte `p`/`n`/`i`/`I`/`d` → existing intercepts (palette/new-session/settings/settings-screen/detach), both bytes swallowed (the buffered `\x01` is dropped).
  - Any other next byte → flush the buffered `\x01` then the byte to the PTY (focused tile), preserving in-tile prefix bindings incl. copy-mode `[`.
  - Outside glass: unchanged (eager `\x01` forward + existing intercepts).

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/input-router.test.ts` (mirror the file's existing harness for building a router with stubbed callbacks; the snippet below shows the assertions — adapt the construction to the file's existing `makeRouter`/options helper):

```typescript
describe("glass-buffered prefix + Ctrl-a <n>", () => {
  test("Ctrl-a then digit switches tabs and forwards nothing to the tile", () => {
    const sent: string[] = [];
    const switched: number[] = [];
    const router = new InputRouter({
      sidebarCols: 26,
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
      onGlassTabSwitch: (n) => switched.push(n),
    }, true);
    router.handleInput("\x01");
    router.handleInput("2");
    expect(switched).toEqual([2]);
    expect(sent).toEqual([]); // neither byte reached the tile
  });

  test("Ctrl-a then an unrecognized key flushes prefix + key to the tile", () => {
    const sent: string[] = [];
    const router = new InputRouter({
      sidebarCols: 26,
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
    }, true);
    router.handleInput("\x01");
    router.handleInput("["); // tmux copy-mode in the tile
    expect(sent).toEqual(["\x01", "["]);
  });

  test("Ctrl-a then d detaches jmux and forwards nothing", () => {
    const sent: string[] = [];
    let detached = 0;
    const router = new InputRouter({
      sidebarCols: 26,
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
      onGlassDetach: () => detached++,
    }, true);
    router.handleInput("\x01");
    router.handleInput("d");
    expect(detached).toBe(1);
    expect(sent).toEqual([]); // buffered prefix dropped, not forwarded
  });
});
```

> If the existing input-router tests assert that `\x01` is forwarded to the PTY *while in glass* (the old glass-detach behavior), update those assertions: in glass, `\x01` is now buffered, not eagerly forwarded.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: FAIL — `onGlassTabSwitch` not a known option; in-glass `\x01` is forwarded eagerly so the digit/flush/detach expectations don't hold.

- [ ] **Step 3: Write minimal implementation**

In `src/input-router.ts`, add to `InputRouterOptions` (near the other glass hooks, after `onGlassDetach`):

```typescript
  onGlassTabSwitch?: (index: number) => void;       // glass-only Ctrl-a <n> → switch tab
```

Add a private field near the other prefix state (alongside `prefixSeen`):

```typescript
  private glassPrefixDeferred = false;
```

Replace the `\x01` branch (currently `} else if (data === "\x01") { ... }` at ~211-219):

```typescript
      } else if (data === "\x01") {
        this.prefixSeen = true;
        this.prefixTimer = setTimeout(() => { this.prefixSeen = false; this.prefixTimer = null; this.glassPrefixDeferred = false; }, 2000);
        if (this.opts.glassActive?.()) {
          // In glass, defer the prefix: the next byte decides whether it's a
          // jmux action, a tab digit, or a real in-tile prefix chord.
          this.glassPrefixDeferred = true;
        } else if (!this.diffPanelFocused || this.diffPanelCols === 0) {
          this.opts.onPtyData(data);
        }
        return;
      }
```

Replace the top of the `if (this.prefixSeen) {` block (the part from clearing `prefixSeen` through the `data === "d"` glass-detach line) so the glass case is handled first and self-contained:

```typescript
      if (this.prefixSeen) {
        this.prefixSeen = false;
        if (this.prefixTimer) { clearTimeout(this.prefixTimer); this.prefixTimer = null; }

        // Glass owns the post-prefix byte: digits switch tabs, jmux chords
        // intercept, everything else flushes the deferred prefix to the tile.
        if (this.opts.glassActive?.()) {
          const deferred = this.glassPrefixDeferred;
          this.glassPrefixDeferred = false;
          if (data >= "1" && data <= "9") {
            this.opts.onGlassTabSwitch?.(parseInt(data, 10));
            return;
          }
          if (data === "d") { this.opts.onGlassDetach?.(); return; }
          if (data === "p") { this.opts.onModalToggle?.(); return; }
          if (data === "n") { this.opts.onNewSession?.(); return; }
          if (data === "i") { this.opts.onSettings?.(); return; }
          if (data === "I") { this.opts.onSettingsScreen?.(); return; }
          // Not a jmux chord — flush the buffered prefix, then the key, to the tile.
          if (deferred) this.opts.onPtyData("\x01");
          this.opts.onPtyData(data);
          return;
        }

        // Non-glass: existing intercepts.
        if (data === "p") {
          this.opts.onModalToggle?.();
          return;
        }
```

Leave the rest of the non-glass `prefixSeen` block (the existing `n`/`i`/`I`/`g`/`z`/`\t`/diff-panel handling and the fall-through forward) unchanged below this point. (The old `if (data === "d" && this.opts.glassActive?.())` line is now subsumed by the glass branch above — delete that one line so `d` isn't double-handled.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/input-router.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/input-router.ts src/__tests__/input-router.test.ts
git commit -m "feat(command-center): glass-buffered prefix + Ctrl-a <n> tab switch"
```

---

### Task 4: Input router — strip mouse (cy offset + chip click)

**Files:**
- Modify: `src/input-router.ts` — glass mouse block (`:327-338`), `InputRouterOptions`
- Modify: `src/__tests__/input-router.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `InputRouterOptions` gains `glassStripRows?: () => number` (0 when the strip is hidden) and `onGlassTabClick?: (x: number) => void` (content-relative column of a click on the strip row). In the glass mouse path: when the click/scroll row falls within the strip rows, a button-down dispatches `onGlassTabClick(cx)` and returns; otherwise tile coordinates are computed with `cy` offset by the strip rows.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/input-router.test.ts`:

```typescript
describe("glass strip mouse routing", () => {
  // SGR press at row 1 (top), col 30 → content x = 30 - 26 - 1 = 3
  const press = (col: number, row: number) => `\x1b[<0;${col};${row}M`;

  test("a click on the strip row routes to onGlassTabClick", () => {
    const tabClicks: number[] = [];
    const tileClicks: Array<[number, number]> = [];
    const router = new InputRouter({
      sidebarCols: 26,
      onPtyData: () => {},
      onSidebarClick: () => {},
      glassActive: () => true,
      glassStripRows: () => 1,
      onGlassTabClick: (x) => tabClicks.push(x),
      onGlassClick: (x, y) => tileClicks.push([x, y]),
    }, true);
    router.handleInput(press(30, 1)); // row 1 = strip
    expect(tabClicks).toEqual([3]);
    expect(tileClicks).toEqual([]);
  });

  test("a click below the strip routes to the tile with cy offset by strip rows", () => {
    const tileClicks: Array<[number, number]> = [];
    const router = new InputRouter({
      sidebarCols: 26,
      onPtyData: () => {},
      onSidebarClick: () => {},
      glassActive: () => true,
      glassStripRows: () => 1,
      onGlassClick: (x, y) => tileClicks.push([x, y]),
      onGlassTabClick: () => {},
    }, true);
    router.handleInput(press(30, 5)); // row 5: cy = (5-1) - 1 stripRow = 3
    expect(tileClicks).toEqual([[3, 3]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: FAIL — `glassStripRows`/`onGlassTabClick` unknown; the strip click is treated as a tile click; the offset row is wrong.

- [ ] **Step 3: Write minimal implementation**

Add to `InputRouterOptions` (after `onGlassTabSwitch`):

```typescript
  glassStripRows?: () => number;                    // tab-strip row count (0 when hidden)
  onGlassTabClick?: (x: number) => void;            // content-relative click on the strip row
```

Replace the glass mouse block (`if (this.opts.glassActive?.()) { ... }` at ~327):

```typescript
      if (this.opts.glassActive?.()) {
        const stripRows = this.opts.glassStripRows?.() ?? 0;
        const cx = mouse.x - this.opts.sidebarCols - 1;
        const yInContent = mouse.y - 1; // 0-indexed within the content column
        const bareMotion = isMotion && (mouse.button & 0x03) === 3;
        if (bareMotion) return; // ignore hover motion (no button held)

        // Strip row: a button-down switches tabs; ignore wheel/release/motion here.
        if (yInContent < stripRows) {
          if (!mouse.release && !isMotion && !isWheel) {
            this.opts.onGlassTabClick?.(cx);
          }
          return;
        }

        const cy = yInContent - stripRows; // tile-area row
        if (!mouse.release && !isMotion && !isWheel) {
          this.opts.onGlassClick?.(cx, cy); // focus on button-down
        }
        this.opts.onGlassMouse?.(cx, cy, mouse.button, mouse.release);
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/input-router.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/input-router.ts src/__tests__/input-router.test.ts
git commit -m "feat(command-center): strip click routing + tile cy offset in glass"
```

---

### Task 5: GlassView — tabId specs, lazy keep-warm, active-tab filter

**Files:**
- Modify: `src/glass/view.ts` — `GlassTileSpec` (add `tabId`), `setTiles` signature + lifecycle, render/focus filtering, add `setActiveTab`
- Verify: by running jmux (no unit test — `GlassView` spawns real PTYs; the decision logic is unit-tested in Task 1's `planTiles`).

**Interfaces:**
- Consumes: `planTiles`, `TilePlan`, `TilePlanSpec` (Task 1).
- Produces:
  - `GlassTileSpec` gains `tabId: string`.
  - `setTiles(specs: GlassTileSpec[], activeTabId: string): void` — full membership across all tabs + the active tab; spawns/keeps/tears down per `planTiles`; lays out and focuses only the active tab's tiles, in `specs` order.
  - `setActiveTab(activeTabId: string): void` — switch the render filter (spawning the tab's tiles on first visit via the cached last `specs`), keeping other tabs warm.
  - `focusedPaneId()`, `moveFocus`, `forwardMouse`, `focusAt`, `getFocusedCursor`, `writeFocused` operate over the **active tab's** tiles only.

- [ ] **Step 1: Extend the spec type and store membership + active tab**

In `src/glass/view.ts`, extend `GlassTileSpec`:

```typescript
export interface GlassTileSpec {
  paneId: string;
  sessionId: string;
  windowId: string;
  label: string;
  agentState?: AgentState | null;
  tabId: string; // which Command Center tab this tile belongs to
}
```

Add fields to the class (near `tileOrder`/`focusedIndex`):

```typescript
  private allSpecs: GlassTileSpec[] = []; // full membership across all tabs
  private activeTabId = "";
```

- [ ] **Step 2: Rewrite `setTiles` to use `planTiles` and filter to the active tab**

Replace the body of `setTiles` with a version that: stores `allSpecs`/`activeTabId`; computes the plan against the current warm set (`this.tiles.keys()`); spawns/tears-down accordingly; then sets `tileOrder` to the active tab's render order. Import at the top of the file:

```typescript
import { planTiles } from "./tile-plan";
```

```typescript
  setTiles(specs: GlassTileSpec[], activeTabId: string): void {
    this.allSpecs = specs;
    this.activeTabId = activeTabId;

    const warm = new Set(this.tiles.keys());
    const plan = planTiles(
      specs.map((s) => ({ paneId: s.paneId, tabId: s.tabId })),
      activeTabId,
      warm,
    );

    // Tear down panes that left membership entirely.
    for (const paneId of plan.teardown) this.teardownTile(paneId);

    // Spawn newly-visible active-tab panes; update labels for survivors.
    const specById = new Map(specs.map((s) => [s.paneId, s]));
    for (const paneId of plan.spawn) {
      const spec = specById.get(paneId);
      if (spec) this.ensureTile(spec);
    }
    for (const [paneId, tile] of this.tiles) {
      const spec = specById.get(paneId);
      if (spec) tile.spec = spec; // refresh label/agentState/tabId
    }

    // Active tab is the render/focus order.
    this.tileOrder = plan.render;
    if (this.tileOrder.length > 0) {
      this.focusedIndex = Math.min(this.focusedIndex, this.tileOrder.length - 1);
    } else {
      this.focusedIndex = 0;
    }
    this.resizeAllTiles();
  }

  /** Switch the active tab's render filter, spawning its tiles on first visit. */
  setActiveTab(activeTabId: string): void {
    this.focusedIndex = 0;
    this.setTiles(this.allSpecs, activeTabId);
  }
```

> `resizeAllTiles`, `getGrid`, `moveFocus`, `focusAt`, `forwardMouse`, `getFocusedCursor`, `writeFocused`, `focusedPaneId` already iterate `this.tileOrder` — now the active-tab subset — so they need no change. `teardown()` still tears down every entry in `this.tiles` (the whole warm set), which is correct on leaving glass.

- [ ] **Step 3: Typecheck (callers will break until Task 6)**

Run: `bun run typecheck`
Expected: FAIL only at the `main.ts` call sites of `setTiles(specs)` (now requires a second arg) and `GlassTileSpec` literals missing `tabId`. These are fixed in Task 6. If any *other* file breaks, that's unexpected — investigate before proceeding.

- [ ] **Step 4: Run the glass-adjacent unit tests**

Run: `bun test src/__tests__/glass/`
Expected: PASS (tile-plan, strip, tabs, reflect, tracker, pane-label all green; `view.ts` has no unit test).

- [ ] **Step 5: Commit**

```bash
git add src/glass/view.ts
git commit -m "feat(command-center): GlassView tabId tiles, lazy keep-warm, active-tab filter"
```

---

### Task 6: main.ts — tab-aware membership, strip render, geometry, last-active tab

**Files:**
- Modify: `src/main.ts` — `refreshPinnedPanes` (`:3764-3830`), the glass render block (`:1138-1151`), `resizeGlass` (`:3848-3854`), `enterGlass` (`:3856-3871`), module state (near `glassView` at `:609-611`), input-router construction (the `onGlass*` options block near `:1430-1440`)
- Verify: by running jmux + the pure helpers already tested.

**Interfaces:**
- Consumes: `normalizeTabs`, `defaultTabId`, `resolveTabId`, `summarizeTabState` (tabs.ts); `PinnedPaneTracker.getValue`; `PaneState.pins`; `stripVisibleFor`, `renderStrip`, `STRIP_ROWS`, `layoutStrip`, `chipAtX` (strip.ts); `GlassView.setTiles(specs, activeTabId)`/`setActiveTab`; `resolveStateColors`.
- Produces: module-level `commandCenterTabs: TabEntry[]`, `activeTabId: string`, `lastActiveTabId: string`; a `currentStripChips` cache for click hit-testing; the tab-aware tile/strip pipeline.

- [ ] **Step 1: Add module state and a tabs accessor**

Near the glass state (`let glassView: GlassView | null = null;` at ~611), add:

```typescript
let commandCenterTabs: TabEntry[] = normalizeTabs(configStore.config.commandCenterTabs);
let activeTabId: string = defaultTabId(commandCenterTabs);
let lastActiveTabId: string = activeTabId;
let currentStripChips: import("./glass/strip").StripChip[] = [];
```

Add the imports at the top of `main.ts` (with the other `./glass/*` imports):

```typescript
import { normalizeTabs, defaultTabId, resolveTabId, summarizeTabState, type TabEntry } from "./glass/tabs";
import { stripVisibleFor, renderStrip, layoutStrip, chipAtX, STRIP_ROWS } from "./glass/strip";
```

- [ ] **Step 2: Make `refreshPinnedPanes` tab-aware**

In `refreshPinnedPanes` (`:3764`), change the tracker apply to pass the **raw value** (Foundation Task 5), build `tabId` per spec via `resolveTabId`, and compute the per-tab summary. Replace the tracker-apply loop and the spec-building tail:

```typescript
  // Reflect raw @jmux-pinned values into the tracker (value, not just presence).
  for (const paneId of state.live.keys()) {
    pinnedTracker.apply(paneId, state.pins.get(paneId) ?? null);
  }
  pinnedTracker.pruneExcept([...state.live.keys()]);
```

In the spec-building loop, set `tabId` from the pane's raw value (auto-detected panes have no value → default):

```typescript
  const entries: PinnedPaneEntry[] = [];
  const specs: GlassTileSpec[] = [];
  const stateByTab = new Map<string, (AgentState | null)[]>();
  for (const paneId of orderedPaneIds) {
    const loc = state.live.get(paneId)!;
    const meta = labelByPane.get(paneId)!;
    const agentState = agentStateTracker.getState(loc.sessionId);
    const tabId = resolveTabId(pinnedTracker.getValue(paneId) ?? null, commandCenterTabs);
    entries.push({ paneId, homeSessionName: meta.sessionName, label: meta.label, agentState });
    specs.push({ paneId, sessionId: loc.sessionId, windowId: loc.windowId, label: meta.label, agentState, tabId });
    const arr = stateByTab.get(tabId) ?? [];
    arr.push(agentState);
    stateByTab.set(tabId, arr);
  }
  sidebar.setPinnedPanes(entries);

  // Per-tab summary for the strip dots.
  summaryByTab = new Map<string, AgentState | null>();
  for (const tab of commandCenterTabs) {
    summaryByTab.set(tab.id, summarizeTabState(stateByTab.get(tab.id) ?? []));
  }

  if (inGlass) glassView?.setTiles(specs, activeTabId);
  scheduleRender();
```

Add a module-level `let summaryByTab = new Map<string, AgentState | null>();` near the other glass state, and ensure `AgentState` is imported in `main.ts` (it already imports from `./types` for other uses; add `AgentState` to that import if missing).

- [ ] **Step 3: Render the strip + reduce glass height + offset cursor**

Replace the glass render block (`:1138-1151`):

```typescript
  if (inGlass && glassView) {
    const sidebarGrid = sidebarShown ? sidebar.getGrid() : null;
    const overlay = computeModalOverlay();
    const stripVisible = stripVisibleFor(commandCenterTabs);
    const totalCols = process.stdout.columns || 80;
    const contentCols = sidebarShown ? totalCols - sidebarTotal() : totalCols;

    let content = glassView.getGrid();
    let cursor = glassView.getFocusedCursor() ?? { x: 0, y: 0 };

    if (stripVisible) {
      const palette = resolveStateColors(configStore.config.stateColors);
      const stripInput = { tabs: commandCenterTabs, activeTabId, summaryByTab, width: contentCols, palette };
      currentStripChips = layoutStrip(stripInput);
      const strip = renderStrip(stripInput);
      const combined = createGrid(contentCols, (process.stdout.rows || 24));
      // Blit strip on top rows, glass content below.
      for (let r = 0; r < STRIP_ROWS && r < combined.rows; r++)
        for (let c = 0; c < contentCols; c++) combined.cells[r][c] = strip.cells[r][c];
      for (let r = 0; r < content.rows && r + STRIP_ROWS < combined.rows; r++)
        for (let c = 0; c < content.cols && c < contentCols; c++) combined.cells[r + STRIP_ROWS][c] = content.cells[r][c];
      content = combined;
      cursor = { x: cursor.x, y: cursor.y + STRIP_ROWS };
    } else {
      currentStripChips = [];
    }

    renderer.render(content, cursor, sidebarGrid, null, overlay?.grid ?? null, overlay?.cursor ?? null, undefined);
    return;
  }
```

Ensure `createGrid` is imported in `main.ts` (from `./cell-grid`); add it if not present.

Update `resizeGlass` (`:3848`) to reserve the strip rows:

```typescript
function resizeGlass(): void {
  if (!glassView) return;
  const totalCols = process.stdout.columns || 80;
  const contentCols = sidebarShown ? totalCols - sidebarTotal() : totalCols;
  const stripRows = stripVisibleFor(commandCenterTabs) ? STRIP_ROWS : 0;
  const contentRows = (process.stdout.rows || 24) - stripRows;
  glassView.resize(contentCols, contentRows);
}
```

- [ ] **Step 4: Set the active tab on entry (last-active memory) and wire strip mouse/switch**

In `enterGlass` (`:3856`), restore the last-active tab (clamped to a still-existing tab) before building tiles:

```typescript
  // Restore last-active tab; fall back to default if it no longer exists.
  activeTabId = commandCenterTabs.some((t) => t.id === lastActiveTabId)
    ? lastActiveTabId
    : defaultTabId(commandCenterTabs);
```

(place this right after `inGlass = true;`). The existing `refreshPinnedPanes()` call later in `enterGlass` will build tiles for `activeTabId`.

Add a tab-switch helper near `enterGlass`:

```typescript
function switchCommandCenterTab(tabId: string): void {
  if (!commandCenterTabs.some((t) => t.id === tabId)) return;
  activeTabId = tabId;
  lastActiveTabId = tabId;
  glassView?.setActiveTab(tabId);
  scheduleRender();
}
```

In the input-router options object (the block with `glassActive`, `onGlassClick`, `onGlassMouse` near `:1430`), add:

```typescript
    glassStripRows: () => (inGlass && stripVisibleFor(commandCenterTabs) ? STRIP_ROWS : 0),
    onGlassTabClick: (x) => { const id = chipAtX(currentStripChips, x); if (id) switchCommandCenterTab(id); },
    onGlassTabSwitch: (n) => { const tab = commandCenterTabs[n - 1]; if (tab) switchCommandCenterTab(tab.id); },
```

- [ ] **Step 5: Typecheck + run the suite**

Run: `bun run typecheck && bun test`
Expected: PASS (the Task 5 caller breakage is now resolved). Any remaining `GlassTileSpec` literal missing `tabId` is a bug — fix it.

- [ ] **Step 6: Manual verification (run jmux)**

```bash
bun run dev
```
Verify, with two agents pinned to two different tabs (use `jmux ctl pane pin --target %X --tab backend` from a sibling pane, after Task 7 of Foundation):
- The strip appears only once a 2nd tab exists; one tab → no strip, full-height grid (unchanged from today).
- Clicking a chip switches tabs; the clicked tab's tiles appear; the previous tab's tiles disappear but the agents keep running.
- `Ctrl-a 2` switches to the 2nd tab; `Ctrl-a [` still enters copy-mode *inside* the focused tile (no stray prefix corruption).
- Leaving and re-entering the Command Center returns to the last-active tab.
- Tile cursor lands correctly (no off-by-one from the strip row).

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat(command-center): tab-aware tiles, strip render, geometry, last-active tab"
```

---

### Task 7: main.ts — palette command set (context-aware) + pin/move/unpin/CRUD dispatch

**Files:**
- Create: `src/glass/cc-commands.ts` (pure command-list builder)
- Create: `src/__tests__/glass/cc-commands.test.ts`
- Modify: `src/main.ts` — the palette command build (the pin/unpin-pane region `:2074-2085`), the command dispatch (`:2705-2719` and the static `switch`)
- Verify: builder by unit test; dispatch by running jmux.

**Interfaces:**
- Consumes: `TabEntry` (tabs.ts), `PaletteCommand`/`PaletteSublistOption` (types.ts).
- Produces:
  - `const NEW_TAB_OPTION_ID = "__new_tab__"`
  - `interface CcCommandInput { inGlass: boolean; tabs: TabEntry[]; activeTabId: string; tabCounts: Map<string, number>; focusedPaneId: string | null; focusedTabId: string | null; focusedIsAuto: boolean; sessionActivePinned: boolean; }`
  - `function buildCcCommands(input: CcCommandInput): PaletteCommand[]` — the Command-Center-related palette entries for the current context (does **not** include unrelated session/window commands; those stay where they are in `main.ts`). Command ids: `pin-pane` (sublist: tabs + new), `unpin-pane`, `move-tile` (sublist: other tabs + new), `unpin-tile` (disabled+hint when `focusedIsAuto`), `new-cc-tab`, `rename-cc-tab`, `delete-cc-tab`, `move-tab-left`, `move-tab-right`, `switch-cc-tab` (sublist: tabs).
  - A `tabSublist(tabs, counts, { excludeId? })` helper producing `PaletteSublistOption[]` ending with `{ id: NEW_TAB_OPTION_ID, label: "+ New tab…" }`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/cc-commands.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { buildCcCommands, NEW_TAB_OPTION_ID, type CcCommandInput } from "../../glass/cc-commands";
import type { TabEntry } from "../../glass/tabs";

const tabs: TabEntry[] = [
  { id: "default", name: "Main" },
  { id: "backend", name: "Backend" },
];
const counts = new Map([["default", 1], ["backend", 2]]);

const base: CcCommandInput = {
  inGlass: false, tabs, activeTabId: "default", tabCounts: counts,
  focusedPaneId: null, focusedTabId: null, focusedIsAuto: false,
  sessionActivePinned: false,
};

const ids = (cmds: { id: string }[]) => cmds.map((c) => c.id);

describe("buildCcCommands — session context", () => {
  test("offers a fused pin picker (tabs + new) when the active pane is unpinned", () => {
    const cmds = buildCcCommands(base);
    const pin = cmds.find((c) => c.id === "pin-pane")!;
    expect(pin).toBeTruthy();
    expect(pin.sublist!.map((o) => o.label)).toContain("Main (1)");
    expect(pin.sublist!.map((o) => o.label)).toContain("Backend (2)");
    expect(pin.sublist!.at(-1)).toEqual({ id: NEW_TAB_OPTION_ID, label: "+ New tab…" });
    expect(ids(cmds)).not.toContain("unpin-pane");
  });

  test("offers unpin when the active pane is already pinned", () => {
    const cmds = buildCcCommands({ ...base, sessionActivePinned: true });
    expect(ids(cmds)).toContain("unpin-pane");
    expect(ids(cmds)).not.toContain("pin-pane");
  });

  test("does not offer tile-targeted commands outside glass", () => {
    expect(ids(buildCcCommands(base))).not.toContain("move-tile");
    expect(ids(buildCcCommands(base))).not.toContain("unpin-tile");
  });
});

describe("buildCcCommands — glass context", () => {
  const glass: CcCommandInput = {
    ...base, inGlass: true, activeTabId: "backend",
    focusedPaneId: "%5", focusedTabId: "backend", focusedIsAuto: false,
  };

  test("move-tile excludes the current tab and ends with + New tab…", () => {
    const cmds = buildCcCommands(glass);
    const move = cmds.find((c) => c.id === "move-tile")!;
    expect(move.sublist!.map((o) => o.id)).not.toContain("backend"); // current tab excluded
    expect(move.sublist!.map((o) => o.id)).toContain("default");
    expect(move.sublist!.at(-1)!.id).toBe(NEW_TAB_OPTION_ID);
  });

  test("unpin-tile is enabled for a manual pin", () => {
    const cmd = buildCcCommands(glass).find((c) => c.id === "unpin-tile")!;
    expect(cmd.disabled).toBeFalsy();
  });

  test("unpin-tile is a disabled hinted row for an auto-pinned tile", () => {
    const cmd = buildCcCommands({ ...glass, focusedIsAuto: true }).find((c) => c.id === "unpin-tile")!;
    expect(cmd.disabled).toBe(true);
    expect(cmd.hint).toMatch(/auto-pinned/i);
  });

  test("tile-targeted commands are hidden when there is no focused tile", () => {
    const cmds = buildCcCommands({ ...glass, focusedPaneId: null });
    expect(ids(cmds)).not.toContain("move-tile");
    expect(ids(cmds)).not.toContain("unpin-tile");
  });

  test("move-tab-left is hidden for the first non-default tab; right offered when room", () => {
    // active = backend (index 1, the only non-default) → left would cross default
    const cmds = buildCcCommands(glass);
    expect(ids(cmds)).not.toContain("move-tab-left");
    expect(ids(cmds)).not.toContain("move-tab-right"); // no tab to the right
  });

  test("switch-cc-tab lists all tabs", () => {
    const cmd = buildCcCommands(glass).find((c) => c.id === "switch-cc-tab")!;
    expect(cmd.sublist!.map((o) => o.id)).toEqual(["default", "backend"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/glass/cc-commands.test.ts`
Expected: FAIL — `Cannot find module "../../glass/cc-commands"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/glass/cc-commands.ts`:

```typescript
import type { PaletteCommand, PaletteSublistOption } from "../types";
import type { TabEntry } from "./tabs";

export const NEW_TAB_OPTION_ID = "__new_tab__";

export interface CcCommandInput {
  inGlass: boolean;
  tabs: TabEntry[];
  activeTabId: string;
  tabCounts: Map<string, number>;
  focusedPaneId: string | null;
  focusedTabId: string | null;
  focusedIsAuto: boolean;
  sessionActivePinned: boolean;
}

function tabSublist(
  tabs: TabEntry[],
  counts: Map<string, number>,
  opts?: { excludeId?: string },
): PaletteSublistOption[] {
  const out: PaletteSublistOption[] = [];
  for (const t of tabs) {
    if (opts?.excludeId && t.id === opts.excludeId) continue;
    out.push({ id: t.id, label: `${t.name} (${counts.get(t.id) ?? 0})` });
  }
  out.push({ id: NEW_TAB_OPTION_ID, label: "+ New tab…" });
  return out;
}

export function buildCcCommands(input: CcCommandInput): PaletteCommand[] {
  const cmds: PaletteCommand[] = [];
  const { tabs, activeTabId, tabCounts } = input;

  if (input.inGlass) {
    if (input.focusedPaneId) {
      cmds.push({
        id: "move-tile", label: "Move tile to tab…", category: "command center",
        sublist: tabSublist(tabs, tabCounts, { excludeId: input.focusedTabId ?? undefined }),
      });
      if (input.focusedIsAuto) {
        cmds.push({
          id: "unpin-tile", label: "Unpin tile", category: "command center",
          disabled: true, hint: "auto-pinned; disable auto-pin or it returns",
        });
      } else {
        cmds.push({ id: "unpin-tile", label: "Unpin tile", category: "command center" });
      }
    }
    // Tab management (active-tab subject).
    cmds.push({ id: "new-cc-tab", label: "New Command Center tab…", category: "command center" });
    cmds.push({ id: "rename-cc-tab", label: "Rename current tab…", category: "command center" });
    cmds.push({ id: "delete-cc-tab", label: "Delete current tab", category: "command center" });

    const activeIdx = tabs.findIndex((t) => t.id === activeTabId);
    if (activeIdx > 1) cmds.push({ id: "move-tab-left", label: "Move tab left", category: "command center" });
    if (activeIdx >= 1 && activeIdx < tabs.length - 1)
      cmds.push({ id: "move-tab-right", label: "Move tab right", category: "command center" });
  } else {
    // Session context: pin (fused) or unpin the active pane.
    if (input.sessionActivePinned) {
      cmds.push({ id: "unpin-pane", label: "Unpin from Command Center", category: "command center" });
    } else {
      cmds.push({
        id: "pin-pane", label: "Pin to Command Center", category: "command center",
        sublist: tabSublist(tabs, tabCounts),
      });
    }
  }

  // Switch-to-tab is available everywhere.
  cmds.push({
    id: "switch-cc-tab", label: "Switch to Command Center tab…", category: "command center",
    sublist: tabs.map((t) => ({ id: t.id, label: `${t.name} (${tabCounts.get(t.id) ?? 0})`, current: t.id === activeTabId })),
  });

  return cmds;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/glass/cc-commands.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit the builder**

```bash
git add src/glass/cc-commands.ts src/__tests__/glass/cc-commands.test.ts
git commit -m "feat(command-center): context-aware palette command builder"
```

- [ ] **Step 6: Wire the builder into `main.ts` command list**

In `main.ts`, replace the existing inline pin/unpin-pane block (`:2074-2085`) with a call to `buildCcCommands`, supplying the live inputs. First compute the focused-tile context and tab counts:

```typescript
  // Command Center commands (context-aware: in-glass vs session).
  {
    const focusedPaneId = inGlass ? (glassView?.focusedPaneId() ?? null) : null;
    const focusedTabId = focusedPaneId
      ? resolveTabId(pinnedTracker.getValue(focusedPaneId) ?? null, commandCenterTabs)
      : null;
    const focusedIsAuto = focusedPaneId ? !pinnedTracker.has(focusedPaneId) : false;
    let sessionActivePinned = false;
    if (!inGlass && currentSessionId) {
      const activePane = glassRunner.run(["display-message", "-p", "-t", currentSessionId, "#{pane_id}"]).lines[0];
      sessionActivePinned = activePane ? pinnedTracker.has(activePane) : false;
    }
    const tabCounts = new Map<string, number>();
    for (const tab of commandCenterTabs) tabCounts.set(tab.id, 0);
    for (const paneId of pinnedTracker.all())
      { const tid = resolveTabId(pinnedTracker.getValue(paneId) ?? null, commandCenterTabs); tabCounts.set(tid, (tabCounts.get(tid) ?? 0) + 1); }
    commands.push(...buildCcCommands({
      inGlass, tabs: commandCenterTabs, activeTabId, tabCounts,
      focusedPaneId, focusedTabId, focusedIsAuto, sessionActivePinned,
    }));
  }
```

Add the import of `buildCcCommands` and `NEW_TAB_OPTION_ID` to `main.ts`:

```typescript
import { buildCcCommands, NEW_TAB_OPTION_ID } from "./glass/cc-commands";
```

> `focusedIsAuto` is "pinned on screen but not in the tracker" — i.e. an auto-detected pane (the tracker only holds panes with a real `@jmux-pinned` option). A manually-pinned tile is in the tracker; an auto tile is not.

- [ ] **Step 7: Wire the dispatch**

In the command dispatch (the `pin-pane`/`unpin-pane` block at `:2705`, and the static `switch`), handle the new command ids and their sublist results. The palette returns `{ commandId, sublistOptionId? }`. Replace/extend dispatch:

```typescript
  // Pin the current session's active pane to a chosen/created tab.
  if (commandId === "pin-pane" || commandId === "move-tile") {
    const paneId = commandId === "pin-pane"
      ? glassRunner.run(["display-message", "-p", "-t", currentSessionId!, "#{pane_id}"]).lines[0]
      : (glassView?.focusedPaneId() ?? null);
    if (!paneId) return;
    const applyTab = (tabId: string) => {
      for (const cmd of buildPinCommands("pin", paneId, tabId)) glassRunner.run(cmd.args);
      if (commandId === "move-tile") switchCommandCenterTab(tabId); // follow the moved tile
      refreshPinnedPanes();
    };
    if (sublistOptionId === NEW_TAB_OPTION_ID) {
      openInputModalForNewTab((newTabId) => applyTab(newTabId));
    } else if (sublistOptionId) {
      applyTab(sublistOptionId);
    }
    return;
  }

  if (commandId === "unpin-pane" || commandId === "unpin-tile") {
    const paneId = commandId === "unpin-tile"
      ? (glassView?.focusedPaneId() ?? null)
      : glassRunner.run(["display-message", "-p", "-t", currentSessionId!, "#{pane_id}"]).lines[0];
    if (!paneId) return;
    for (const cmd of buildPinCommands("unpin", paneId)) glassRunner.run(cmd.args);
    refreshPinnedPanes();
    return;
  }

  if (commandId === "switch-cc-tab" && sublistOptionId) {
    if (!inGlass) { await enterGlass(); }
    switchCommandCenterTab(sublistOptionId);
    return;
  }

  if (commandId === "new-cc-tab") { openInputModalForNewTab((id) => switchCommandCenterTab(id)); return; }
  if (commandId === "rename-cc-tab") { openInputModalForRenameTab(); return; }
  if (commandId === "delete-cc-tab") { tryDeleteActiveTab(); return; }
  if (commandId === "move-tab-left" || commandId === "move-tab-right") {
    persistTabs(moveTab(commandCenterTabs, activeTabId, commandId === "move-tab-left" ? "left" : "right"));
    scheduleRender();
    return;
  }
```

Add the helper functions near `switchCommandCenterTab`:

```typescript
function persistTabs(next: TabEntry[]): void {
  commandCenterTabs = next;
  configStore.set("commandCenterTabs", next);
  // Clamp active/last-active if they vanished.
  if (!next.some((t) => t.id === activeTabId)) activeTabId = defaultTabId(next);
  if (!next.some((t) => t.id === lastActiveTabId)) lastActiveTabId = defaultTabId(next);
  if (inGlass) refreshPinnedPanes();
}

function openInputModalForNewTab(then: (tabId: string) => void): void {
  const modal = new InputModal({ header: "New tab name", placeholder: "e.g. Backend" });
  modal.open();
  openModal(modal, (value) => {
    const result = addTab(commandCenterTabs, String(value));
    if (!result.ok) { showTransient(result.error); return; }
    const created = result.tabs[result.tabs.length - 1];
    persistTabs(result.tabs);
    then(created.id);
  });
}

function openInputModalForRenameTab(): void {
  const current = commandCenterTabs.find((t) => t.id === activeTabId);
  if (!current) return;
  const modal = new InputModal({ header: "Rename tab", value: current.name });
  modal.open();
  openModal(modal, (value) => {
    const result = renameTab(commandCenterTabs, activeTabId, String(value));
    if (!result.ok) { showTransient(result.error); return; }
    persistTabs(result.tabs);
  });
}

function tryDeleteActiveTab(): void {
  const memberCount = pinnedTracker.all().filter(
    (p) => resolveTabId(pinnedTracker.getValue(p) ?? null, commandCenterTabs) === activeTabId,
  ).length;
  const result = deleteTab(commandCenterTabs, activeTabId, memberCount);
  if (!result.ok) { showTransient(result.error); return; }
  persistTabs(result.tabs);
  switchCommandCenterTab(defaultTabId(commandCenterTabs));
}
```

Add the imports to `main.ts`:

```typescript
import { addTab, renameTab, deleteTab, moveTab } from "./glass/tabs";
import { InputModal } from "./input-modal";
```

(`InputModal` is likely already imported; reuse it. `showTransient` — use the project's existing transient-message mechanism; if none exists in `main.ts`, surface errors via a short-lived `ContentModal` as used elsewhere. Find the existing pattern with `grep -n "showNewSessionError\|ContentModal" src/main.ts` and mirror it; do not invent a new toast system.)

Ensure `sublistOptionId` is in scope in the dispatch function — the palette result carries it (`PaletteResult.sublistOptionId`); thread it from where `commandId` is destructured.

- [ ] **Step 8: Typecheck + suite + manual verification**

Run: `bun run typecheck && bun test`
Expected: PASS.

Manual (`bun run dev`):
- From a session: palette → "Pin to Command Center" → pick "Backend" or "+ New tab…" → pane appears in that tab.
- In glass: palette → "Move tile to tab…" excludes the current tab, follows the tile to the destination tab.
- In glass on an auto-pinned tile: "Unpin tile" shows disabled with the hint and does nothing on Enter; "Move tile to tab…" promotes it (it becomes a manual pin and persists).
- "Delete current tab" refuses with a message when the tab has tiles; works after they're moved/unpinned; default tab refuses always.
- "New/Rename tab" validates (empty/dup/too-long rejected with a message).

- [ ] **Step 9: Commit**

```bash
git add src/main.ts
git commit -m "feat(command-center): palette dispatch for pin/move/unpin + tab CRUD/switch"
```

---

### Task 8: main.ts — config-watch registry reload

**Files:**
- Create: `src/glass/reload.ts` (pure clamp helper)
- Create: `src/__tests__/glass/reload.test.ts`
- Modify: `src/main.ts` — the `configWatcher` reload handler (`:3341-3375`)
- Verify: clamp by unit test; reload by running jmux.

**Interfaces:**
- Consumes: `TabEntry`, `normalizeTabs`, `defaultTabId`.
- Produces: `function clampTabSelection(tabs: TabEntry[], activeId: string, lastActiveId: string): { activeTabId: string; lastActiveTabId: string }` — keeps each id if still present, else folds to the default.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/reload.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { clampTabSelection } from "../../glass/reload";
import type { TabEntry } from "../../glass/tabs";

const tabs: TabEntry[] = [{ id: "default", name: "Main" }, { id: "backend", name: "Backend" }];

describe("clampTabSelection", () => {
  test("keeps ids that still exist", () => {
    expect(clampTabSelection(tabs, "backend", "backend")).toEqual({
      activeTabId: "backend", lastActiveTabId: "backend",
    });
  });
  test("folds vanished ids to the default", () => {
    expect(clampTabSelection(tabs, "ghost", "gone")).toEqual({
      activeTabId: "default", lastActiveTabId: "default",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/glass/reload.test.ts`
Expected: FAIL — `Cannot find module "../../glass/reload"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/glass/reload.ts`:

```typescript
import { defaultTabId, type TabEntry } from "./tabs";

/** Keep active/last-active tab ids that still exist; fold vanished ones to default. */
export function clampTabSelection(
  tabs: TabEntry[],
  activeId: string,
  lastActiveId: string,
): { activeTabId: string; lastActiveTabId: string } {
  const has = (id: string) => tabs.some((t) => t.id === id);
  const def = defaultTabId(tabs);
  return {
    activeTabId: has(activeId) ? activeId : def,
    lastActiveTabId: has(lastActiveId) ? lastActiveId : def,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/glass/reload.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Wire reload into the config watcher**

In `main.ts`, inside the `configWatcher` callback (after `const updated = configStore.reload();`, near the `stateColors` hot-apply at `:3365`), add the registry reload:

```typescript
    // Reload the Command Center tab registry (palette CRUD + hand-edits land here).
    {
      const before = stripVisibleFor(commandCenterTabs);
      commandCenterTabs = normalizeTabs(updated.commandCenterTabs);
      const clamped = clampTabSelection(commandCenterTabs, activeTabId, lastActiveTabId);
      activeTabId = clamped.activeTabId;
      lastActiveTabId = clamped.lastActiveTabId;
      if (inGlass) {
        refreshPinnedPanes();         // re-fold vanished tab ids; rebuild specs + summary
        glassView?.setActiveTab(activeTabId);
      }
      const after = stripVisibleFor(commandCenterTabs);
      if (before !== after) { resizeGlass(); }  // strip appeared/disappeared → glass height changed
      scheduleRender();
    }
```

Add the import:

```typescript
import { clampTabSelection } from "./glass/reload";
```

- [ ] **Step 6: Typecheck + suite + manual verification**

Run: `bun run typecheck && bun test`
Expected: PASS.

Manual (`bun run dev`): with the Command Center open, edit `~/.config/jmux/config.json` to add a 2nd tab → the strip appears live; delete it down to one → the strip disappears and the grid reclaims the row; rename a tab → chip updates; remove a tab that a pane points at → that pane re-folds to the default tab.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts src/glass/reload.ts src/__tests__/glass/reload.test.ts
git commit -m "feat(command-center): hot-reload tab registry on config change"
```

---

### Task 9: Same-window-zoom regression guard + docs

**Files:**
- Create: `src/__tests__/glass/view-zoom-note.md` (documented manual regression — `GlassView` can't be unit-tested without tmux)
- Modify: `CONTEXT.md` (glossary), `docs/adr/` (new ADR), `config/` docs if present
- Verify: documented manual test + docs review.

**Interfaces:**
- Consumes: nothing.
- Produces: a written, repeatable manual regression for the same-window zoom collision, plus the doc updates the spec calls for.

- [ ] **Step 1: Write the manual regression note**

Create `src/__tests__/glass/view-zoom-note.md`:

```markdown
# Manual regression: same-window zoom under lazy keep-warm

GlassView spawns real tmux clients, so this can't be a unit test (project rule:
tests never spawn tmux). Run it by hand after any change to GlassView tiling.

## Setup
1. Create a session with TWO panes in ONE window: `tmux split-window`.
2. Pin BOTH panes to DIFFERENT tabs:
   - `jmux ctl pane pin --target %A --tab default`
   - `jmux ctl pane pin --target %B --tab backend`
3. Open the Command Center.

## Steps
- Switch to the "default" tab (Ctrl-a 1): tile %A renders zoomed/full-bleed.
- Switch to "backend" (Ctrl-a 2): tile %B renders; %A stays warm.
- Switch back to "default": %A still renders correctly (no lost zoom, no blank tile).

## Pass criteria
- Neither pane's home window is left in a broken zoom state on teardown
  (leave the Command Center → both panes visible side-by-side again).
- No pane is moved/broken (non-destructive invariant holds).

## Known limitation
Two panes in the SAME window cannot both be full-bleed at once (zoom is
window-global). When both are pinned (to any tabs), only the active-tab tile
zooms; this is expected, not a bug. Prefer one-agent-per-session.
```

- [ ] **Step 2: Run the manual regression**

```bash
bun run dev
```
Follow `view-zoom-note.md`. Confirm all pass criteria.

- [ ] **Step 3: Update docs**

- `CONTEXT.md` glossary: add **Tab** (registry-backed named bucket, id-keyed, one per pane) and **Default tab** (protected index 0, fallback bucket); update **Pin** to "`@jmux-pinned` holds a tab id, not `1`".
- `docs/adr/`: add a short ADR — "Command Center tab membership = stable id on the pane + name/order in the config registry" with the rename-fan-out-avoidance rationale (id, not name, on the pane).
- If `config/` or site docs enumerate config fields, add `commandCenterTabs`.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/glass/view-zoom-note.md CONTEXT.md docs/adr/
git commit -m "docs(command-center): tab glossary, ADR, same-window-zoom regression note"
```

---

## Self-Review

**Spec coverage (Runtime scope):**
- Lazy keep-warm + active-tab filter → Task 1 (`planTiles`, unit-tested) + Task 5 (`GlassView`).
- Strip: single-tab hide, name + summary dot, active/dim, truncation, hit-test → Task 2 (pure) + Task 6 (render/geometry).
- Buffered glass prefix + `Ctrl-a <n>` (the spec's input-router blocker) → Task 3.
- Strip click routing + cy offset (geometry gap) → Task 4 + Task 6.
- `refreshPinnedPanes` raw-value→`resolveTabId`→`tabId` spec + per-tab summary (third blocker seam, `main.ts:3769`) → Task 6 Step 2.
- Strip render in glass path, reduced height, cursor offset → Task 6 Step 3.
- Last-active tab in-memory, cold-start default → Task 6 Step 4.
- Context-aware palette set; pin fused pick-or-create; move (excl current); unpin (disabled+hint for auto); tab CRUD/reorder/switch → Task 7.
- Config-watch registry reload + clamp + stripVisible resize → Task 8.
- Same-window-zoom regression + doc impact (ADR, CONTEXT, config docs) → Task 9.

**Placeholder scan:** the only deferral is `showTransient` in Task 7, which explicitly instructs the implementer to grep for and reuse the existing error-surfacing pattern (`showNewSessionError`/`ContentModal`) rather than invent one — a direction to a real, existing seam, not a TODO. All code steps contain complete code.

**Type consistency:** `TilePlanSpec`/`planTiles` (Task 1) consumed by `GlassView.setTiles` (Task 5). `GlassTileSpec.tabId` (Task 5) produced by `refreshPinnedPanes` (Task 6). `stripVisibleFor`/`renderStrip`/`layoutStrip`/`chipAtX`/`STRIP_ROWS` (Task 2) consumed by Task 6 (render) and Task 6's input-router options. `onGlassTabSwitch` (Task 3) + `glassStripRows`/`onGlassTabClick` (Task 4) wired in Task 6 Step 4. `buildCcCommands`/`NEW_TAB_OPTION_ID` (Task 7) drive Task 7 dispatch. `clampTabSelection` (Task 8) used in the watcher. `switchCommandCenterTab`/`persistTabs`/`refreshPinnedPanes` are the shared mutation seams across Tasks 6–8.

## Execution Handoff

Both plans are complete:
- `2026-06-28-command-center-tabs-foundation.md` — pure logic + CLI (execute first).
- `2026-06-28-command-center-tabs-runtime.md` — glass runtime + wiring (this plan).
