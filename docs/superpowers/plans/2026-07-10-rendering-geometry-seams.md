# Rendering & Geometry Seams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the three shallow layers under jmux's UI so geometry and cell-drawing each have one home instead of being copy-pasted across `main.ts`, `renderer.ts`, `input-router.ts`, and `glass/view.ts`. Concretely: (1) a single frame-layout source of truth consumed by both the renderer and the input router, (2) a shared set of cell-drawing primitives that own the wide-char continuation cell, box drawing, and chip truncation, and (3) a band-layout pattern where chip placement is computed once and feeds both paint and hit-test.

**Architecture:** Three seams, landed bottom-up in the order the user chose (frame first):

- **Seam 2 — Frame layout.** New pure module `src/frame-layout.ts` owns `FrameLayout` (column spans of sidebar │ main │ divider │ panel, in 0-indexed grid columns) and `computeFrameLayout`. `main.ts` gains one `relayout()` that replaces five duplicated resize blocks. `InputRouter` drops five geometry fields for one `setLayout()`. `compositeGrids` reads positions from the same `FrameLayout`. Two adapters (router + renderer) consuming one interface make this a real seam. Fixes a live stale-geometry hit-test bug.
- **Seam 1 — Draw primitives.** `src/cell-grid.ts` gains `writeCell`, `blit`, `writeStyledLine`, `truncateToCols`, and `drawBox`. The four hand-copied continuation-cell blocks, four box/border drawers, and four chip-truncation implementations collapse onto these.
- **Seam 3 — Band layout.** New pure module `src/band-layout.ts` owns `packChips` (geometry) + `chipAtCol` (hit-test) over `PlacedChip[]`. The toolbar, the Command Center tab strip, and the info-panel tab bar each compute placed chips once (carrying their styled segments) and feed both their paint loop and their hit-test. `glass/strip.ts` already does this; the others adopt the pattern.

**Tech Stack:** Bun 1.3.8+, TypeScript (strict), `bun test`, `bun:test` (`describe`/`test`/`expect`). No new dependencies.

## Global Constraints

- Target **Bun, not Node**. No new runtime deps; pure logic modules only.
- **All spans are 0-indexed grid columns.** The mouse coordinate is 1-indexed; the input router converts it to grid space exactly once at entry, then reads spans. No scattered `+1`/`-1` in hit-testing.
- **The continuation-cell rule lives in exactly one place** (`writeCell`/`blit`): a width-2 cell is followed by a width-0 cell carrying the same background. After this plan, no surface hand-writes a `{ char: "", width: 0 }` cell.
- **`cellWidth` (`cell-grid.ts:62`) stays the single width table.** `charDisplayWidth`/`stringDisplayWidth` in `renderer.ts` and the private `textCols` clone in `strip.ts` are deleted in favor of `textCols`/`truncateToCols` from `cell-grid.ts` (the CLAUDE.md agreement hazard).
- **Depth over parameter-bags.** No monolithic `chip()` widget. Chips are thin compositions of `writeStyledLine` + `truncateToCols`; box labels reuse the same truncation. `packChips` is geometry only — each band builds its own `StyledSegment[]`.
- **Tests are pure unit tests** over logic modules — no spawning tmux, no real terminal. `computeFrameLayout`, `packChips`, and the cell-grid primitives are all pure and asserted against constructed grids/fixtures. This mirrors the existing `src/__tests__/*` discipline (CLAUDE.md).
- Run `bun test` and `bun run typecheck` green before each commit. One seam per commit-group; tasks within a seam are individually committable.
- **No behavior change is intended** except the two bug fixes called out explicitly (stale router geometry after a sidebar-width change; the config-watcher missing `setMainCols`). Frame diffing (`renderer.ts:571`) means an unchanged frame must still diff to zero rows — assert this where feasible.

---

## File Structure

- **Create** `src/frame-layout.ts` — `Span`, `PanelMode`, `FrameLayout`, `FrameLayoutInput`, `computeFrameLayout`. One responsibility: the column geometry of the whole frame.
- **Create** `src/__tests__/frame-layout.test.ts` — unit tests for `computeFrameLayout`.
- **Create** `src/band-layout.ts` — `PlacedChip`, `packChips`, `chipAtCol`. One responsibility: chip placement + hit-test within a horizontal band.
- **Create** `src/__tests__/band-layout.test.ts` — unit tests for `packChips`/`chipAtCol`.
- **Modify** `src/cell-grid.ts` — add `writeCell`, `blit`, `writeStyledLine`, `truncateToCols`, `drawBox`.
- **Modify** `src/__tests__/cell-grid.test.ts` — tests for the new primitives (continuation cell, blit clipping, box, truncation).
- **Modify** `src/main.ts` — add `relayout()`; replace the five resize blocks (`toggleDiffPanel` ~921, `zoomDiffPanel` ~954, `SIGWINCH` ~3413, config-watcher sidebar-width ~3514, config-watcher infoPanelWidth ~3539); hold the current `FrameLayout`; pass it to `renderer.render` and `inputRouter.setLayout`.
- **Modify** `src/input-router.ts` — replace `sidebarCols`/`mainCols`/`diffPanelCols`/`toolbarRows`/`sidebarVisible` with `layout: FrameLayout` + `setLayout()`; rewrite the mouse hit-test block to read spans.
- **Modify** `src/__tests__/input-router.test.ts` — drive via `setLayout(fixture)`; add the stale-width regression test.
- **Modify** `src/renderer.ts` — `compositeGrids`/`render` take `FrameLayout`; positions read from it; `renderWindowBranchRow`, modal border, and toolbar loops route through the new primitives + band layout; delete `charDisplayWidth`/`stringDisplayWidth`.
- **Modify** `src/glass/view.ts` — tile border via `drawBox`, interior via `blit`; delete `drawBorderRow` and the hand-rolled blit.
- **Modify** `src/glass/strip.ts` — consume `packChips`/`chipAtCol`; delete the private `textCols`.
- **Modify** `src/info-panel.ts` — tab bar via `packChips` + placed chips feeding both `getTabBarGrid` paint and `getTabRanges` hit-test.

---

## Seam 2 — Frame layout (land first)

### Task 1: `FrameLayout` type and pure `computeFrameLayout`

**Files:**
- Create: `src/frame-layout.ts`
- Test: `src/__tests__/frame-layout.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type Span = { x: number; w: number }` — 0-indexed grid columns.
  - `type PanelMode = "single" | "split" | "full"`
  - `interface FrameLayoutInput { termCols: number; termRows: number; sidebarWidth: number; borderWidth: number; toolbarRows: number; diffState: "off" | "split" | "full"; requestedPanelCols: number }`
  - `interface FrameLayout { termCols: number; termRows: number; sidebar: Span | null; borderCol: number | null; toolbarRows: number; ptyRows: number; mode: PanelMode; main: Span; divider: number | null; panel: Span | null }`
  - `const SIDEBAR_MIN_TERM_COLS = 80`
  - `function computeFrameLayout(input: FrameLayoutInput): FrameLayout`

**Semantics (encode as tests):**
- `sidebar` is `{ x: 0, w: sidebarWidth }` when `termCols >= SIDEBAR_MIN_TERM_COLS`, else `null` (auto-hide). `borderCol` = `sidebar.x + sidebar.w` when shown, else `null`.
- `ptyRows = termRows - toolbarRows`.
- `mainStart = sidebar ? borderCol + 1 : 0`. `available = termCols - mainStart`.
- **`pty is ALWAYS resized to `main.w`.** `mode: "single"` (diffState off): `main = { x: mainStart, w: available }`, `divider = null`, `panel = null`.
- `mode: "split"`: `panel.w = requestedPanelCols`; `main = { x: mainStart, w: available - panel.w - 1 }`; `divider = main.x + main.w`; `panel = { x: divider + 1, w: requestedPanelCols }`.
- `mode: "full"`: `main = { x: mainStart, w: available }` (pty kept full-width, visually covered); `divider = null`; `panel = { x: mainStart, w: available }` — **panel overlaps main.x**, which is what replaces the old `setMainCols(0)` hack. Consumers decide "in panel?" via `panel && gridX >= panel.x`.

- [ ] **Step 1: Write the failing test** — cover single/split/full × sidebar shown/hidden (narrow terminal) × the full-mode overlap. Assert every field including `ptyRows` and that split `main.w + 1 + panel.w == available`.
- [ ] **Step 2: Implement `computeFrameLayout`.**
- [ ] **Step 3: `bun test src/__tests__/frame-layout.test.ts` green; `bun run typecheck` green. Commit.**

### Task 2: `relayout()` consolidation in `main.ts`

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `computeFrameLayout`, current module state (`sidebarWidth`, `toolbarHeight`, `diffPanel.state`, `calcSplitPanelCols`, term size).
- Produces: a module-level `let layout: FrameLayout` and `function relayout(): void` that (a) computes the layout from current inputs, (b) resizes `pty`/`bridge` to `layout.main.w × layout.ptyRows`, (c) resizes `diffPty`/`diffBridge` to `layout.panel` when present, (d) calls `inputRouter.setLayout(layout)`, (e) resizes `sidebar`, (f) `scheduleRender()`.

**Notes:**
- `requestedPanelCols` for the input = `calcSplitPanelCols(available)` in split, `available` in full, `0` in off. Keep `calcSplitPanelCols`/`infoPanelWidth` as the panel-width policy; `computeFrameLayout` only places the result.
- Replace the bodies of `toggleDiffPanel` (~930–949), `zoomDiffPanel` (~963–986), the `SIGWINCH` handler (~3429–3458), the config-watcher sidebar-width branch (~3516–3531), and the config-watcher infoPanelWidth branch (~3539–3556): each mutates only the input that changed (`diffPanel.toggle()` / `diffPanel.toggleZoom()` / `sidebarWidth = newWidth` / term size) then calls `relayout()`.
- `mainCols`, `sidebarTotal()`, `getDiffPanelCols()` become thin readers over `layout` (or are deleted where only `layout` is now needed). `sidebarShown` becomes `layout.sidebar !== null`.

- [ ] **Step 1: Add `relayout()` and the `layout` global; route the initial boot sizing through it.**
- [ ] **Step 2: Replace the five resize blocks with `relayout()` calls.**
- [ ] **Step 3: Manual/scripted verification** — `bun run dev`, toggle diff panel (split/full/off), resize the terminal, change `sidebarWidth` in config: main pane, divider, and panel stay aligned; no ghost columns. `bun run typecheck` green. Commit.

### Task 3: `InputRouter` adapter — `setLayout`, spans-based hit-testing (fixes the bug)

**Files:**
- Modify: `src/input-router.ts`
- Test: `src/__tests__/input-router.test.ts`

**Interfaces:**
- Consumes: `FrameLayout`.
- Produces: `setLayout(layout: FrameLayout): void` replacing `setSidebarVisible`, `setMainCols`, `setDiffPanel`, `setToolbarRows` and the constructor `sidebarCols`. Internal hit-testing reads `this.layout`.

**Rewrite map (mouse block, `input-router.ts:253–419`):**
- Convert `gridX = mouse.x - 1`, `gridY = mouse.y - 1` once.
- Sidebar hit: `layout.sidebar && gridX < layout.sidebar.w`.
- Toolbar hit: `gridY < layout.toolbarRows` (main-relative col = `gridX - layout.main.x`).
- Divider: `layout.divider` (compare `gridX === layout.divider`).
- Panel: `layout.panel && gridX >= layout.panel.x` (panel-relative col = `gridX - layout.panel.x`). This unifies split and full (full overlaps `main.x`).
- `translateMouse` offsets become `layout.main.x` and `layout.panel.x` (drop the `sidebarCols + 1` / `dividerX + 1` arithmetic and `BORDER_WIDTH` assumption).

- [ ] **Step 1: Write the failing regression test** — construct a router, `setLayout(layoutWidth26)`, assert a click at the 26/27 boundary routes to sidebar vs main; then `setLayout(layoutWidth40)` and assert the boundary moved to 40/41. This fails today (no setter; stale `sidebarCols`).
- [ ] **Step 2: Add tests for toolbar/divider/panel routing under split and full layouts** (full: a content-area click routes to panel, not main).
- [ ] **Step 3: Implement `setLayout` + the spans rewrite; update `main.ts` construction/wiring to call `setLayout` (via `relayout`).**
- [ ] **Step 4: `bun test src/__tests__/input-router.test.ts` green; full `bun test` + `bun run typecheck` green. Commit.**

### Task 4: `compositeGrids` adapter — read positions from `FrameLayout`

**Files:**
- Modify: `src/renderer.ts`
- Test: `src/__tests__/` (existing renderer/composite coverage)

**Interfaces:**
- Consumes: `FrameLayout`.
- Produces: `render(...)`/`compositeGrids(...)` take `FrameLayout`; `borderCol`, `dividerCol`, `panelStartCol`, `totalCols`, `toolbarRows` are read from it instead of re-derived from grid sizes (`renderer.ts:208–222, 230, 379, 401–407`).

**Notes:**
- `main.ts` sizes the content grids from `layout` (Task 2), so renderer and router now read the identical object — they cannot drift.
- Full mode: paint the panel grid at `layout.panel.x` (== `main.x`); no separate "full replaces main" branch keyed on grid width.
- Keep this task purely mechanical: same pixels out, positions sourced from `layout`. Verify with the frame-diff (an unchanged frame → zero changed rows).

- [ ] **Step 1: Thread `FrameLayout` into `render`/`compositeGrids`; replace derived geometry with layout reads.**
- [ ] **Step 2: Verify no visual change** (`bun run dev`, compare toolbar/divider/panel/modal placement in single/split/full).
- [ ] **Step 3: `bun test` + `bun run typecheck` green. Commit. (End of Seam 2.)**

---

## Seam 1 — Draw primitives

### Task 5: `writeCell` + `blit` in `cell-grid.ts`

**Files:**
- Modify: `src/cell-grid.ts`
- Test: `src/__tests__/cell-grid.test.ts`

**Interfaces:**
- `function writeCell(grid: CellGrid, row: number, col: number, ch: string, attrs?: CellAttrs): number` — writes the cell and, for a width-2 glyph, the trailing width-0 continuation cell (same bg); returns the advance (1 or 2); no-ops out of bounds; refuses a wide glyph that would overflow the row (matches `writeString:99`). This is the sole owner of the continuation-cell rule.
- `function blit(dst: CellGrid, src: CellGrid, opts: { destX: number; destY: number; srcX?: number; srcY?: number; w?: number; h?: number }): void` — copies a clipped rectangle, replacing a width-2 cell that would overflow the copy width with a space carrying the source attributes (matches `glass/view.ts:565`).

**Adopt at:**
- `compositeGrids` sidebar/main/panel copy loops (`renderer.ts:226–228, 366–368, 372–374, 388–390, 408–410`) → `blit`.
- `glass/view.ts` interior copy (`555–593`) → `blit`; delete the field-by-field loop.

- [ ] **Step 1: Write failing tests** — `writeCell` continuation cell + bg propagation + overflow refusal; `blit` clipping + wide-edge-to-space.
- [ ] **Step 2: Implement both; refactor the five composite copy loops and the glass interior blit onto them.**
- [ ] **Step 3: `bun test` + `bun run typecheck` green; `bun run dev` shows identical output (esp. wide-char/emoji panes and tile interiors). Commit.**

### Task 6: `writeStyledLine` + `truncateToCols` + `drawBox`

**Files:**
- Modify: `src/cell-grid.ts`, `src/renderer.ts`, `src/glass/view.ts`
- Test: `src/__tests__/cell-grid.test.ts`

**Interfaces:**
- `function truncateToCols(text: string, maxCols: number): string` — truncate by display width, append `"…"` when clipped. Replaces the ad-hoc `slice(0, n-1) + "…"` in `renderer.ts:169`, `glass/view.ts:676`, `sidebar.ts`, `panel-view-renderer.ts`.
- `function writeStyledLine(grid, row: number, col: number, segments: StyledSegment[], maxCols?: number): number` — writes segments left-to-right via `writeCell`, clipped to `maxCols`; returns columns consumed. `StyledSegment`/`StyledLine` already exist (`cell-grid.ts:42`) but are currently unused — this is their consumer.
- `function drawBox(grid, rect: { x: number; y: number; w: number; h: number }, opts: { border: CellAttrs; label?: string; labelAttrs?: CellAttrs }): void` — corners + edges via `writeCell`; optional top-label chip (` label `) truncated via `truncateToCols`. Folds `glass/view.ts` `drawBorderRow` (`601–689`) + side-border loop (`524–546`) and the modal border in `renderer.ts` (`436–470`) into one.

**Adopt at:**
- Toolbar tab / button / status-chip paint loops (`renderer.ts:250–357`) and `renderWindowBranchRow` (`153–192`) → build `StyledSegment[]` and call `writeStyledLine` (kills the four hand-copied continuation blocks; the icon-vs-space fg variance in buttons becomes two segments).
- Modal overlay border (`renderer.ts:436–470`) → `drawBox`.
- `glass/view.ts` tile border (`drawTile`) → `drawBox`; delete `drawBorderRow`.

- [ ] **Step 1: Write failing tests** — `truncateToCols` boundary cases (exact fit, one-over, wide-char boundary); `writeStyledLine` multi-segment + clip + wide char; `drawBox` corners/edges + label truncation.
- [ ] **Step 2: Implement all three; refactor the toolbar loops, modal border, and glass tile border onto them; delete `charDisplayWidth`/`stringDisplayWidth` (`renderer.ts:71–81`) in favor of `textCols`.**
- [ ] **Step 3: `bun test` + `bun run typecheck` green; `bun run dev` — toolbar chips, modal border/shadow, and Command Center tile borders unchanged. Commit. (End of Seam 1.)**

---

## Seam 3 — Band layout

### Task 7: `packChips` + `chipAtCol`; adopt in toolbar, strip, info-panel

**Files:**
- Create: `src/band-layout.ts`
- Test: `src/__tests__/band-layout.test.ts`
- Modify: `src/renderer.ts`, `src/glass/strip.ts`, `src/info-panel.ts`

**Interfaces:**
- `interface PlacedChip { id: string; x: number; width: number }`
- `function packChips(items: { id: string; width: number }[], opts: { start: number; budget: number; align: "left" | "right"; gap?: number; sepWidth?: number }): PlacedChip[]` — places whole chips only (no partial), left- or right-aligned, honoring `gap`/`sepWidth`; stops at `budget`. Generalizes `layoutStrip` (`strip.ts:40`) and the right-packing in `getToolbarButtonRanges` (`renderer.ts:84`).
- `function chipAtCol(chips: PlacedChip[], col: number): string | null` — generalizes `chipAtX` (`strip.ts:67`).

**Adopt at (each: layout once → paint via `writeStyledLine` + hit-test via `chipAtCol`):**
- **Toolbar** (`renderer.ts`): a single `layoutToolbar(toolbar)` returns placed tabs (left), status chip + buttons (right), each carrying its `StyledSegment[]`. `compositeGrids` paints from it; `getToolbarTabRanges`/`getToolbarButtonRanges`/`getToolbarStatusChipRange` become thin wrappers (or are replaced) reading the same placement. Closes the label-formula duplication (the ` name ` padding + zoom suffix + separator now live once).
- **Strip** (`glass/strip.ts`): `layoutStrip` → `packChips`; `chipAtX` → `chipAtCol`; delete the private `textCols` (use `cell-grid.ts` `textCols`). Keep the strip-specific dot-recolor and `+N` overflow as strip concerns.
- **Info-panel** (`info-panel.ts`): `getTabBarGrid` (paint) and `getTabRanges` (hit-test) both consume one `packChips` result.

- [ ] **Step 1: Write failing tests** — `packChips` left/right align, gap/separator, overflow truncation (whole chips only); `chipAtCol` boundaries.
- [ ] **Step 2: Implement `band-layout.ts`; refactor strip, toolbar, and info-panel to compute placed chips once and drive both paint and hit-test from them.**
- [ ] **Step 3: `bun test` + `bun run typecheck` green; `bun run dev` — window tabs, action buttons, CC tab strip, and info-panel tabs render and click-target identically. Commit. (End of Seam 3.)**

---

## Verification summary

- **Bug fixed (Task 3):** after a runtime sidebar-width change, sidebar/main/divider/panel hit-testing is correct — covered by the stale-width regression test and the config-watcher no longer needing (and no longer missing) a `setMainCols` call.
- **Deletion test held:** removing `frame-layout.ts` reinstates geometry arithmetic in 5 resize sites + 2 hit-test/paint files; removing the cell-grid primitives reinstates 4 continuation blocks, 4 box drawers, 4 truncations; removing `band-layout.ts` reinstates parallel paint/hit-test chip math. Each concentrates real, currently-divergent complexity.
- **New test surface:** `computeFrameLayout`, `packChips`, `writeCell`/`blit`/`drawBox`/`truncateToCols`/`writeStyledLine`, and router hit-testing via `setLayout` — all pure, none requiring tmux or a real terminal.
