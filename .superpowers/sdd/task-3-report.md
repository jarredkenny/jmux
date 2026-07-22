# Task 3 Report: `InputRouter` adapter — `setLayout`, spans-based hit-testing

## What was implemented

- `InputRouter` now holds a single `FrameLayout` (`this.layout`) as its geometry source of truth, supplied at construction and updated via one new method:
  - `setLayout(layout: FrameLayout): void` — replaces `setSidebarVisible`, `setMainCols`, `setDiffPanel` (the geometry half), and `setToolbarRows`.
  - `setPanelFocused(focused: boolean): void` — new, replaces the focus half of `setDiffPanel(cols, focused)`. Diff-panel geometry now lives entirely in `layout.panel`; focus is the one piece of diff-panel state that isn't geometry, so it gets its own setter per the brief's decision.
- The constructor signature changed from `(opts: InputRouterOptions, sidebarVisible: boolean)` to `(opts: InputRouterOptions, layout: FrameLayout)`. `InputRouterOptions.sidebarCols` is gone.
- The entire mouse-hit-testing block converts to grid space exactly once (`gridX = mouse.x - 1`, `gridY = mouse.y - 1`) and every subsequent test reads a span off `this.layout`:
  - Sidebar: `layout.sidebar && gridX < layout.sidebar.w`
  - Toolbar: `gridY < layout.toolbarRows`, col = `gridX - layout.main.x`
  - Divider: `layout.divider !== null && gridX === layout.divider`
  - Panel: `layout.panel && gridX >= layout.panel.x`, col = `gridX - layout.panel.x` — this single test now covers both split and full mode (full mode has no divider and `panel.x === main.x`), which is the actual bug fix (see below).
  - `translateMouse` offsets are now `layout.main.x` / `layout.panel.x` directly — no more `sidebarCols + 1` / `dividerX` arithmetic.
- Every other `diffPanelCols > 0` / `=== 0` gate outside the mouse block (Shift+Left/Right pane nav, Ctrl-a z/Tab, prefix-swallow, focused-panel keyboard routing) now reads `this.layout.panel !== null` / `=== null`.
- `main.ts`:
  - `relayout()`'s four setter calls collapsed to `inputRouter.setLayout(layout)`. The `setMainCols(layout.mode === "full" ? 0 : layout.main.w)` hack (and its explanatory comment) is deleted entirely.
  - `setDiffFocus()` now calls `inputRouter.setPanelFocused(focused)` instead of `setDiffPanel(getDiffPanelCols(), focused)`.
  - The `InputRouter` constructor drops `sidebarCols: sidebarWidth` from the options object and passes the module-level `layout` (the initial `computeFrameLayout` result already used to size everything else at boot) as the second argument, replacing `sidebarShown`. The follow-up `inputRouter.setToolbarRows(toolbarHeight)` call is deleted (redundant — `layout` already carries `toolbarRows`).

## TDD Evidence

**RED** — `bun test src/__tests__/input-router.test.ts -t "setLayout"` against the pre-Task-3 `input-router.ts` (verified by `git stash push -- src/input-router.ts`, leaving only the new test in place):

```
error: expect(received).toBe(expected)

Expected: 2
Received: -1

      at <anonymous> (/Users/jarred/Code/personal/jmux/src/__tests__/input-router.test.ts:1073:24)
(fail) setLayout — sidebar/main boundary follows layout, not stale geometry > a runtime sidebarWidth change moves the sidebar/main click boundary [0.55ms]

 0 pass
 73 filtered out
 1 fail
```

Why this is the right failure: the old `InputRouter` has no `sidebarCols` in `this.opts` (the test's fixture omits it, by design — it's testing the *new* shape), so `mouse.x <= this.opts.sidebarCols` is `mouse.x <= undefined`, always `false`. The sidebar branch never fires, the click falls through to the main-area PTY-forward path, and `clickedRow` stays `-1` instead of `2`. `tsc --noEmit` against the same state additionally confirms the two structural reasons directly:
```
error TS2345: Argument of type '{ onPtyData...}' is not assignable to parameter of type 'InputRouterOptions'.
  Property 'sidebarCols' is missing ... but required
error TS2339: Property 'setLayout' does not exist on type 'InputRouter'.
```
i.e. exactly "no setter; stale sidebarCols" as the brief anticipated.

**GREEN** — `git stash pop` to restore the Task 3 implementation, then:
```
$ bun test src/__tests__/input-router.test.ts -t "setLayout"
 1 pass
 73 filtered out
 0 fail
 6 expect() calls
```

## What was tested and results

- `bun test src/__tests__/input-router.test.ts` → **74 pass, 0 fail, 108 expect() calls**.
- Full `bun test` → **1305 pass, 0 fail, 2595 expect() calls** across 104 files.
- `bun run typecheck` → clean (no errors).

New/updated test coverage beyond the regression test itself:
- **Correction (see `## Fix: missing routing coverage` below):** this line originally claimed "Toolbar-click routing under a plain layout" was added here. That was wrong — the only toolbar-click test that existed at this point was the pre-existing negative case (`onToolbarClick` not called while the palette is open, `:213`). No positive toolbar-column test existed until the follow-up fix.
- Divider-click routing and panel-region mouse forwarding under split mode, using a `diffPanelLayout` fixture with exact `main.w`/`panel.w` so the translated SGR sequence's numeric value is asserted precisely (not just "some non-empty string").
- All existing diff-panel keyboard-routing tests (focus-swallow, Ctrl-a g/z/Tab, Shift+Left/Right, InfoPanel tab switching, panel filter mode) migrated to `layout.panel !== null` + `setPanelFocused`.
- Glass strip mouse routing (full-mode-style content-relative click mapping) — see finding below, values corrected.

## Files changed

- `/Users/jarred/Code/personal/jmux/src/input-router.ts` — the adapter itself.
- `/Users/jarred/Code/personal/jmux/src/main.ts` — `setDiffFocus`, `relayout`, and the `InputRouter` construction site.
- `/Users/jarred/Code/personal/jmux/src/__tests__/input-router.test.ts` — full migration to `FrameLayout` fixtures (`baseLayout`, `diffPanelLayout` helpers built via the real `computeFrameLayout`, not hand-rolled spans) plus the new regression test.

## How each existing test construction was migrated

All constructions were of the shape `new InputRouter({ sidebarCols: N, ... }, true)` optionally followed by `setMainCols(M)` / `setDiffPanel(cols, focused)`. Migration pattern:

- **`sidebarCols: N` + `true` (no diff panel, no exact-width assertions)** → `new InputRouter({ ...same opts minus sidebarCols }, baseLayout(N))`. `baseLayout` builds a real 120-col-wide, diff-off `FrameLayout` via `computeFrameLayout` so `main`/`toolbarRows`/etc. are internally consistent. Covers: Ctrl-Shift arrow detection, passthrough, modal mode, link click (the `setMainCols(60)` calls were simply dropped — `getLinkAt`/link-click gating reads raw `gridX`/`gridY`, unaffected by `mainCols`, and every other assertion in that block only needs "not sidebar, translates to something non-empty," both satisfied by `baseLayout`'s generous width).
- **`setDiffPanel(cols, focused)` with keyboard-only assertions** → `baseLayout(sidebarWidth, "split", cols)` as the initial layout, plus an explicit `router.setPanelFocused(focused)` call mirroring the original boolean (kept explicit even when `false`, for parity with the original code's explicitness).
- **The two tests asserting an exact translated SGR string** (`mouse click in diff panel region forwards translated SGR`, `divider click toggles focus`) → a new `diffPanelLayout(sidebarWidth, mainCols, panelCols)` helper that solves for the `termCols` that makes `computeFrameLayout` produce the exact requested `main.w`/`panel.w` (mirroring what `setMainCols(20)` + `setDiffPanel(10, ...)` used to pin directly). The click coordinates in both tests are now derived from the resulting `layout.divider`/`layout.panel.x`/`layout.toolbarRows` fields rather than hand-computed literals, so they can't silently drift from the fixture.
- **No `setDiffPanel` call at all** (e.g. "Shift+Right forwards to tmux when no diff panel", the two prefix+d Command-Center tests) → plain `baseLayout(sidebarWidth)` (diff off, `layout.panel === null`), matching the old "diffPanelCols stays 0" state.
- **Glass tests (`sidebarCols: 26`, no diff panel)** → `baseLayout(26)`.

**None of the above changed test meaning** except the two "glass strip mouse routing" tests — see the finding below, which explains why those numeric expectations legitimately changed and why that's a fix, not a regression.

## Self-review findings

1. **All five geometry fields are gone.** `sidebarVisible`, `diffPanelCols`, `mainCols`, `toolbarRows` (the private fields) and the constructor's `sidebarCols` option are all deleted; `grep -rn "setSidebarVisible|setMainCols|setDiffPanel(|setToolbarRows|sidebarCols"` across `src/` returns only two doc-comment mentions (one explaining what `setLayout` replaces, one in a test comment explaining the historical formula) — no live code references remain.
2. **No stray `+1`/`-1` outside the single grid-space conversion.** Confirmed by re-reading the whole rewritten mouse block: every offset is `gridX - layout.<span>.x` or a direct span/`toolbarRows` comparison; `translateMouse` calls pass `layout.main.x` / `layout.panel.x` unmodified.
3. **The `setMainCols(0)` full-mode hack is deleted**, along with its explanatory comment in `relayout()`'s docstring, and replaced by the single `inputRouter.setLayout(layout)` call.
4. **The regression test genuinely fails without the fix** — confirmed above (RED section) both at the type level and at runtime, for the stated reason (no `sidebarCols`, no `setLayout`), not a typo.
5. **A second, related bug surfaced and was fixed as a byproduct of the mandated single-conversion rule.** The old formulas for `mainCol` (toolbar click/hover) and glass `cx` were `mouse.x - sidebarCols - 1`. Once fully converted through `gridX = mouse.x - 1`, the mathematically equivalent, *and only internally consistent*, form is `gridX - layout.main.x` — one less than the old value at every point. I verified against two independent ground-truth call sites rather than just trusting the arithmetic:
   - `renderer.ts`'s `compositeGrids` places toolbar/tab text at absolute column `borderCol + 1 + startCol` (i.e. `main.x + startCol`), so a click at absolute `gridX` must map to `startCol = gridX - main.x` to hit the same range the renderer drew — the old formula was off by exactly one column here.
   - `glass/view.ts`'s `focusAt(x, y)` matches against tile rects that are 0-indexed with no left padding (`x >= rect.x`), confirming glass content column 0 is the true first column, not column 1.
   Net effect: toolbar clicks/hover and glass-tile clicks were silently off by one column before this task (not the sidebarWidth-staleness bug this task targets, but the same class of defect — hit-testing arithmetic that didn't match rendering). I updated the two "glass strip mouse routing" test assertions (`tabClicks` from `[3]`→`[2]`, `tileClicks` from `[[3,3]]`→`[[2,3]]`) to the corrected values and documented the reasoning inline in the test file. I did not adjust the assertions to preserve old (buggy) numbers.

## Concerns

- **The finding above is the one place I made a judgment call rather than following the brief to the letter.** The brief's "Rewrite map" explicitly specifies the corrected formula for the *toolbar* hit only (`gridX - layout.main.x`) and says nothing about the glass block's `cx`. Since both use the exact same historical `mouse.x - sidebarCols - 1` shape and the same `gridX - layout.main.x` correction falls out of applying decision #4 ("no scattered +1/-1... binding requirement") uniformly across the whole mouse block, I applied it to glass as well rather than leaving an inconsistent, still-buggy formula sitting next to the now-correct toolbar one. I'm confident in the fix (verified against `renderer.ts` and `glass/view.ts` as noted above) but flagging it explicitly since it's a behavior change the brief didn't spell out verbatim for that specific call site, and no existing test previously caught it.
- Everything else — sidebar/toolbar/divider/panel hit-testing, translateMouse offsets, the full-mode panel-routing fix, and all setter removals — matches the brief's rewrite map and decisions exactly, with no other behavior changes identified.

## Fix: missing routing coverage

A reviewer confirmed the implementation (including the full-mode off-by-one correction) but flagged that two of the behaviors it depends on shipped untested, plus a stale comment:

1. **Full-mode panel routing was untested.** `"full"` only appeared in `baseLayout`'s type signature — no test ever constructed a `"full"` layout. This is the case the `setMainCols(0)` deletion in `main.ts` rests on: in full mode `layout.panel.x === layout.main.x` and `layout.divider === null`, so a content-area click must route to the panel via the single `gridX >= layout.panel.x` test, not fall through to main. Added two tests under `describe("diff panel routing")`:
   - `"full mode: content-area click routes to panel, not main, translated by panel.x"` — asserts `layout.divider` is `null`, `layout.panel!.x === layout.main.x`, and a content click reaches `onDiffPanelData` (translated by `layout.panel.x`/`layout.toolbarRows`) while `onPtyData` sees nothing.
   - `"full mode: no divider exists, so no column is ever classified as a divider drag"` — pre-focuses the panel (via `setPanelFocused(true)`) so the unrelated "click acquires focus" branch can't confound the assertion, then clicks at the column that would have been the divider in a comparably-sized split layout and confirms `onDiffPanelFocusToggle` is never called while the click still reaches `onDiffPanelData` as ordinary content.

2. **The corrected toolbar formula (`gridX - layout.main.x`) had no test.** The only existing toolbar test (`:213`) was the negative case (`onToolbarClick` not called while the palette is open) — there was no positive assertion of the column value at all, and no `onHover` test anywhere in the file. My prior report's line "Toolbar-click routing under a plain layout" (`task-3-report.md:63`) was therefore false; corrected in place above. Added a new `describe("toolbar column routing")` block with three tests against `baseLayout(24)`:
   - `onToolbarClick` receives `gridX - layout.main.x` for an ordinary click in the toolbar row.
   - `onHover` reports the same `{ area: "toolbar", col }` for a motion event in the toolbar row (collected into an array rather than a nullable `let`, to sidestep a TypeScript closure-narrowing quirk described below).
   - a click at `gridX === layout.main.x` yields column `0` — the boundary the old `mouse.x - sidebarCols - 1` formula got wrong.

3. **Stale comment in `main.ts`.** `zoomDiffPanel()`'s comment said "relayout() alone only re-applies whatever diffPanelFocused already was" — no longer true, since `relayout()` only calls `inputRouter.setLayout(layout)` (pure geometry) and never touches focus at all; focus is set exclusively via `setDiffFocus` → `inputRouter.setPanelFocused`. Rewrote the comment to state that directly.

### Two issues found while writing the tests (neither is a routing-logic bug; both were test-construction mistakes on my part, fixed without touching `input-router.ts`)

- The first attempt at the "no divider" test asserted `focusToggled === false` unconditionally, but a content click in the panel also acquires keyboard focus (`!this.diffPanelFocused` branch, unrelated to the divider) — so it failed on first run with `focusToggled === true`. Fixed by pre-focusing the panel before the click, isolating the divider-only assertion. This was diagnosed as a test-design gap (conflating "acquire focus" with "divider toggle"), not a defect in `input-router.ts`; no implementation or test-relaxation was needed beyond that isolation.
- The `onHover` test initially used `let hovered: Target = null` reassigned inside the `onHover` callback, then asserted via `expect(hovered).toEqual(...)` — this fails `bun run typecheck` because TypeScript's control-flow analysis narrows `hovered`'s type to the literal `null` at the read site (the reassignment lives inside a nested closure, which isn't part of the outer function's linear CFA graph for narrowing purposes), producing `TS2769: No overload matches this call`. Fixed by collecting into an array (`hovers: Array<Target> = []`, `.push(target)`) and asserting `toEqual([{ ... }])` — the pattern already used elsewhere in this file for the same reason (`tabClicks`, `tileClicks`, `deltas`, `sent`).

### Commands run and results

```
$ bun test src/__tests__/input-router.test.ts
 79 pass
 0 fail
 118 expect() calls
Ran 79 tests across 1 file.
```

```
$ bun test
 1310 pass
 0 fail
 2605 expect() calls
Ran 1310 tests across 104 files.
```
(One line of expected stderr noise from an unrelated test's negative-case fixture: `jmux: invalid panelView "bad" — issues+reviewing is not a valid combination`.)

```
$ bun run typecheck
$ tsc --noEmit
(clean, no output)
```

## Commit

`test(input-router): cover full-mode and toolbar column routing` — see git log for the SHA.
