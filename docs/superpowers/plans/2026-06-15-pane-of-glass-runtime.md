# Pane of Glass — Runtime, UI & Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan depends on the foundation plan being complete and green** (`docs/superpowers/plans/2026-06-15-pane-of-glass-foundation.md`).

**Goal:** Build the live pane-of-glass runtime on top of the proven foundation — execute the reconciler's break/join decisions against real tmux, render N pinned panes as live composited tiles, wire the `@jmux-pinned` reflection, add the Overview sidebar entry, and revise the design docs.

**Architecture:** A pure-where-possible split: tmux command *builders* and layout *math* are unit-tested; a `GlassExecutor` (injected runner + record store) sequences break/join/restore and is unit-tested with fakes; only the live multiplexing — N `TmuxPty` + `ScreenBridge` tiles composited by the renderer, and tile-focus input routing — is integration code verified by a manual tmux smoke test, per the project's "tests don't spawn tmux" rule.

**Tech Stack:** TypeScript (strict), Bun 1.3.8+ (`bun:test`, `bun-pty`, `@xterm/headless`), tmux 3.6a.

**Companion spec:** `docs/superpowers/specs/2026-06-15-pane-of-glass-pane-pinning-design.md` (commit a3c84c8).

**Reused from the foundation plan:** `src/glass/internal-sessions.ts` (`GLASS_HOLDING_SESSION`, `PARK_SESSION`, `tileSessionName`, `isInternalSession`, `INTERNAL_SESSION_FILTER`), `src/glass/types.ts` (`PinnedPaneRecord`, `PaneLocation`, `ReconcileAction`, `RestorePlan`), `src/glass/pinned-pane-tracker.ts` (`PinnedPaneTracker`), `src/glass/reconciler.ts` (`reconcilePins`, `planRestore`), and the `pinnedPanes` config field.

---

## File Structure

**New files:**
- `src/glass/pane-label.ts` — `buildPaneLabel` (pure tile/sidebar label).
- `src/glass/layout.ts` — `computeTileLayout` (pure column/row math).
- `src/glass/commands.ts` — pure tmux command builders for checkout/restore.
- `src/glass/executor.ts` — `GlassExecutor` (sequences actions via injected runner + store).
- `src/glass/view.ts` — `GlassView` (owns N `TmuxPty` + `ScreenBridge`, composites tiles, routes input).
- Test files mirroring each under `src/__tests__/glass/`.

**Modified files:**
- `src/sidebar.ts` — Overview entry, nested pinned-pane rows, `(N pinned)` marker, selection union.
- `src/__tests__/sidebar.test.ts` — new render-plan assertions.
- `src/renderer.ts` — composite a tile grid into the main area; toolbar-null path.
- `src/input-router.ts` — tile hit-testing, focused-tile routing, `Shift+arrow` / `Ctrl-a z` gating.
- `src/main.ts` — bootstrap holding/park sessions, subscribe `@jmux-pinned`, drive executor, mount `GlassView`, hide toolbar + park main client in glass, persist selected view.
- `docs/adr/0001-pane-of-glass-live-composited-clients.md`, `docs/adr/0002-pin-state-in-tmux-option.md`, `CONTEXT.md` — doc revisions.

---

## Task 1: Pane label builder

**Files:**
- Create: `src/glass/pane-label.ts`
- Test: `src/__tests__/glass/pane-label.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/pane-label.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { buildPaneLabel } from "../../glass/pane-label";

describe("buildPaneLabel", () => {
  test("prefers a non-empty pane title", () => {
    expect(
      buildPaneLabel({
        sessionName: "api",
        paneTitle: "claude",
        paneCurrentCommand: "node",
        paneCurrentPath: "/repo/api",
      }),
    ).toBe("api › claude");
  });

  test("falls back to command · cwd-basename when title is empty", () => {
    expect(
      buildPaneLabel({
        sessionName: "api",
        paneTitle: "",
        paneCurrentCommand: "node",
        paneCurrentPath: "/repo/api/server",
      }),
    ).toBe("api › node · server");
  });

  test("handles a missing path basename gracefully", () => {
    expect(
      buildPaneLabel({
        sessionName: "web",
        paneTitle: "",
        paneCurrentCommand: "bun",
        paneCurrentPath: "/",
      }),
    ).toBe("web › bun");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/glass/pane-label.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/glass/pane-label.ts`:

```typescript
import { basename } from "path";

export interface PaneLabelInput {
  sessionName: string;
  paneTitle: string;
  paneCurrentCommand: string;
  paneCurrentPath: string;
}

/**
 * Human label for a pinned pane, shown in the tile border and the sidebar's
 * Overview children. Prefers the pane title (programs like Claude set it);
 * otherwise "command · cwd-basename" disambiguates two node/bun panes in one
 * session.
 */
export function buildPaneLabel(input: PaneLabelInput): string {
  const { sessionName, paneTitle, paneCurrentCommand, paneCurrentPath } = input;
  const title = paneTitle.trim();
  if (title) return `${sessionName} › ${title}`;
  const base = basename(paneCurrentPath);
  const suffix = base && base !== "/" ? `${paneCurrentCommand} · ${base}` : paneCurrentCommand;
  return `${sessionName} › ${suffix}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/__tests__/glass/pane-label.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/glass/pane-label.ts src/__tests__/glass/pane-label.test.ts
git commit -m "feat(glass): pure pane-label builder"
```

---

## Task 2: Tile layout math

**Files:**
- Create: `src/glass/layout.ts`
- Test: `src/__tests__/glass/layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/layout.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { computeTileLayout } from "../../glass/layout";

const BASE = { minTileWidth: 80, minTileHeight: 10, focusedIndex: 0, scrollRow: 0 };

describe("computeTileLayout", () => {
  test("narrow terminal → single full-width column", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 3, mainWidth: 100, mainHeight: 90 });
    expect(l.columns).toBe(1);
    expect(l.tiles.every((t) => t.width === 100)).toBe(true);
  });

  test("wide terminal → multiple columns, never below the width floor", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 4, mainWidth: 250, mainHeight: 60 });
    expect(l.columns).toBe(3); // floor(250/80)=3
    expect(l.tiles.every((t) => t.width >= 80)).toBe(true);
  });

  test("columns clamp to tile count (no 3 columns for 1 tile)", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 1, mainWidth: 250, mainHeight: 60 });
    expect(l.columns).toBe(1);
  });

  test("rows pack after columns fill", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 5, mainWidth: 250, mainHeight: 60 });
    expect(l.columns).toBe(3);
    expect(l.rows).toBe(2); // ceil(5/3)
  });

  test("overflow scrolls and keeps the focused tile visible", () => {
    // 6 tiles, 1 column, each min height 10, screen height 25 → 2 rows visible.
    const l = computeTileLayout({
      ...BASE,
      tileCount: 6,
      mainWidth: 100,
      mainHeight: 25,
      focusedIndex: 5,
      scrollRow: 0,
    });
    expect(l.columns).toBe(1);
    const focused = l.tiles[5];
    expect(focused.visible).toBe(true); // scrolled into view
    expect(l.tiles[0].visible).toBe(false); // first row scrolled off
  });

  test("tiles fill the height when everything fits (no scroll)", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 2, mainWidth: 100, mainHeight: 40 });
    expect(l.scrollRow).toBe(0);
    expect(l.tiles.every((t) => t.visible)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/glass/layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/glass/layout.ts`:

```typescript
export interface TileLayoutInput {
  tileCount: number;
  mainWidth: number;
  mainHeight: number;
  minTileWidth: number;
  minTileHeight: number;
  focusedIndex: number;
  scrollRow: number;
}

export interface TileRect {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface TileLayout {
  columns: number;
  rows: number;
  scrollRow: number;
  tiles: TileRect[];
}

/**
 * Width-floored column layout. columns = clamp(floor(width/minTileWidth)) but
 * never more than the tile count; rows pack after columns fill. When more tile
 * rows exist than fit at the min height, the glass scrolls vertically and the
 * focused tile's row is kept in view.
 */
export function computeTileLayout(input: TileLayoutInput): TileLayout {
  const { tileCount, mainWidth, mainHeight, minTileWidth, minTileHeight, focusedIndex } = input;

  const columns = Math.max(1, Math.min(tileCount, Math.floor(mainWidth / minTileWidth) || 1));
  const totalRows = Math.max(1, Math.ceil(tileCount / columns));
  const tileWidth = Math.floor(mainWidth / columns);

  const visibleRows = Math.max(1, Math.floor(mainHeight / minTileHeight));
  const rowsOnScreen = Math.min(totalRows, visibleRows);
  const tileHeight = Math.floor(mainHeight / rowsOnScreen);

  // Keep the focused tile's row within [scrollRow, scrollRow + visibleRows).
  const focusedRow = Math.floor(focusedIndex / columns);
  const maxScroll = Math.max(0, totalRows - visibleRows);
  let scrollRow = Math.min(Math.max(0, input.scrollRow), maxScroll);
  if (focusedRow < scrollRow) scrollRow = focusedRow;
  else if (focusedRow >= scrollRow + visibleRows) scrollRow = focusedRow - visibleRows + 1;

  const tiles: TileRect[] = [];
  for (let i = 0; i < tileCount; i++) {
    const row = Math.floor(i / columns);
    const col = i % columns;
    const visible = row >= scrollRow && row < scrollRow + visibleRows;
    tiles.push({
      index: i,
      x: col * tileWidth,
      y: (row - scrollRow) * tileHeight,
      width: tileWidth,
      height: tileHeight,
      visible,
    });
  }

  return { columns, rows: totalRows, scrollRow, tiles };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/__tests__/glass/layout.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/glass/layout.ts src/__tests__/glass/layout.test.ts
git commit -m "feat(glass): pure tile layout math"
```

---

## Task 3: tmux command builders for checkout/restore

Pure builders so every break/join/select-layout command shape is unit-tested, even though execution is integration.

**Files:**
- Create: `src/glass/commands.ts`
- Test: `src/__tests__/glass/commands.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/commands.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import {
  captureLayoutCommand,
  breakPaneCommand,
  buildRestoreCommands,
} from "../../glass/commands";
import type { PinnedPaneRecord, RestorePlan } from "../../glass/types";

const REC: PinnedPaneRecord = {
  paneId: "%7",
  homeSessionId: "$2",
  homeWindowId: "@5",
  homeLayout: "savedlayout",
};

describe("checkout commands", () => {
  test("captureLayoutCommand reads the home window layout", () => {
    expect(captureLayoutCommand("@5")).toEqual([
      "display-message", "-p", "-t", "@5", "#{window_layout}",
    ]);
  });

  test("breakPaneCommand breaks the pane into the holding session, printing the new window id", () => {
    expect(breakPaneCommand("%7", "__jmux_glass")).toEqual([
      "break-pane", "-d", "-P", "-F", "#{window_id}", "-s", "%7", "-t", "__jmux_glass:",
    ]);
  });
});

describe("buildRestoreCommands", () => {
  test("rejoinWindow → join-pane + select-layout", () => {
    const plan: RestorePlan = { mode: "rejoinWindow", windowId: "@5", layout: "savedlayout" };
    expect(buildRestoreCommands(REC, plan, { holdingWindowId: "@99", newSessionName: "api" })).toEqual([
      ["join-pane", "-s", "%7", "-t", "@5"],
      ["select-layout", "-t", "@5", "savedlayout"],
    ]);
  });

  test("newWindowInSession → break the pane back as a new window of the home session", () => {
    const plan: RestorePlan = { mode: "newWindowInSession", sessionId: "$2" };
    expect(buildRestoreCommands(REC, plan, { holdingWindowId: "@99", newSessionName: "api" })).toEqual([
      ["break-pane", "-d", "-s", "%7", "-t", "$2:"],
    ]);
  });

  test("newSession → new placeholder session, move the holding window in, kill placeholder", () => {
    const plan: RestorePlan = { mode: "newSession" };
    expect(buildRestoreCommands(REC, plan, { holdingWindowId: "@99", newSessionName: "api" })).toEqual([
      ["new-session", "-d", "-s", "api", "-n", "__placeholder"],
      ["move-window", "-s", "@99", "-t", "api:"],
      ["kill-window", "-t", "api:__placeholder"],
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/glass/commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/glass/commands.ts`:

```typescript
import type { PinnedPaneRecord, RestorePlan } from "./types";

/** Read a window's layout string so it can be restored exactly on unpin. */
export function captureLayoutCommand(homeWindowId: string): string[] {
  return ["display-message", "-p", "-t", homeWindowId, "#{window_layout}"];
}

/** Break a pane out into a new window of the holding session, printing the new window id. */
export function breakPaneCommand(paneId: string, holdingSession: string): string[] {
  return ["break-pane", "-d", "-P", "-F", "#{window_id}", "-s", paneId, "-t", `${holdingSession}:`];
}

export interface RestoreContext {
  /** The pane's current (holding) window id — needed for the newSession move. */
  holdingWindowId: string;
  /** Sanitized, user-visible name for the newSession branch. */
  newSessionName: string;
}

/**
 * Commands to bring a checked-out pane home, per the chosen RestorePlan.
 * Never kills the pane's process.
 */
export function buildRestoreCommands(
  record: PinnedPaneRecord,
  plan: RestorePlan,
  ctx: RestoreContext,
): string[][] {
  switch (plan.mode) {
    case "rejoinWindow":
      return [
        ["join-pane", "-s", record.paneId, "-t", plan.windowId],
        ["select-layout", "-t", plan.windowId, plan.layout],
      ];
    case "newWindowInSession":
      return [["break-pane", "-d", "-s", record.paneId, "-t", `${plan.sessionId}:`]];
    case "newSession":
      return [
        ["new-session", "-d", "-s", ctx.newSessionName, "-n", "__placeholder"],
        ["move-window", "-s", ctx.holdingWindowId, "-t", `${ctx.newSessionName}:`],
        ["kill-window", "-t", `${ctx.newSessionName}:__placeholder`],
      ];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/__tests__/glass/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/glass/commands.ts src/__tests__/glass/commands.test.ts
git commit -m "feat(glass): pure tmux command builders for checkout/restore"
```

---

## Task 4: Pinned-reflection parse helper

Parses the live pane→`@jmux-pinned` map (used by the reflection wiring in Task 7) and the pane→location map the reconciler needs.

**Files:**
- Create: `src/glass/reflect.ts`
- Test: `src/__tests__/glass/reflect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/reflect.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { parsePaneStateLines, PANE_STATE_FORMAT } from "../../glass/reflect";

describe("parsePaneStateLines", () => {
  test("splits pane id, pinned flag, session id, window id", () => {
    const { pinned, live } = parsePaneStateLines([
      "%1\x1f1\x1f$2\x1f@5",
      "%2\x1f\x1f$2\x1f@6",
      "%3\x1f1\x1f$glass\x1f@9",
    ]);
    expect([...pinned].sort()).toEqual(["%1", "%3"]);
    expect(live.get("%1")).toEqual({ sessionId: "$2", windowId: "@5" });
    expect(live.get("%3")).toEqual({ sessionId: "$glass", windowId: "@9" });
  });

  test("ignores blank lines", () => {
    const { live } = parsePaneStateLines(["", "%9\x1f1\x1f$1\x1f@1", ""]);
    expect(live.size).toBe(1);
  });

  test("PANE_STATE_FORMAT requests the four fields, US-separated", () => {
    expect(PANE_STATE_FORMAT).toBe("#{pane_id}\x1f#{@jmux-pinned}\x1f#{session_id}\x1f#{window_id}");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/glass/reflect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/glass/reflect.ts`:

```typescript
import type { PaneLocation } from "./types";

const US = "\x1f";

/** Format for `list-panes -a -F` to read pin flag + location for every pane. */
export const PANE_STATE_FORMAT =
  `#{pane_id}${US}#{@jmux-pinned}${US}#{session_id}${US}#{window_id}`;

export interface PaneState {
  pinned: Set<string>;
  live: Map<string, PaneLocation>;
}

/** Parse `list-panes -a -F PANE_STATE_FORMAT` output into pinned set + location map. */
export function parsePaneStateLines(lines: string[]): PaneState {
  const pinned = new Set<string>();
  const live = new Map<string, PaneLocation>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const [paneId, pin, sessionId, windowId] = line.split(US);
    if (!paneId) continue;
    live.set(paneId, { sessionId: sessionId ?? "", windowId: windowId ?? "" });
    if (pin === "1") pinned.add(paneId);
  }
  return { pinned, live };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/__tests__/glass/reflect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/glass/reflect.ts src/__tests__/glass/reflect.test.ts
git commit -m "feat(glass): pane-state reflection parser"
```

---

## Task 5: GlassExecutor (sequences actions via injected runner + store)

Turns `ReconcileAction[]` into tmux side effects, in the crash-safe order from the
spec (persist record **before** break; drop record **after** restore). Injected
`runner` + `store` make the orchestration unit-testable without real tmux.

**Files:**
- Create: `src/glass/executor.ts`
- Test: `src/__tests__/glass/executor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/executor.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { GlassExecutor } from "../../glass/executor";
import type { GlassRunner, RecordStore } from "../../glass/executor";
import type { PinnedPaneRecord, ReconcileAction } from "../../glass/types";

class FakeRunner implements GlassRunner {
  calls: string[][] = [];
  responses: ((args: string[]) => string[]) = () => [];
  run(args: string[]): { ok: boolean; lines: string[] } {
    this.calls.push(args);
    return { ok: true, lines: this.responses(args) };
  }
}

class FakeStore implements RecordStore {
  map = new Map<string, PinnedPaneRecord>();
  events: string[] = [];
  get(): PinnedPaneRecord[] { return [...this.map.values()]; }
  put(r: PinnedPaneRecord): void { this.map.set(r.paneId, r); this.events.push(`put:${r.paneId}`); }
  remove(id: string): void { this.map.delete(id); this.events.push(`remove:${id}`); }
}

describe("GlassExecutor", () => {
  test("checkout: persists the record BEFORE breaking the pane", () => {
    const runner = new FakeRunner();
    runner.responses = (args) =>
      args[0] === "display-message" ? ["thelayout"] :
      args[0] === "break-pane" ? ["@77"] : [];
    const store = new FakeStore();
    const ex = new GlassExecutor({
      runner, store,
      holdingSession: "__jmux_glass",
      holdingSessionId: "$glass",
    });

    const actions: ReconcileAction[] = [
      { type: "checkout", paneId: "%7", home: { sessionId: "$2", windowId: "@5" } },
    ];
    ex.apply(actions);

    // record persisted with captured layout
    expect(store.map.get("%7")).toEqual({
      paneId: "%7", homeSessionId: "$2", homeWindowId: "@5", homeLayout: "thelayout",
    });
    // ordering: put happens before the break-pane command runs
    const putIdx = store.events.indexOf("put:%7");
    const breakIdx = runner.calls.findIndex((c) => c[0] === "break-pane");
    const layoutIdx = runner.calls.findIndex((c) => c[0] === "display-message");
    expect(putIdx).toBe(0);
    expect(layoutIdx).toBeLessThan(breakIdx);
  });

  test("restore: rejoins home then drops the record AFTER success", () => {
    const runner = new FakeRunner();
    runner.responses = (args) => {
      if (args[0] === "list-windows") return ["@5"];     // home window alive
      if (args[0] === "list-sessions") return ["$2"];
      if (args[0] === "display-message") return ["@88"]; // current holding window id
      return [];
    };
    const store = new FakeStore();
    const rec: PinnedPaneRecord = {
      paneId: "%7", homeSessionId: "$2", homeWindowId: "@5", homeLayout: "L",
    };
    store.put(rec);
    store.events.length = 0;
    const ex = new GlassExecutor({ runner, store, holdingSession: "__jmux_glass", holdingSessionId: "$glass" });

    ex.apply([{ type: "restore", record: rec }]);

    const joinIdx = runner.calls.findIndex((c) => c[0] === "join-pane");
    const removeIdx = store.events.indexOf("remove:%7");
    expect(joinIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    // record dropped only after the join ran (events recorded post-run)
    expect(store.map.has("%7")).toBe(false);
  });

  test("discardRecord: removes the record, runs no tmux mutation", () => {
    const runner = new FakeRunner();
    const store = new FakeStore();
    store.put({ paneId: "%7", homeSessionId: "$2", homeWindowId: "@5", homeLayout: "L" });
    store.events.length = 0;
    const ex = new GlassExecutor({ runner, store, holdingSession: "__jmux_glass", holdingSessionId: "$glass" });

    ex.apply([{ type: "discardRecord", paneId: "%7" }]);

    expect(store.map.has("%7")).toBe(false);
    expect(runner.calls.filter((c) => c[0] !== "list-windows" && c[0] !== "list-sessions")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/glass/executor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/glass/executor.ts`:

```typescript
import { planRestore } from "./reconciler";
import { captureLayoutCommand, breakPaneCommand, buildRestoreCommands } from "./commands";
import { sanitizeTmuxSessionName } from "../config";
import type { PinnedPaneRecord, ReconcileAction } from "./types";

export interface GlassRunner {
  run(args: string[]): { ok: boolean; lines: string[] };
}

export interface RecordStore {
  get(): PinnedPaneRecord[];
  put(record: PinnedPaneRecord): void;
  remove(paneId: string): void;
}

export interface GlassExecutorOptions {
  runner: GlassRunner;
  store: RecordStore;
  holdingSession: string;
  holdingSessionId: string;
}

/**
 * Executes the pure reconciler's decisions against tmux, in the crash-safe order
 * from the spec: persist the home record before break-pane; drop it only after a
 * successful restore. Pure orchestration over an injected runner/store, so it is
 * unit-tested with fakes; real tmux is exercised by the smoke test.
 */
export class GlassExecutor {
  constructor(private readonly opts: GlassExecutorOptions) {}

  apply(actions: ReconcileAction[]): void {
    for (const action of actions) {
      if (action.type === "checkout") this.checkout(action.paneId, action.home);
      else if (action.type === "restore") this.restore(action.record);
      else this.opts.store.remove(action.paneId);
    }
  }

  private checkout(paneId: string, home: { sessionId: string; windowId: string }): void {
    const { runner, store, holdingSession } = this.opts;
    const layout = runner.run(captureLayoutCommand(home.windowId)).lines[0] ?? "";
    // Persist FIRST so a crash before/at break is recoverable.
    store.put({
      paneId,
      homeSessionId: home.sessionId,
      homeWindowId: home.windowId,
      homeLayout: layout,
    });
    runner.run(breakPaneCommand(paneId, holdingSession));
  }

  private restore(record: PinnedPaneRecord): void {
    const { runner, store } = this.opts;
    const liveWindows = new Set(runner.run(["list-windows", "-a", "-F", "#{window_id}"]).lines);
    const liveSessions = new Set(runner.run(["list-sessions", "-F", "#{session_id}"]).lines);
    const holdingWindowId = runner.run(["display-message", "-p", "-t", record.paneId, "#{window_id}"]).lines[0] ?? "";
    const newSessionName = sanitizeTmuxSessionName(record.displaySessionName ?? "restored");

    const plan = planRestore(record, liveWindows, liveSessions);
    for (const cmd of buildRestoreCommands(record, plan, { holdingWindowId, newSessionName })) {
      runner.run(cmd);
    }
    // Drop the record only after restoration commands have run.
    store.remove(record.paneId);
  }
}
```

(Note: `import { sanitizeTmuxSessionName } from "../config"` is fine — `executor.ts`
is not imported by `config.ts`, so no cycle. The `list-sessions` reads here are
internal to restore resolution and need not carry the `INTERNAL_SESSION_FILTER`,
since they only test membership of a specific home session id.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/__tests__/glass/executor.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/glass/executor.ts src/__tests__/glass/executor.test.ts
git commit -m "feat(glass): GlassExecutor sequences reconciler actions"
```

---

## Task 6: Sidebar — Overview entry, nested pinned panes, (N pinned) marker

Extends the render plan (`RenderItem` union + `buildRenderPlan`) and selection model. Tests assert against the rendered grid, matching `sidebar.test.ts` conventions.

**Files:**
- Modify: `src/sidebar.ts`
- Test: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/sidebar.test.ts` (uses the existing `SIDEBAR_WIDTH`, `makeSessions`, and grid-row extraction helpers):

```typescript
import type { PinnedPaneEntry } from "../sidebar";

describe("Overview entry", () => {
  function pane(over: Partial<PinnedPaneEntry>): PinnedPaneEntry {
    return { paneId: "%1", label: "api › claude", homeSessionName: "api", ...over };
  }

  test("Overview entry renders at the very top, above sessions", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([pane({ paneId: "%1", label: "api › claude" })]);
    sidebar.updateSessions(makeSessions([{ name: "api", directory: "~/Code/work/api" }]));
    const grid = sidebar.getGrid();
    const row0 = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[0][i].char).join("");
    expect(row0).toContain("Overview");
  });

  test("pinned panes nest as children with their labels", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([
      pane({ paneId: "%1", label: "api › claude" }),
      pane({ paneId: "%2", label: "api › npm test" }),
    ]);
    sidebar.updateSessions(makeSessions([{ name: "api", directory: "~/Code/work/api" }]));
    const text = renderAllRows(sidebar.getGrid(), SIDEBAR_WIDTH);
    expect(text).toContain("claude");
    expect(text).toContain("npm test");
  });

  test("a session with a checked-out pane shows an (N pinned) marker", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([pane({ paneId: "%1", label: "api › claude", homeSessionName: "api" })]);
    sidebar.updateSessions(makeSessions([{ name: "api", directory: "~/Code/work/api" }]));
    const text = renderAllRows(sidebar.getGrid(), SIDEBAR_WIDTH);
    expect(text).toMatch(/1 pinned/);
  });

  test("empty state: Overview present with zero pinned panes", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([]);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const row0 = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid0Char(sidebar, i)).join("");
    expect(row0).toContain("Overview");
  });

  test("clicking the Overview row resolves to the overview selection", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([pane({})]);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.getGrid(); // build row map
    expect(sidebar.getSelectionByRow(0)).toEqual({ type: "overview" });
  });
});

// Helper used above — add near the other helpers in the file if not present.
function renderAllRows(grid: ReturnType<Sidebar["getGrid"]>, width: number): string {
  return grid.cells.map((row) => row.slice(0, width).map((c) => c.char).join("")).join("\n");
}
function grid0Char(sidebar: Sidebar, i: number): string {
  return sidebar.getGrid().cells[0][i].char;
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/sidebar.test.ts -t "Overview"`
Expected: FAIL — `setPinnedPanes` / `getSelectionByRow` / `PinnedPaneEntry` not defined.

- [ ] **Step 3: Implement in `src/sidebar.ts`**

Add the exported entry + selection types near the top of `src/sidebar.ts`:

```typescript
export interface PinnedPaneEntry {
  paneId: string;
  label: string;
  homeSessionName: string;
}

export type SidebarSelection =
  | { type: "overview" }
  | { type: "session"; id: string }
  | { type: "pinnedPane"; paneId: string };
```

Extend the `RenderItem` union (currently at ~line 175) with the new variants:

```typescript
type RenderItem =
  | { type: "overview"; paneCount: number }
  | { type: "pinned-pane"; paneIndex: number }
  | { type: "group-header"; label: string; collapsed: boolean; sessionCount: number }
  | { type: "session"; sessionIndex: number; grouped: boolean; groupLabel?: string; pinnedCount?: number }
  | { type: "spacer" };
```

Add private state + setter (near `pinnedSessions` at ~line 317):

```typescript
private pinnedPanes: PinnedPaneEntry[] = [];
private rowToSelection = new Map<number, SidebarSelection>();

setPinnedPanes(panes: PinnedPaneEntry[]): void {
  this.pinnedPanes = panes;
  this.rebuildPlan();
}
```

In `buildRenderPlan` (signature at ~line 182), thread `pinnedPanes` in and emit the
Overview block first, then compute a per-session pinned count. Prepend before the
pinned/group loop:

```typescript
// Overview entry — always present, at the very top.
items.unshift(); // no-op placeholder to keep diffs readable; build a fresh array instead:
```

Concretely, build the items array starting with:

```typescript
const items: RenderItem[] = [];
items.push({ type: "overview", paneCount: pinnedPanes.length });
for (let i = 0; i < pinnedPanes.length; i++) {
  items.push({ type: "pinned-pane", paneIndex: i });
}
items.push({ type: "spacer" });
```

Compute pinned counts per session name:

```typescript
const pinnedBySession = new Map<string, number>();
for (const p of pinnedPanes) {
  pinnedBySession.set(p.homeSessionName, (pinnedBySession.get(p.homeSessionName) ?? 0) + 1);
}
```

When pushing a `session` item, set `pinnedCount: pinnedBySession.get(sessions[idx].name)`.

In `getGrid` (the render loop ~line 512), add rendering for the two new item types
and populate `rowToSelection`:

```typescript
// inside the per-item render switch:
if (item.type === "overview") {
  const label = item.paneCount > 0 ? `◉ Overview (${item.paneCount})` : "◉ Overview";
  writeText(grid, row, 0, label /* existing text-writing helper */);
  this.rowToSelection.set(row, { type: "overview" });
} else if (item.type === "pinned-pane") {
  const entry = this.pinnedPanes[item.paneIndex];
  writeText(grid, row, 2, `│ ${entry.label}`);
  this.rowToSelection.set(row, { type: "pinnedPane", paneId: entry.paneId });
}
```

For session rows, after the existing name render, append the marker when present:

```typescript
if (item.pinnedCount && item.pinnedCount > 0) {
  writeText(grid, detailRow, /* col after name */, `(${item.pinnedCount} pinned)`);
}
this.rowToSelection.set(nameRow, { type: "session", id: this.sessions[sessionIdx].id });
```

(Use the file's existing cell-writing helper — match how `getGrid` already writes
group headers and session names; clear `rowToSelection` at the top of `getGrid`
alongside `rowToSessionIndex`.)

Add the selection lookup method:

```typescript
getSelectionByRow(row: number): SidebarSelection | null {
  return this.rowToSelection.get(row) ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: PASS — new Overview tests plus all existing sidebar tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): Overview entry, nested pinned panes, (N pinned) marker"
```

---

## Task 7: Bootstrap holding/park sessions + wire @jmux-pinned reflection

Integration. No new unit tests (the parse/reconcile/execute logic is already
tested in Tasks 4-5 and the foundation plan); verified by the Task 11 smoke test.

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Create the internal sessions on startup**

In `src/main.ts` startup (after the control client is connected, near where other
one-time setup runs), ensure the holding + park sessions exist and resolve the
holding session id:

```typescript
import { GLASS_HOLDING_SESSION, PARK_SESSION } from "./glass/internal-sessions";

async function ensureGlassSessions(): Promise<string | null> {
  await control.sendCommand(
    `new-session -d -s ${GLASS_HOLDING_SESSION} 2>/dev/null ; new-session -d -s ${PARK_SESSION} 2>/dev/null ; display-message -p -t ${GLASS_HOLDING_SESSION} '#{session_id}'`,
  ).catch(() => {});
  const lines = await control.sendCommand(
    `list-sessions -F '#{session_id}:#{session_name}'`,
  ).catch(() => [] as string[]);
  for (const line of lines) {
    const [id, name] = line.split(":");
    if (name === GLASS_HOLDING_SESSION) return id;
  }
  return null;
}
```

Store the result in a module-level `let glassHoldingSessionId: string | null = null;`
and call it once during startup.

- [ ] **Step 2: Instantiate the tracker, store, and executor**

```typescript
import { PinnedPaneTracker } from "./glass/pinned-pane-tracker";
import { GlassExecutor, type RecordStore, type GlassRunner } from "./glass/executor";
import { reconcilePins } from "./glass/reconciler";
import { parsePaneStateLines, PANE_STATE_FORMAT } from "./glass/reflect";
import { GLASS_HOLDING_SESSION } from "./glass/internal-sessions";

const pinnedTracker = new PinnedPaneTracker();

const recordStore: RecordStore = {
  get: () => [...(configStore.config.pinnedPanes ?? [])],
  put: (record) => {
    const next = (configStore.config.pinnedPanes ?? []).filter((r) => r.paneId !== record.paneId);
    next.push(record);
    configStore.set("pinnedPanes", next);
  },
  remove: (paneId) => {
    configStore.set("pinnedPanes", (configStore.config.pinnedPanes ?? []).filter((r) => r.paneId !== paneId));
  },
};

const glassRunner: GlassRunner = {
  run: (args) => {
    const r = Bun.spawnSync(["tmux", ...tmuxSocketArgs(), ...args], { stdout: "pipe", stderr: "pipe" });
    const ok = (r.exitCode ?? 1) === 0;
    const lines = r.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
    return { ok, lines };
  },
};
```

(`tmuxSocketArgs()` — reuse however main.ts already derives the `-L`/`-S` socket
args for direct tmux calls; if none exists, derive from the same socket the PTY
uses.)

- [ ] **Step 3: The reconcile-and-execute driver**

```typescript
function runPinReconcile(): void {
  const state = parsePaneStateLines(
    glassRunner.run(["list-panes", "-a", "-F", PANE_STATE_FORMAT]).lines,
  );
  // Feed desired-membership reflection.
  for (const paneId of state.live.keys()) {
    pinnedTracker.apply(paneId, state.pinned.has(paneId) ? "1" : null);
  }
  pinnedTracker.pruneExcept([...state.live.keys()]);

  const records = new Map((configStore.config.pinnedPanes ?? []).map((r) => [r.paneId, r]));
  const actions = reconcilePins({
    desired: state.pinned,
    records,
    live: state.live,
    holdingSessionId: glassHoldingSessionId,
  });
  if (actions.length === 0) return;

  const executor = new GlassExecutor({
    runner: glassRunner,
    store: recordStore,
    holdingSession: GLASS_HOLDING_SESSION,
    holdingSessionId: glassHoldingSessionId ?? "",
  });
  executor.apply(actions);
  glassView?.refresh(); // Task 8
  scheduleRender();
}
```

- [ ] **Step 4: Subscribe to per-pane @jmux-pinned and drive on change + startup**

Following the existing `agent-state` subscription pattern (`registerSubscription`
+ the `subscription-changed` event case):

```typescript
await control.registerSubscription(
  "pinned-panes",
  1,
  "#{P:#{pane_id}=#{@jmux-pinned} }",
);
```

In the `subscription-changed` event handler (alongside the `agent-state` branch),
add:

```typescript
} else if (event.name === "pinned-panes") {
  runPinReconcile();
}
```

And call `runPinReconcile()` once after `ensureGlassSessions()` resolves at
startup (this is the crash-recovery pass: it re-adopts surviving holding windows
against persisted records and re-checks-out anything still desired).

- [ ] **Step 5: Verify build + types**

Run: `bun run typecheck && bun test`
Expected: PASS (no behavior change to unit suites; new wiring typechecks).

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(glass): bootstrap holding/park sessions + @jmux-pinned reflection driver"
```

---

## Task 8: GlassView — composite live tiles

Integration. Owns the per-tile `TmuxPty` + `ScreenBridge`, builds a composited
main-area grid from `computeTileLayout`, and draws tile chrome. Verified by smoke
test.

**Files:**
- Create: `src/glass/view.ts`
- Modify: `src/renderer.ts` (accept a pre-composited main grid is already how it
  works — `GlassView` produces a `CellGrid` the existing `render(main, …)` path
  consumes)
- Modify: `src/main.ts` (mount GlassView; choose glass grid vs single bridge grid)

- [ ] **Step 1: Implement `GlassView`**

Create `src/glass/view.ts`. Responsibilities (constructor takes the socket/config
args needed to spawn `TmuxPty`):

```typescript
import { TmuxPty } from "../tmux-pty";
import { ScreenBridge } from "../screen-bridge";
import { createGrid, type CellGrid } from "../cell-grid";
import { computeTileLayout, type TileRect } from "./layout";
import { tileSessionName, GLASS_HOLDING_SESSION } from "./internal-sessions";

interface Tile {
  paneId: string;
  label: string;
  holdingWindowId: string;
  pty: TmuxPty;
  bridge: ScreenBridge;
  writesPending: number;
  rect: TileRect;
}

export interface GlassViewOptions {
  socketName?: string;
  configFile?: string;
  jmuxDir?: string;
  minTileWidth: number;
  minTileHeight: number;
  onFrame: () => void; // calls scheduleRender in main
}

export class GlassView {
  private tiles: Tile[] = [];
  private focusedIndex = 0;
  private scrollRow = 0;
  private width = 0;
  private height = 0;
  constructor(private readonly opts: GlassViewOptions) {}

  // Reconcile the live tile set against the holding session's windows.
  // For each holding window (one per pinned pane): spawn a TmuxPty
  //   (new-session -t __jmux_glass group member) + ScreenBridge if absent;
  //   tear down tiles whose pane is gone.
  refresh(): void { /* spawn/teardown per holding window; see steps below */ }

  resize(width: number, height: number): void { this.width = width; this.height = height; this.relayout(); }
  focusedTilePtyWrite(data: string): void { this.tiles[this.focusedIndex]?.pty.write(data); }
  tileAt(x: number, y: number): number | null { /* hit-test rects */ return null; }
  focusTile(index: number): void { this.focusedIndex = index; this.relayout(); }
  moveFocus(dir: "left" | "right" | "up" | "down"): void { /* directional via columns */ }
  getFocusedPaneId(): string | null { return this.tiles[this.focusedIndex]?.paneId ?? null; }
  teardown(): void { for (const t of this.tiles) t.pty.kill(); this.tiles = []; }

  getGrid(): CellGrid {
    const grid = createGrid(this.width, this.height);
    for (const t of this.tiles) {
      if (!t.rect.visible) continue; // P2: skip off-screen
      drawTileBorder(grid, t.rect, t.label, t === this.tiles[this.focusedIndex]);
      blitTileContent(grid, t.rect, t.bridge.getGrid());
    }
    return grid;
  }

  private relayout(): void {
    const layout = computeTileLayout({
      tileCount: this.tiles.length,
      mainWidth: this.width,
      mainHeight: this.height,
      minTileWidth: this.opts.minTileWidth,
      minTileHeight: this.opts.minTileHeight,
      focusedIndex: this.focusedIndex,
      scrollRow: this.scrollRow,
    });
    this.scrollRow = layout.scrollRow;
    for (const t of this.tiles) {
      const rect = layout.tiles.find((r) => r.index === this.tiles.indexOf(t));
      if (rect) { t.rect = rect; t.pty.resize(Math.max(1, rect.width - 2), Math.max(1, rect.height - 2)); t.bridge.resize(Math.max(1, rect.width - 2), Math.max(1, rect.height - 2)); }
    }
  }
}
```

Implement the helpers within the file:
- **Spawn a tile**: `new TmuxPty({ sessionName: tileSessionName(paneId), socketName, configFile, jmuxDir, cols, rows, attachMode: "createOrAttach" })`. Because that session name is a fresh group member created via `new-session -t __jmux_glass`, first run (via the injected runner or a direct spawn) `new-session -d -t __jmux_glass -s <tileSessionName>` then `select-window -t <tileSessionName>:<holdingWindowId>`; the PTY attaches to it. Wire `pty.onData` → `t.writesPending++; t.bridge.write(data).then(() => { t.writesPending--; if (t.writesPending === 0) this.opts.onFrame(); })` (mirrors main.ts's single-bridge backpressure, per-tile).
- **`drawTileBorder`**: draw a box using the same border glyphs/`pane-border` styling the renderer's toolbar code uses; put `label` top-left; use the active-border color when focused. Handle width-2 cells per the CLAUDE.md wide-char rule.
- **`blitTileContent`**: copy `bridge.getGrid()` cells into the rect interior (offset by the 1-cell border).
- **`tileAt`/`moveFocus`**: hit-test against `t.rect`; directional move computes column/row from `computeTileLayout`'s columns.

- [ ] **Step 2: Mount GlassView in main.ts**

- Instantiate `glassView = new GlassView({...})` lazily when the Overview view is selected.
- In `renderFrame` (main.ts ~line 1038), when the selected view is Overview, build the main grid from `glassView.getGrid()` instead of `bridge.getGrid()`, and pass `toolbar: null` to `renderer.render(...)`.
- On entering Overview: park the main client (`switch-client -c <ptyClientName> -t __jmux_park`), call `glassView.refresh()` + `glassView.resize(mainCols, fullHeight)`. On leaving: `glassView.teardown()` and `switch-client` back to the selected session.

- [ ] **Step 3: Smoke test (real tmux)** — deferred to Task 11's consolidated smoke test.

- [ ] **Step 4: Commit**

```bash
git add src/glass/view.ts src/renderer.ts src/main.ts
git commit -m "feat(glass): GlassView live tile compositing + chrome"
```

---

## Task 9: Input routing — tile focus, Shift+arrows, Ctrl-a z promote

Integration.

**Files:**
- Modify: `src/input-router.ts`
- Modify: `src/main.ts` (wire glass callbacks)

- [ ] **Step 1: Add glass awareness to InputRouter**

Add to `InputRouterOptions`: `glassActive?: () => boolean`, `onTileClick?: (x: number, y: number) => void`, `onTileData?: (data: string) => void`, `onTileFocusMove?: (dir: "left"|"right"|"up"|"down") => void`, `onPromoteFocusedTile?: () => void`.

In `handleInput`:
- When `glassActive?.()` is true and a mouse event lands in the main area (`mouse.x > sidebarCols`), call `onTileClick(mouse.x - sidebarCols - 1, mouse.y - 1)` instead of the toolbar/PTY path.
- When glass is active, intercept `Shift+Left/Right/Up/Down` (`\x1b[1;2D/C/A/B`) → `onTileFocusMove`; do **not** forward to tmux.
- Keep the soft `Ctrl-a` prefix intercept; when glass is active and the prefix is followed by `z`, call `onPromoteFocusedTile()`.
- Otherwise, when glass is active, route keystrokes to `onTileData` (focused tile) instead of `onPtyData`.

- [ ] **Step 2: Wire in main.ts**

```typescript
glassActive: () => selectedView.type === "overview",
onTileClick: (x, y) => { const i = glassView?.tileAt(x, y); if (i != null) { glassView.focusTile(i); scheduleRender(); } },
onTileData: (data) => glassView?.focusedTilePtyWrite(data),
onTileFocusMove: (dir) => { glassView?.moveFocus(dir); scheduleRender(); },
onPromoteFocusedTile: () => { const id = glassView?.getFocusedPaneId(); if (id) selectView({ type: "pinnedPane", paneId: id }); },
```

(`selectedView` / `selectView` are introduced in Task 10.)

- [ ] **Step 3: Smoke test** — deferred to Task 11.

- [ ] **Step 4: Commit**

```bash
git add src/input-router.ts src/main.ts
git commit -m "feat(glass): tile focus, Shift+arrow nav, Ctrl-a z promote"
```

---

## Task 10: Selected-view model — toolbar hide, main-client park, persistence

Integration. Introduces the `selectedView` state the sidebar selection drives, and
persists it.

**Files:**
- Modify: `src/main.ts`
- Modify: `src/config.ts` (add `selectedView?` persistence field)
- Test: `src/__tests__/config.test.ts` (round-trip the new field)

- [ ] **Step 1: Add the persisted field (TDD)**

Add to `JmuxConfig` in `src/config.ts`:

```typescript
/** Last selected view: a session name, or the Overview sentinel. */
selectedView?: { type: "overview" } | { type: "session"; name: string } | { type: "pinnedPane"; paneId: string };
```

Add a round-trip test to `src/__tests__/config.test.ts`:

```typescript
test("round-trips selectedView", () => {
  const store = new ConfigStore(cfgPath);
  store.set("selectedView", { type: "overview" });
  expect(new ConfigStore(cfgPath).config.selectedView).toEqual({ type: "overview" });
});
```

Run: `bun test src/__tests__/config.test.ts -t "selectedView"` → PASS after adding the field.

- [ ] **Step 2: Drive view selection from the sidebar**

In main.ts, replace the bare `currentSessionId` selection concept with a
`selectedView: SidebarSelection`-like value and a `selectView(sel)` function that:
- `overview` → set `toolbarEnabled = false`; park main client on `__jmux_park`; ensure `glassView` mounted + refreshed; persist `{type:"overview"}`.
- `session` → `toolbarEnabled = true`; `glassView?.teardown()`; `switchSession(id)`; persist `{type:"session", name}`.
- `pinnedPane` → promote: `toolbarEnabled = true`; teardown glass; `switch-client -c <ptyClientName> -t __jmux_glass` then `select-window` to that pane's holding window; persist `{type:"pinnedPane", paneId}`.

Wire the sidebar click handler (`onSidebarClick(row)`) to call
`sidebar.getSelectionByRow(row)` and dispatch through `selectView`.

- [ ] **Step 3: Restore the persisted view on startup**

After `ensureGlassSessions()` + the first `runPinReconcile()`, read
`configStore.config.selectedView` and call `selectView(...)`, reconciling: if a
`session` no longer exists, fall back to the first session; a `pinnedPane` whose
pane is gone falls back to Overview.

- [ ] **Step 4: Verify + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/config.ts src/__tests__/config.test.ts
git commit -m "feat(glass): selected-view model, toolbar hide, view persistence"
```

---

## Task 11: Consolidated manual smoke test (real tmux)

This is the integration gate for Tasks 7-10. Run inside a real jmux session.

- [ ] **Step 1: Pin from two different windows → two tiles**

Open a session with the agent in window 1 and a `npm test`/long-running command in
window 2. In each pane run `bun run src/main.ts ctl pane pin`. Select **Overview**
in the sidebar.
Expected: two live tiles, each full-bleed (no zoom), border with `session › label`
top-left; the focused tile has the active-border highlight; the toolbar is hidden.

- [ ] **Step 2: Pin two splits of the SAME window → two independent tiles**

Split a window into two panes; pin both. Select Overview.
Expected: both render as independent live tiles (break-pane isolation; no
same-window zoom fight). The home window is now missing those panes (checkout), and
the session shows `(2 pinned)` in the sidebar.

- [ ] **Step 3: Drive a tile**

Click a tile, type into it.
Expected: keystrokes reach that pane's process; `Shift+arrows` move focus between
tiles; `Ctrl-a z` promotes the focused tile to full-screen (toolbar returns);
selecting Overview again returns to the glass.

- [ ] **Step 4: Unpin → pane returns home with original layout**

`bun run src/main.ts ctl pane unpin` (or palette unpin) on a tile's pane.
Expected: the pane rejoins its home window and the original split layout is
restored; the tile disappears from the glass.

- [ ] **Step 5: Process-exit auto-unpin**

Let a pinned test command finish.
Expected: its tile disappears and its pin clears (reconciler discard path).

- [ ] **Step 6: Crash recovery**

With panes pinned and in the glass, kill jmux (not the tmux server) and relaunch.
Expected: jmux re-enters the glass; surviving holding windows are re-adopted as
tiles; no pane is stranded; `config.json` `pinnedPanes` matches what's shown.

- [ ] **Step 7: Internal sessions stay hidden**

Run `bun run src/main.ts ctl session list` and check the sidebar.
Expected: no `__jmux_glass` / `__jmux_park` / `__jmux_tile_*` entries anywhere.

- [ ] **Step 8: Full suite + typecheck once more**

Run: `bun test && bun run typecheck`
Expected: PASS.

If any step fails, use superpowers:systematic-debugging before patching.

---

## Task 12: Revise the design docs

**Files:**
- Modify: `docs/adr/0001-pane-of-glass-live-composited-clients.md`
- Modify: `docs/adr/0002-pin-state-in-tmux-option.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: ADR 0001**

Replace the zoom-based rendering rationale with break-pane isolation into the
`__jmux_glass` holding session via session-group tile clients; state that
mutual-exclusivity is now *physical* (a pinned pane lives in the holding session)
rather than enforced by a viewing rule; note the agent-pane auto-detection
capability is dropped (panes are pinned explicitly).

- [ ] **Step 2: ADR 0002**

Change "per-session tmux option" to **per-pane** `@jmux-pinned`; clarify desired
membership (option) vs physical checkout (records + reconciler); keep the
"agents control membership, not view" boundary.

- [ ] **Step 3: CONTEXT.md glossary**

Rewrite *Pin* (pane-scoped, desired vs checkout), *Tile* (holding-window client,
no zoom), *Overview entry* (nested pinned panes); remove *Agent pane* as a pinning
concept; add *Holding session* / *Checkout* terms.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0001-pane-of-glass-live-composited-clients.md docs/adr/0002-pin-state-in-tmux-option.md CONTEXT.md
git commit -m "docs: revise ADRs + CONTEXT for pane-level pane-of-glass"
```

---

## Self-Review Notes (author)

- **Spec coverage:** rendering model (Tasks 7-8, smoke 1-2) ✓; tile chrome (Task 8) ✓; navigation/promote (Task 9, smoke 3) ✓; layout math (Task 2) ✓; P2 visible-only parsing (`getGrid` skips `!visible` tiles, Task 8) ✓; sidebar Overview/labels/markers/empty-state (Tasks 1, 6) ✓; lifecycle break/join/restore + crash ordering (Tasks 3, 5; smoke 4-6) ✓; restore home-gone branches (`buildRestoreCommands` + foundation `planRestore`) ✓; reflection wiring via `#{P:...}` (Task 7) ✓; toolbar hide + persistence (Task 10) ✓; internal-session hiding end to end (foundation + smoke 7) ✓; docs (Task 12) ✓.
- **Type consistency:** `PinnedPaneEntry`/`SidebarSelection` (sidebar.ts) consumed by main.ts; `GlassRunner`/`RecordStore`/`GlassExecutor` (executor.ts) consumed by main.ts; `TileRect`/`computeTileLayout` (layout.ts) consumed by view.ts; `parsePaneStateLines`/`PANE_STATE_FORMAT` (reflect.ts) consumed by main.ts; all command builders (commands.ts) consumed by executor.ts. Names align across tasks.
- **Honest test boundary:** Tasks 1-6 are full red-green unit cycles. Tasks 7-10 are integration wiring with no unit tests by design (per the project's "tests don't spawn tmux" rule); their correctness is gated by the Task 11 smoke test. This is called out, not hidden.
- **No placeholders in pure tasks:** every Phase A/B/C step shows complete code + commands. Integration tasks show the concrete seams (signatures, event cases, wiring snippets) rather than full file rewrites, which is appropriate for editing large existing files (`main.ts`, `renderer.ts`, `input-router.ts`).
