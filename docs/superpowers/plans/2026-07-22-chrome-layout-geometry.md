# Chrome Layout Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one pure function the single authority for every row and column band in jmux's terminal, so the chrome rows added in the next plan cannot mis-size the PTY or displace mouse input.

**Architecture:** A new `src/layout.ts` exports `computeLayoutGeometry()`, returning every band boundary (toolbar, rules, content, footer, sidebar, main, panel) plus the exact `ptyRows`/`ptyCols` to resize to. `main.ts` currently derives PTY height with an open-coded `(process.stdout.rows || 24) - toolbarHeight` in 13 places; all of them are replaced by reads from a single cached geometry. `InputRouter`'s `toolbarRows` field currently means two different things — a clickable hit region *and* the content y-offset — and is split. The renderer's `if (!sidebar) return main` early return is removed so narrow terminals composite chrome like every other mode.

The geometry supports the frame rules and footer from day one, but this plan always passes `frameRulesEnabled: false` and `footerEnabled: false`, so it reproduces today's bands exactly. Plan 2 flips those flags.

**Tech Stack:** TypeScript (strict), Bun 1.3.8+ test runner, no bundler.

## Global Constraints

- Target **Bun, not Node** — use `Bun.spawn`, `Bun.spawnSync`, `Bun.$`. Never add Node equivalents or a Node-targeted build.
- Tests are **pure unit tests over logic modules**. Nothing in this plan may spawn tmux.
- `bun run typecheck` must pass (`tsc --noEmit`, strict mode).
- Prefer fully typed over loosely typed code. No `any`.
- **This plan must produce zero visible change** except the narrow-terminal bug fix in Task 4, which is called out explicitly.
- Existing constant: `BORDER_WIDTH` is 1 (the sidebar divider column). `sidebarTotal()` in `main.ts:259` is `sidebarWidth + BORDER_WIDTH`.
- Existing constant: the sidebar is suppressed below 80 columns (`main.ts:384`, `cols >= 80`).
- Never sign off as Claude in git.

---

### Task 1: `computeLayoutGeometry` — the pure geometry function

**Files:**
- Create: `src/layout.ts`
- Test: `src/__tests__/layout.test.ts`

**Interfaces:**
- Consumes: nothing — this task has no dependencies.
- Produces: `SIDEBAR_MIN_COLS: number`, `LayoutChrome`, `LayoutInput`, `LayoutGeometry`, `resolveChrome(input: LayoutInput): LayoutChrome`, `computeLayoutGeometry(input: LayoutInput): LayoutGeometry`. Tasks 2, 3 and 4 all consume `computeLayoutGeometry` and the `LayoutGeometry` type.

- [ ] **Step 1: Write the failing test file**

Create `src/__tests__/layout.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import {
  computeLayoutGeometry,
  resolveChrome,
  SIDEBAR_MIN_COLS,
  type LayoutInput,
} from "../layout";

/** A baseline that reproduces today's behaviour: chrome rows off. */
function baseInput(over: Partial<LayoutInput> = {}): LayoutInput {
  return {
    termCols: 200,
    termRows: 50,
    toolbarEnabled: true,
    windowBranchesEnabled: false,
    sidebarWidth: 26,
    frameRulesEnabled: false,
    footerEnabled: false,
    diffPanel: "off",
    diffPanelCols: 0,
    ...over,
  };
}

describe("resolveChrome", () => {
  test("with rules and footer disabled, only the toolbar is present at any height", () => {
    for (const termRows of [3, 6, 10, 24, 60]) {
      expect(resolveChrome(baseInput({ termRows }))).toEqual({
        toolbar: true,
        topRule: false,
        footerRule: false,
        footer: false,
      });
    }
  });

  test("toolbarEnabled false yields no chrome at all", () => {
    expect(resolveChrome(baseInput({ toolbarEnabled: false }))).toEqual({
      toolbar: false,
      topRule: false,
      footerRule: false,
      footer: false,
    });
  });

  test("degrades in a fixed order as the terminal shrinks", () => {
    const on = { frameRulesEnabled: true, footerEnabled: true };
    const at = (termRows: number) => resolveChrome(baseInput({ termRows, ...on }));

    expect(at(24)).toEqual({ toolbar: true, topRule: true, footerRule: true, footer: true });
    expect(at(12)).toEqual({ toolbar: true, topRule: true, footerRule: true, footer: true });
    expect(at(11)).toEqual({ toolbar: true, topRule: true, footerRule: false, footer: true });
    expect(at(9)).toEqual({ toolbar: true, topRule: true, footerRule: false, footer: false });
    expect(at(7)).toEqual({ toolbar: true, topRule: false, footerRule: false, footer: false });
    expect(at(5)).toEqual({ toolbar: false, topRule: false, footerRule: false, footer: false });
  });
});

describe("computeLayoutGeometry — row bands", () => {
  test("reproduces today's bands when chrome rows are off", () => {
    const g = computeLayoutGeometry(baseInput({ termRows: 50 }));
    expect(g.toolbarRows).toBe(1);
    expect(g.topRuleRow).toBeNull();
    expect(g.contentTop).toBe(1);
    expect(g.contentRows).toBe(49);
    expect(g.footerRuleRow).toBeNull();
    expect(g.footerRow).toBeNull();
    expect(g.ptyRows).toBe(49);
  });

  test("a two-row toolbar pushes content down by one", () => {
    const g = computeLayoutGeometry(baseInput({ windowBranchesEnabled: true }));
    expect(g.toolbarRows).toBe(2);
    expect(g.contentTop).toBe(2);
    expect(g.contentRows).toBe(48);
  });

  test("full chrome reserves four rows", () => {
    const g = computeLayoutGeometry(
      baseInput({ termRows: 50, frameRulesEnabled: true, footerEnabled: true }),
    );
    expect(g.toolbarRows).toBe(1);
    expect(g.topRuleRow).toBe(1);
    expect(g.contentTop).toBe(2);
    expect(g.contentRows).toBe(46);
    expect(g.footerRuleRow).toBe(48);
    expect(g.footerRow).toBe(49);
  });
});

describe("computeLayoutGeometry — invariants across a matrix", () => {
  const matrix: LayoutInput[] = [];
  for (const termRows of [5, 6, 8, 10, 12, 24, 60]) {
    for (const windowBranchesEnabled of [false, true]) {
      for (const diffPanel of ["off", "split", "full"] as const) {
        for (const termCols of [60, 80, 200]) {
          for (const rules of [false, true]) {
            matrix.push({
              termCols,
              termRows,
              toolbarEnabled: true,
              windowBranchesEnabled,
              sidebarWidth: 26,
              frameRulesEnabled: rules,
              footerEnabled: rules,
              diffPanel,
              diffPanelCols: diffPanel === "split" ? 40 : 0,
            });
          }
        }
      }
    }
  }

  test("row bands are contiguous, non-overlapping, and cover the terminal", () => {
    for (const input of matrix) {
      const g = computeLayoutGeometry(input);
      const rows: number[] = [];
      for (let r = 0; r < g.toolbarRows; r++) rows.push(r);
      if (g.topRuleRow !== null) rows.push(g.topRuleRow);
      for (let r = 0; r < g.contentRows; r++) rows.push(g.contentTop + r);
      if (g.footerRuleRow !== null) rows.push(g.footerRuleRow);
      if (g.footerRow !== null) rows.push(g.footerRow);

      const sorted = [...rows].sort((a, b) => a - b);
      expect(new Set(rows).size).toBe(rows.length); // no overlap
      expect(sorted[0]).toBe(0);
      expect(sorted[sorted.length - 1]).toBe(input.termRows - 1);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]).toBe(sorted[i - 1] + 1); // contiguous
      }
    }
  });

  test("ptyRows always equals contentRows and ptyCols always equals mainCols", () => {
    for (const input of matrix) {
      const g = computeLayoutGeometry(input);
      expect(g.ptyRows).toBe(g.contentRows);
      expect(g.ptyCols).toBe(g.mainCols);
    }
  });

  test("contentRows is never less than one", () => {
    for (const input of matrix) {
      expect(computeLayoutGeometry(input).contentRows).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("computeLayoutGeometry — column bands", () => {
  test("the sidebar is suppressed below the minimum width", () => {
    expect(SIDEBAR_MIN_COLS).toBe(80);
    const narrow = computeLayoutGeometry(baseInput({ termCols: 79 }));
    expect(narrow.sidebarCols).toBe(0);
    expect(narrow.dividerCol).toBeNull();
    expect(narrow.mainStartCol).toBe(0);
    expect(narrow.mainCols).toBe(79);
  });

  test("the divider sits immediately after the sidebar", () => {
    const g = computeLayoutGeometry(baseInput({ termCols: 200, sidebarWidth: 26 }));
    expect(g.sidebarCols).toBe(26);
    expect(g.dividerCol).toBe(26);
    expect(g.mainStartCol).toBe(27);
    expect(g.mainCols).toBe(173);
  });

  test("split mode reserves a panel divider between main and panel", () => {
    const g = computeLayoutGeometry(
      baseInput({ termCols: 200, diffPanel: "split", diffPanelCols: 40 }),
    );
    expect(g.panelCols).toBe(40);
    expect(g.mainCols).toBe(132); // 173 available - 1 divider - 40 panel
    expect(g.panelDividerCol).toBe(27 + 132);
    expect(g.panelStartCol).toBe(27 + 132 + 1);
    expect(g.panelStartCol! + g.panelCols).toBe(200);
  });

  test("full mode gives main and panel the same band and no divider", () => {
    const g = computeLayoutGeometry(baseInput({ termCols: 200, diffPanel: "full" }));
    expect(g.mainCols).toBe(173);
    expect(g.panelCols).toBe(173);
    expect(g.panelStartCol).toBe(27);
    expect(g.panelDividerCol).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/__tests__/layout.test.ts`
Expected: FAIL — `Cannot find module '../layout'`.

- [ ] **Step 3: Write `src/layout.ts`**

```ts
// The single authority for every row and column band jmux draws into.
//
// Before this module, PTY height was derived by an open-coded
// `(process.stdout.rows || 24) - toolbarHeight` in thirteen places in main.ts,
// and InputRouter's `toolbarRows` doubled as both a clickable hit region and
// the content y-offset. Adding chrome rows to either of those arrangements
// produces a silently mis-sized PTY or a one-row mouse displacement, so every
// consumer now reads bands from here instead of computing them.

/** Below this width the sidebar is suppressed entirely. */
export const SIDEBAR_MIN_COLS = 80;

/** The sidebar divider occupies exactly one column. */
export const BORDER_WIDTH = 1;

/** Content is never squeezed below this, however short the terminal is. */
const MIN_CONTENT_ROWS = 1;

export interface LayoutChrome {
  toolbar: boolean;
  topRule: boolean;
  footerRule: boolean;
  footer: boolean;
}

export interface LayoutInput {
  termCols: number;
  termRows: number;
  toolbarEnabled: boolean;
  windowBranchesEnabled: boolean;
  /** Configured sidebar width, excluding the divider column. */
  sidebarWidth: number;
  /** False until the frame rules land; keeps geometry identical to pre-frame jmux. */
  frameRulesEnabled: boolean;
  /** False until the footer lands. */
  footerEnabled: boolean;
  diffPanel: "off" | "split" | "full";
  /** Panel width in split mode; ignored otherwise. */
  diffPanelCols: number;
}

export interface LayoutGeometry {
  termCols: number;
  termRows: number;
  chrome: LayoutChrome;

  /** Clickable toolbar band: rows [0, toolbarRows). */
  toolbarRows: number;
  /** The frame rule row — inert, not part of the toolbar band. */
  topRuleRow: number | null;

  contentTop: number;
  contentRows: number;

  footerRuleRow: number | null;
  footerRow: number | null;

  /** 0 when the sidebar is suppressed. */
  sidebarCols: number;
  dividerCol: number | null;
  mainStartCol: number;
  mainCols: number;
  panelDividerCol: number | null;
  panelStartCol: number | null;
  panelCols: number;

  /** What the PTY and ScreenBridge are resized to. */
  ptyRows: number;
  ptyCols: number;
}

const NO_CHROME: LayoutChrome = {
  toolbar: false,
  topRule: false,
  footerRule: false,
  footer: false,
};

/**
 * Decide which chrome rows fit. The degradation ladder only engages once frame
 * rules or the footer are actually enabled — with both off this returns exactly
 * what jmux did before this module existed, at every terminal height.
 */
export function resolveChrome(input: LayoutInput): LayoutChrome {
  if (!input.toolbarEnabled) return { ...NO_CHROME };

  const wantsExtraRows = input.frameRulesEnabled || input.footerEnabled;
  if (!wantsExtraRows) {
    return { toolbar: true, topRule: false, footerRule: false, footer: false };
  }

  const rules = input.frameRulesEnabled;
  const footer = input.footerEnabled;
  const r = input.termRows;

  if (r < 6) return { ...NO_CHROME };
  if (r < 8) return { toolbar: true, topRule: false, footerRule: false, footer: false };
  if (r < 10) return { toolbar: true, topRule: rules, footerRule: false, footer: false };
  if (r < 12) return { toolbar: true, topRule: rules, footerRule: false, footer };
  return { toolbar: true, topRule: rules, footerRule: rules && footer, footer };
}

export function computeLayoutGeometry(input: LayoutInput): LayoutGeometry {
  const chrome = resolveChrome(input);

  // --- Rows, top down ---
  const toolbarRows = chrome.toolbar ? (input.windowBranchesEnabled ? 2 : 1) : 0;
  let cursor = toolbarRows;
  const topRuleRow = chrome.topRule ? cursor++ : null;
  const contentTop = cursor;

  const footerRow = chrome.footer ? input.termRows - 1 : null;
  const footerRuleRow = chrome.footerRule ? input.termRows - 2 : null;
  const bottomReserved = (chrome.footer ? 1 : 0) + (chrome.footerRule ? 1 : 0);
  const contentRows = Math.max(
    MIN_CONTENT_ROWS,
    input.termRows - contentTop - bottomReserved,
  );

  // --- Columns, left to right ---
  const sidebarShown = input.sidebarWidth > 0 && input.termCols >= SIDEBAR_MIN_COLS;
  const sidebarCols = sidebarShown ? input.sidebarWidth : 0;
  const dividerCol = sidebarShown ? sidebarCols : null;
  const mainStartCol = sidebarShown ? sidebarCols + BORDER_WIDTH : 0;
  const available = Math.max(0, input.termCols - mainStartCol);

  let mainCols = available;
  let panelCols = 0;
  let panelStartCol: number | null = null;
  let panelDividerCol: number | null = null;

  if (input.diffPanel === "split") {
    panelCols = Math.max(0, Math.min(input.diffPanelCols, available - BORDER_WIDTH));
    mainCols = Math.max(0, available - BORDER_WIDTH - panelCols);
    panelDividerCol = mainStartCol + mainCols;
    panelStartCol = panelDividerCol + BORDER_WIDTH;
  } else if (input.diffPanel === "full") {
    // Full mode overlays the panel across the whole main band; the PTY behind it
    // stays the same size, which is what main.ts already does today.
    panelCols = available;
    panelStartCol = mainStartCol;
  }

  return {
    termCols: input.termCols,
    termRows: input.termRows,
    chrome,
    toolbarRows,
    topRuleRow,
    contentTop,
    contentRows,
    footerRuleRow,
    footerRow,
    sidebarCols,
    dividerCol,
    mainStartCol,
    mainCols,
    panelDividerCol,
    panelStartCol,
    panelCols,
    ptyRows: contentRows,
    ptyCols: mainCols,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/__tests__/layout.test.ts`
Expected: PASS — all 11 tests.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/layout.ts src/__tests__/layout.test.ts
git commit -m "feat(layout): add computeLayoutGeometry as the single band authority

Row and column bands are currently decided independently in a dozen places.
This adds one pure function that owns them, supporting the frame rules and
footer from day one but reproducing today's bands exactly while both are
disabled. No consumers yet."
```

---

### Task 2: Migrate `main.ts` to the geometry

**Files:**
- Modify: `src/main.ts` (13 PTY-arithmetic sites plus `sidebarVisible`)
- Test: `src/__tests__/layout-migration.test.ts` (create)

**Interfaces:**
- Consumes: `computeLayoutGeometry`, `LayoutGeometry`, `SIDEBAR_MIN_COLS` from Task 1.
- Produces: a module-level `currentGeometry: LayoutGeometry` in `main.ts`, refreshed by `refreshGeometry()`, plus `geom(): LayoutGeometry` for reads. Task 3 and Task 4 receive `geom()` output; they do not import it.

- [ ] **Step 1: Write the failing guard test**

Create `src/__tests__/layout-migration.test.ts`:

```ts
import { describe, test, expect } from "bun:test";

/**
 * main.ts previously derived PTY height with an open-coded
 * `(process.stdout.rows || 24) - toolbarHeight` in thirteen places. Every one
 * missed would silently mis-size the PTY once chrome rows are added, and the
 * failure mode is tmux rendering at the wrong height rather than a crash — so
 * the ban is enforced rather than trusted.
 */
describe("main.ts row arithmetic", () => {
  test("contains no open-coded toolbarHeight subtraction", async () => {
    const source = await Bun.file(
      new URL("../main.ts", import.meta.url).pathname,
    ).text();
    const offenders = source
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /-\s*toolbarHeight/.test(line));

    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });

  test("does not read process.stdout.rows outside the geometry refresh", async () => {
    const source = await Bun.file(
      new URL("../main.ts", import.meta.url).pathname,
    ).text();
    const hits = source
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /process\.stdout\.(rows|columns)/.test(line))
      .filter(({ line }) => !line.includes("refreshGeometry"));

    // Exactly one permitted site: the body of refreshGeometry().
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/layout-migration.test.ts`
Expected: FAIL — the first test lists 13 offending lines.

- [ ] **Step 3: Add the geometry cache to `main.ts`**

Immediately after the existing `const toolbarHeight = ...` declaration (`main.ts:264`), add:

```ts
import { computeLayoutGeometry, type LayoutGeometry } from "./layout";

let currentGeometry: LayoutGeometry = computeLayoutGeometry({
  termCols: process.stdout.columns || 80,
  termRows: process.stdout.rows || 24,
  toolbarEnabled,
  windowBranchesEnabled,
  sidebarWidth,
  frameRulesEnabled: false, // plan 2 enables these
  footerEnabled: false,
  diffPanel: "off",
  diffPanelCols: 0,
});

/** Recompute the geometry from the live terminal size and panel state. */
function refreshGeometry(): LayoutGeometry {
  currentGeometry = computeLayoutGeometry({
    termCols: process.stdout.columns || 80,
    termRows: process.stdout.rows || 24,
    toolbarEnabled,
    windowBranchesEnabled,
    sidebarWidth,
    frameRulesEnabled: false,
    footerEnabled: false,
    diffPanel: diffPanel.isActive() ? diffPanel.mode : "off",
    diffPanelCols: diffPanel.isActive() ? getDiffPanelCols() : 0,
  });
  return currentGeometry;
}

/** Read the current geometry without recomputing. */
function geom(): LayoutGeometry {
  return currentGeometry;
}
```

- [ ] **Step 4: Replace every PTY-sizing site**

Each of these lines computes PTY rows by hand. Replace the expression with a
geometry read. The sites are `main.ts` lines 383, 386, 1049, 1061, 1094, 1337,
1713, 2026, 2057, 2732, 3542, and the two respawn/zoom paths that follow the
same shape.

Enumerate them first so none is missed:

```bash
grep -n "toolbarHeight\|sidebarTotal()" src/main.ts
```

**Three distinct quantities are involved and they are easy to confuse.** `main.ts`
uses the name `sidebarCols` for two different things: at line 979 it means
`sidebarTotal()`, i.e. sidebar width **plus** the divider column, whereas
`InputRouter`'s `sidebarCols` option means the width **without** the divider.
Map them by meaning, not by name:

| Existing expression | Meaning | Replacement |
|---|---|---|
| `rows - toolbarHeight` | PTY height | `geom().ptyRows` |
| `cols - sidebarTotal()` | main-area width | `geom().mainCols` |
| `sidebarShown ? sidebarTotal() : 0` | first main column | `geom().mainStartCol` |
| sidebar width alone (`InputRouter` option, hit tests) | sidebar width | `geom().sidebarCols` |

```ts
// before
const rows = toolbarEnabled ? (process.stdout.rows || 24) - toolbarHeight : (process.stdout.rows || 24);
// after
const rows = refreshGeometry().ptyRows;

// before  (main.ts:979 — despite the name, this is width + divider)
const sidebarCols = sidebarShown ? sidebarTotal() : 0;
const available = totalCols - sidebarCols;
// after
const available = geom().mainCols;
```

Call `refreshGeometry()` once at the top of any handler that reacts to a size or
panel change (SIGWINCH, diff toggle, zoom, respawn, sidebar-width config
change); use `geom()` everywhere else in that handler so a single frame never
sees two different geometries.

Replace `const sidebarVisible = cols >= 80` (`main.ts:384`) with
`const sidebarVisible = geom().sidebarCols > 0;` and delete the local `80`.

- [ ] **Step 5: Run the guard test to verify it passes**

Run: `bun test src/__tests__/layout-migration.test.ts`
Expected: PASS — both tests.

- [ ] **Step 6: Run the whole suite to verify nothing regressed**

Run: `bun test`
Expected: PASS. This plan changes no behaviour, so any failure here is a
migration error, not an expectation that needs updating. Do not edit a test to
make it pass in this task.

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no output, exit 0.

- [ ] **Step 8: Manual smoke test**

Run: `bun run dev`
Verify: the sidebar, toolbar and tmux content render exactly as before; resize
the terminal wider and narrower than 80 columns and confirm the sidebar
disappears and reappears with no stray row at the bottom; toggle the diff panel
with the `◈` button and confirm the split still sizes correctly.

- [ ] **Step 9: Commit**

```bash
git add src/main.ts src/__tests__/layout-migration.test.ts
git commit -m "refactor(layout): derive every PTY size from the geometry

Thirteen open-coded (rows - toolbarHeight) expressions became reads from
computeLayoutGeometry. A guard test fails if one reappears, because the
failure mode is tmux rendering at the wrong height rather than a crash.
No behaviour change."
```

---

### Task 3: Split `InputRouter`'s overloaded `toolbarRows`

**Files:**
- Modify: `src/input-router.ts:106,113,264,347,384,391,399,414`
- Test: `src/__tests__/input-router.test.ts:299` and surrounding coordinate tests

**Interfaces:**
- Consumes: `LayoutGeometry` from Task 1; `geom()` output passed in from Task 2.
- Produces: `InputRouter.setGeometry(g: LayoutGeometry): void` replacing `setToolbarRows(n: number)`, and `InputRouter.classifyRow(y1: number): "toolbar" | "rule" | "content" | "footer"` (exported for tests). Task 4 does not consume these.

- [ ] **Step 1: Write the failing tests**

Append a new top-level `describe` to `src/__tests__/input-router.test.ts`. It
builds its own router rather than reusing the `makeRouter` helper at line 233,
which is scoped to the "link click" describe and hard-codes a `getLinkAt`:

```ts
import { computeLayoutGeometry, type LayoutInput } from "../layout";

describe("InputRouter row classification", () => {
  const geometry = (over: Partial<LayoutInput> = {}) =>
    computeLayoutGeometry({
      termCols: 200,
      termRows: 50,
      toolbarEnabled: true,
      windowBranchesEnabled: false,
      sidebarWidth: 26,
      frameRulesEnabled: true,
      footerEnabled: true,
      diffPanel: "off",
      diffPanelCols: 0,
      ...over,
    });

  const makeRouter = (sink: { pty: string; toolbar: number[] }) =>
    new InputRouter(
      {
        sidebarCols: 26,
        onPtyData: (d) => { sink.pty += d; },
        onSidebarClick: () => {},
        onToolbarClick: (col) => { sink.toolbar.push(col); },
      },
      true,
    );

  /** Third field of an SGR mouse report: `\x1b[<b;x;yM`. */
  const sgrY = (data: string): number => {
    const m = data.match(/\x1b\[<\d+;\d+;(\d+)[Mm]/);
    if (!m) throw new Error(`not an SGR mouse report: ${JSON.stringify(data)}`);
    return Number(m[1]);
  };

  test("classifies every band with a one-row toolbar", () => {
    const router = makeRouter({ pty: "", toolbar: [] });
    router.setGeometry(geometry());
    // Mouse rows are 1-indexed on the wire; bands are 0-indexed.
    expect(router.classifyRow(1)).toBe("toolbar"); // row 0
    expect(router.classifyRow(2)).toBe("rule");    // row 1  — the frame rule
    expect(router.classifyRow(3)).toBe("content"); // row 2
    expect(router.classifyRow(49)).toBe("rule");   // row 48 — the footer rule
    expect(router.classifyRow(50)).toBe("footer"); // row 49
  });

  test("classifies every band with a two-row toolbar", () => {
    const router = makeRouter({ pty: "", toolbar: [] });
    router.setGeometry(geometry({ windowBranchesEnabled: true }));
    expect(router.classifyRow(1)).toBe("toolbar");
    expect(router.classifyRow(2)).toBe("toolbar");
    expect(router.classifyRow(3)).toBe("rule");
    expect(router.classifyRow(4)).toBe("content");
  });

  test("the frame rule is inert — no toolbar action and nothing forwarded", () => {
    const sink = { pty: "", toolbar: [] as number[] };
    const router = makeRouter(sink);
    router.setMainCols(173);
    router.setGeometry(geometry());
    router.handleInput("\x1b[<0;100;2M"); // terminal row 2 == the frame rule
    expect(sink.toolbar).toEqual([]);
    expect(sink.pty).toBe("");
  });

  test("content clicks are forwarded offset by contentTop, not by toolbarRows", () => {
    const sink = { pty: "", toolbar: [] as number[] };
    const router = makeRouter(sink);
    router.setMainCols(173);
    const g = geometry();
    router.setGeometry(g);
    router.handleInput("\x1b[<0;100;5M"); // terminal row 5
    expect(sgrY(sink.pty)).toBe(5 - g.contentTop);
  });
});
```

If `InputRouter`'s options type has no `onToolbarClick`, use whatever the
existing option is actually named — check the `InputRouterOpts` interface at the
top of `src/input-router.ts` and match it.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/__tests__/input-router.test.ts -t "row classification"`
Expected: FAIL — `router.setGeometry is not a function`.

- [ ] **Step 3: Replace the field with geometry**

In `src/input-router.ts`, delete `private toolbarRows = 1;` (line 106) and
`setToolbarRows` (line 113), and add:

```ts
import type { LayoutGeometry } from "./layout";

private geometry: LayoutGeometry | null = null;

setGeometry(g: LayoutGeometry): void {
  this.geometry = g;
}

/** Classify a 1-indexed wire row into its chrome band. */
classifyRow(y1: number): "toolbar" | "rule" | "content" | "footer" {
  const g = this.geometry;
  if (!g) return "content";
  const row = y1 - 1;
  if (row < g.toolbarRows) return "toolbar";
  if (row === g.topRuleRow || row === g.footerRuleRow) return "rule";
  if (row === g.footerRow) return "footer";
  return "content";
}

/** First content row, 0-indexed. Used to translate y for tmux and the panel. */
private contentTop(): number {
  return this.geometry?.contentTop ?? 1;
}
```

- [ ] **Step 4: Update each of the eight call sites**

```ts
// line 264 (hover) and line 347 (click) — hit region
if (mouse.y <= this.toolbarRows) { …          // before
if (this.classifyRow(mouse.y) === "toolbar") { …  // after

// lines 384 and 391 — panel row offset
const panelRow = mouse.y - 1 - this.toolbarRows;  // before
const panelRow = mouse.y - 1 - this.contentTop(); // after

// lines 399 and 414 — forwarding to tmux
const translated = translateMouse(data, dividerX, this.toolbarRows);              // before
const translated = translateMouse(data, dividerX, this.contentTop());             // after
const mainTranslated = translateMouse(data, this.opts.sidebarCols + 1, this.toolbarRows);   // before
const mainTranslated = translateMouse(data, this.opts.sidebarCols + 1, this.contentTop());  // after
```

Then, immediately before the existing routing branches, swallow inert rows:

```ts
const band = this.classifyRow(mouse.y);
if (band === "rule") return;
```

- [ ] **Step 5: Wire it up in `main.ts`**

Replace `inputRouter.setToolbarRows(toolbarHeight);` (`main.ts:2153`) with
`inputRouter.setGeometry(geom());`, and add the same call to the end of
`refreshGeometry()` so the router can never hold a stale geometry:

```ts
function refreshGeometry(): LayoutGeometry {
  currentGeometry = computeLayoutGeometry({ /* …as in Task 2… */ });
  inputRouter.setGeometry(currentGeometry);
  return currentGeometry;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: PASS. The pre-existing diff-panel mouse test at line 299 assumes a
one-row offset; with `frameRulesEnabled: false` in production the offset is
still one, so it should pass unchanged. If it fails, the geometry being passed
in the test does not match the one the assertion was written against — fix the
test's geometry, not the router.

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: both clean.

- [ ] **Step 8: Manual smoke test**

Run: `bun run dev`
Verify: clicking a tab still switches windows; clicking in the tmux area places
the cursor on **the row you clicked** (this is the regression this task exists
to prevent — click a specific line of text in a pager and confirm it lands
there); mouse wheel still scrolls tmux; clicking a sidebar row still switches
session; dragging a tmux pane divider still works.

- [ ] **Step 9: Commit**

```bash
git add src/input-router.ts src/__tests__/input-router.test.ts src/main.ts
git commit -m "refactor(input): split the toolbar hit region from the content offset

InputRouter.toolbarRows meant two things at once — the clickable toolbar band
and the y-offset used to translate mouse events for tmux. A non-clickable rule
row between them forces those apart; conflating them displaces every forwarded
mouse event by one row. Rows are now classified explicitly against the layout
geometry, and rule rows are inert."
```

---

### Task 4: Remove the renderer's no-sidebar early return

**Files:**
- Modify: `src/renderer.ts:206`
- Test: `src/__tests__/renderer.test.ts:89` (replace)

**Interfaces:**
- Consumes: `LayoutGeometry` from Task 1.
- Produces: no new exports. `compositeGrids` keeps its signature; `sidebar` being `null` stops being a special case.

**Context — this task fixes a live bug.** Below 80 columns `sidebarVisible` is
false, so `compositeGrids` returns the `main` grid directly. But `main` is
`ptyRows` tall — one row shorter than the terminal — and no toolbar is
composited, while `main.ts` still sized the PTY as though a toolbar existed. So
a narrow terminal today renders one row short and loses its toolbar. Fixing it
is the one visible change in this plan.

- [ ] **Step 1: Write the failing test**

Replace the test at `src/__tests__/renderer.test.ts:89` (which asserts the early
return) with:

```ts
test("composites the toolbar and fills the terminal when there is no sidebar", () => {
  const main = createGrid(79, 23);       // ptyRows = termRows - toolbarRows
  writeString(main, 0, 0, "hello", {});
  const toolbar: ToolbarConfig = {
    buttons: [{ label: "+", id: "new-window" }],
    mainCols: 79,
    tabs: [{ windowId: "@1", name: "zsh", active: true }],
    toolbarRows: 1,
  };

  const out = compositeGrids(main, null, toolbar);

  expect(out.cols).toBe(79);
  expect(out.rows).toBe(24);                       // full terminal, not 23
  expect(rowText(out, 0)).toContain("zsh");        // toolbar composited
  expect(rowText(out, 1)).toContain("hello");      // content pushed below it
});
```

`rowText` does not exist in this file. Add it beside the existing helpers:

```ts
const rowText = (g: CellGrid, r: number): string =>
  g.cells[r].map((c) => c.char).join("");
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/__tests__/renderer.test.ts -t "no sidebar"`
Expected: FAIL — `expect(out.rows).toBe(24)` receives 23, because the early
return hands back `main` untouched.

- [ ] **Step 3: Remove the early return**

In `src/renderer.ts`, delete line 206:

```ts
if (!sidebar) return main;
```

Then make the sidebar and its divider conditional in the composition below.
Wherever the existing code writes the sidebar grid or the divider column, guard
it:

```ts
const hasSidebar = sidebar !== null;
const sidebarCols = hasSidebar ? sidebar.cols : 0;
const borderCol = hasSidebar ? sidebarCols : -1;
```

and skip the sidebar copy loop and the divider write when `hasSidebar` is false.
Every other layer — toolbar, modal overlay, diff panel — runs unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/__tests__/renderer.test.ts`
Expected: PASS — the whole file.

- [ ] **Step 5: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: both clean.

- [ ] **Step 6: Manual smoke test**

Run: `bun run dev`, then narrow the terminal below 80 columns.
Verify: the sidebar disappears, the toolbar **stays** (it vanishes today), the
tmux content fills to the last row with no stale line at the bottom, and the
tab buttons remain clickable. Widen again and confirm the sidebar returns.

- [ ] **Step 7: Commit**

```bash
git add src/renderer.ts src/__tests__/renderer.test.ts
git commit -m "fix(renderer): composite chrome when the sidebar is hidden

compositeGrids returned the main grid untouched whenever the sidebar was
suppressed, so terminals under 80 columns lost the toolbar and rendered one
row short — main.ts had already sized the PTY as though a toolbar existed.
The sidebar and its divider are now optional components of a compositor that
always runs."
```

---

## Verification

After all four tasks:

- [ ] `bun test` — full suite passes.
- [ ] `bun run typecheck` — clean.
- [ ] `bun run docker` — clean-environment sanity check.
- [ ] `grep -n "toolbarHeight" src/main.ts` returns only the declaration.
- [ ] At ≥80 columns, jmux is pixel-identical to `main` before this plan.
- [ ] At <80 columns, the toolbar renders and the content fills the terminal.

## What this plan deliberately does not do

The geometry supports `frameRulesEnabled` and `footerEnabled`, and both are
tested, but production always passes `false`. Turning them on is the first step
of plan 2, along with the colour tokens, the tab underline, the footer model,
and the toolbar glyph corrections. Nothing in this plan changes what jmux looks
like at normal terminal widths.
