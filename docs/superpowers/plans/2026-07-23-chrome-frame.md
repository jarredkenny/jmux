# Chrome Frame Implementation Plan (visible chrome, part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn on the visible frame from the chrome visual-language spec — joined frame rules, the heavy accent tab underline, a persistent footer, and the corrected toolbar glyphs — on top of the completed geometry/draw/band seams.

**Architecture:** Extends the existing `src/frame-layout.ts` with three chrome rows (a rule under the toolbar, a rule above a footer, and the footer) plus a degradation ladder, rather than the superseded `src/layout.ts` from the earlier draft. Adds `src/chrome-tokens.ts` as the single home for chrome colours, spacing, and frame glyphs. The renderer composites the rules and the tab underline; a new `src/footer.ts` owns the footer model. `InputRouter` classifies the new inert rows. Colours route through one accent that means focus and nothing else.

**Tech Stack:** Bun 1.3.8+, TypeScript strict, `bun:test`, no bundler.

## Global Constraints

- Target **Bun, not Node**. Pure logic modules; no new deps.
- **`cellWidth`/`textCols` in `cell-grid.ts` stay the single width table.** No new width clones.
- **The continuation-cell rule lives only in `writeCell`** — no surface hand-writes `{ char: "", width: 0 }`. Paint through `writeStyledLine`/`drawBox`.
- **Spans are 0-indexed grid columns; the mouse coordinate is 1-indexed and converted once** in `InputRouter`.
- **One accent, `#F0883E` (`ACCENT_BASE`), means focus and nothing else.** Green = agent running / affirmative; yellow = attention; red = failure; blue = links. `complete` and `activity` are neutral.
- The accent routes through the existing `accentFor()` so it darkens on light terminal backgrounds; neutral text through `neutralFg()`.
- Pure `bun:test` unit tests over logic modules; **no test spawns tmux** (the one pre-existing `snapshot/integration-tmux.test.ts` exception is untouched).
- `bun run typecheck` clean; `any` unacceptable.
- `git add` only the files a task changed, by exact filename. Never `git add -A`; never add anything under `.superpowers/`.
- Never sign off as Claude in git.

**The current `FrameLayout` (from the seams work) that this plan extends:**
```ts
export type Span = { x: number; w: number };
export interface FrameLayout {
  termCols: number; termRows: number;
  sidebar: Span | null; borderCol: number | null;
  toolbarRows: number; ptyRows: number;
  mode: "single" | "split" | "full";
  main: Span; divider: number | null; panel: Span | null;
}
export const SIDEBAR_MIN_TERM_COLS = 80;
```
`FrameLayoutInput` currently has `{ termCols, termRows, sidebarWidth, borderWidth, toolbarRows, diffState, requestedPanelCols }`. `computeFrameLayout` currently sets `ptyRows = termRows - toolbarRows`.

---

### Task 1: Chrome rows and the degradation ladder in `frame-layout.ts`

**Files:**
- Modify: `src/frame-layout.ts`
- Test: `src/__tests__/frame-layout.test.ts` (extend)

**Interfaces:**
- Consumes: the existing module.
- Produces: two new `FrameLayoutInput` fields `frameRulesEnabled: boolean` and `footerEnabled: boolean`; new `FrameLayout` fields `topRuleRow: number | null`, `contentTop: number`, `contentRows: number`, `footerRuleRow: number | null`, `footerRow: number | null`, and a `chrome: { toolbar: boolean; topRule: boolean; footerRule: boolean; footer: boolean }` object. `ptyRows` becomes `=== contentRows`. Tasks 4–7 consume these.

- [ ] **Step 1: Write failing tests** extending `src/__tests__/frame-layout.test.ts`. Add a `describe("chrome rows")`:

```ts
import { computeFrameLayout, type FrameLayoutInput } from "../frame-layout";

const chromeInput = (over: Partial<FrameLayoutInput> = {}): FrameLayoutInput => ({
  termCols: 200, termRows: 50, sidebarWidth: 26, borderWidth: 1,
  toolbarRows: 1, diffState: "off", requestedPanelCols: 0,
  frameRulesEnabled: true, footerEnabled: true, ...over,
});

describe("chrome rows", () => {
  test("with both flags false, geometry is byte-identical to pre-chrome", () => {
    const g = computeFrameLayout(chromeInput({ frameRulesEnabled: false, footerEnabled: false }));
    expect(g.toolbarRows).toBe(1);
    expect(g.topRuleRow).toBeNull();
    expect(g.contentTop).toBe(1);
    expect(g.contentRows).toBe(49);
    expect(g.ptyRows).toBe(49);
    expect(g.footerRuleRow).toBeNull();
    expect(g.footerRow).toBeNull();
  });

  test("full chrome reserves four rows", () => {
    const g = computeFrameLayout(chromeInput({ termRows: 50 }));
    expect(g.toolbarRows).toBe(1);
    expect(g.topRuleRow).toBe(1);
    expect(g.contentTop).toBe(2);
    expect(g.contentRows).toBe(46);
    expect(g.ptyRows).toBe(46);
    expect(g.footerRuleRow).toBe(48);
    expect(g.footerRow).toBe(49);
  });

  test("two-row toolbar pushes content to row 3", () => {
    const g = computeFrameLayout(chromeInput({ toolbarRows: 2 }));
    expect(g.topRuleRow).toBe(2);
    expect(g.contentTop).toBe(3);
    expect(g.contentRows).toBe(45);
  });

  test("degradation ladder", () => {
    const at = (termRows: number) => {
      const g = computeFrameLayout(chromeInput({ termRows }));
      return { toolbar: g.chrome.toolbar, topRule: g.chrome.topRule, footerRule: g.chrome.footerRule, footer: g.chrome.footer };
    };
    expect(at(24)).toEqual({ toolbar: true, topRule: true, footerRule: true, footer: true });
    expect(at(11)).toEqual({ toolbar: true, topRule: true, footerRule: false, footer: true });
    expect(at(9)).toEqual({ toolbar: true, topRule: true, footerRule: false, footer: false });
    expect(at(7)).toEqual({ toolbar: true, topRule: false, footerRule: false, footer: false });
    expect(at(5)).toEqual({ toolbar: false, topRule: false, footerRule: false, footer: false });
  });

  test("contentRows never below 1, and row bands are contiguous and cover termRows", () => {
    for (const termRows of [5, 6, 8, 10, 12, 24]) {
      for (const toolbarRows of [1, 2]) {
        const g = computeFrameLayout(chromeInput({ termRows, toolbarRows }));
        expect(g.contentRows).toBeGreaterThanOrEqual(1);
        const rows: number[] = [];
        for (let r = 0; r < g.toolbarRows; r++) rows.push(r);
        if (g.topRuleRow !== null) rows.push(g.topRuleRow);
        for (let r = 0; r < g.contentRows; r++) rows.push(g.contentTop + r);
        if (g.footerRuleRow !== null) rows.push(g.footerRuleRow);
        if (g.footerRow !== null) rows.push(g.footerRow);
        const sorted = [...rows].sort((a, b) => a - b);
        expect(new Set(rows).size).toBe(rows.length);
        expect(sorted[0]).toBe(0);
        expect(sorted[sorted.length - 1]).toBe(termRows - 1);
        for (let i = 1; i < sorted.length; i++) expect(sorted[i]).toBe(sorted[i - 1] + 1);
      }
    }
  });
});
```

Also: every existing test that builds a `FrameLayoutInput` literal now needs `frameRulesEnabled` and `footerEnabled`. The faithful migration is `frameRulesEnabled: false, footerEnabled: false` (they assert pre-chrome geometry). Add both fields to each existing fixture with those values so the existing assertions still hold.

- [ ] **Step 2: Run to verify failure** — `bun test src/__tests__/frame-layout.test.ts`. Expected: the new tests fail (fields undefined) and existing tests fail to typecheck until fixtures gain the two fields.

- [ ] **Step 3: Implement.** Add the two input fields. Add a `resolveChrome(input)` returning the `chrome` object using this ladder (only engages when a flag is on; both off ⇒ toolbar only, matching today at every height):

```ts
function resolveChrome(input: FrameLayoutInput) {
  const NONE = { toolbar: false, topRule: false, footerRule: false, footer: false };
  if (input.toolbarRows === 0) return NONE;
  const rules = input.frameRulesEnabled, footer = input.footerEnabled;
  if (!rules && !footer) return { toolbar: true, topRule: false, footerRule: false, footer: false };
  const r = input.termRows;
  if (r < 6) return NONE;
  if (r < 8) return { toolbar: true, topRule: false, footerRule: false, footer: false };
  if (r < 10) return { toolbar: true, topRule: rules, footerRule: false, footer: false };
  if (r < 12) return { toolbar: true, topRule: rules, footerRule: false, footer };
  return { toolbar: true, topRule: rules, footerRule: rules && footer, footer };
}
```

Compute rows top-down: `toolbarRows` stays as given when `chrome.toolbar`, else 0; `topRuleRow = chrome.topRule ? toolbarRows : null`; `contentTop = toolbarRows + (topRule?1:0)`; `footerRow = chrome.footer ? termRows-1 : null`; `footerRuleRow = chrome.footerRule ? termRows-2 : null`; `contentRows = max(1, termRows - contentTop - (footer?1:0) - (footerRule?1:0))`; `ptyRows = contentRows`. Leave column math untouched.

- [ ] **Step 4: Run tests** — `bun test src/__tests__/frame-layout.test.ts` → pass.
- [ ] **Step 5: Wire production to pass `false`/`false` for now.** In `main.ts`'s `refreshGeometry()` (the `computeFrameLayout` call — there are two, the probe and the real one), add `frameRulesEnabled: false, footerEnabled: false` to both input objects. This keeps behaviour identical; Tasks 5–7 flip them. Run full `bun test` + `bun run typecheck` → clean.
- [ ] **Step 6: Commit.**

```bash
git add src/frame-layout.ts src/__tests__/frame-layout.test.ts src/main.ts
git commit -m "feat(frame-layout): add chrome rows and the degradation ladder

Extends FrameLayout with topRule/footer/footerRule rows, contentTop,
contentRows, and a chrome resolution that degrades on short terminals.
ptyRows is now contentRows. Production passes both flags false, so this
is a no-op until the rendering tasks turn them on."
```

---

### Task 2: `src/chrome-tokens.ts` — colours, spacing, frame glyphs

**Files:**
- Create: `src/chrome-tokens.ts`
- Test: `src/__tests__/chrome-tokens.test.ts`

**Interfaces:**
- Consumes: `theme.ts` (`accentFor`, `neutralFg`, `theme`, `mix`, `unpack`, `pack`), `cell-grid.ts` (`CellAttrs`), `types.ts` (`ColorMode`).
- Produces: `ACCENT_BASE = 0xF0883E`; a `tokens` object of `CellAttrs` (`accent`, `accentMuted`, `textPrimary`, `textSecondary`, `textTertiary`, `ruleFrame`, `ruleHairline`, `affirmative`, `attention`, `failure`, `link`, `modePlan`); `space` (`{ inset:1, modalInset:2, glyphGutter:1, groupGutter:2, blockGap:1, measure:64 }`); `frame` (`{ ruleLight:"─", ruleHeavy:"━", crossDown:"┼", crossUp:"┴", divider:"│" }`); and `rebuildChromeTokens()`. Every later task's colours come from here.

- [ ] **Step 1: Write failing tests.**

```ts
import { describe, test, expect } from "bun:test";
import { tokens, rebuildChromeTokens, ACCENT_BASE, space, frame } from "../chrome-tokens";
import { setTheme, deriveTheme, DEFAULT_THEME } from "../theme";
import { ColorMode } from "../types";

describe("chrome tokens", () => {
  test("accent is the spec accent on a dark theme", () => {
    setTheme({ ...DEFAULT_THEME });
    rebuildChromeTokens();
    expect(tokens.accent.fg).toBe(ACCENT_BASE);
    expect(tokens.accent.fgMode).toBe(ColorMode.RGB);
  });
  test("accent darkens on a light background", () => {
    setTheme(deriveTheme({ r: 251, g: 251, b: 249 }));
    rebuildChromeTokens();
    expect(tokens.accent.fg).not.toBe(ACCENT_BASE);           // accentFor darkened it
    setTheme({ ...DEFAULT_THEME }); rebuildChromeTokens();
  });
  test("rebuild preserves object identity for live re-theming", () => {
    const ref = tokens.accent;
    rebuildChromeTokens();
    expect(tokens.accent).toBe(ref);
  });
  test("spacing scale and frame glyphs are the spec values", () => {
    expect(space).toEqual({ inset:1, modalInset:2, glyphGutter:1, groupGutter:2, blockGap:1, measure:64 });
    expect(frame.ruleHeavy).toBe("━");
    expect(frame.crossDown).toBe("┼");
    expect(frame.crossUp).toBe("┴");
  });
});
```

- [ ] **Step 2: Run to verify failure** — module missing.
- [ ] **Step 3: Implement.** `tokens` objects are mutated in place by `rebuildChromeTokens()` (identity preserved, matching the `modal.ts`/`sidebar.ts` re-theming pattern). `accent` = `{ fg: accentFor(ACCENT_BASE), fgMode: RGB }`. `accentMuted` = `{ fg: pack(mix(unpack(theme.surface)…)) }` — use `mix(termBg, anchor, 0.55)` where the anchor is white on dark / black on light, mirroring `deriveTheme`'s pane tones; on `DEFAULT_THEME` derive from `theme.surface`. `textPrimary`/`textSecondary` via `neutralFg(7)`/`neutralFg(8)`; `textTertiary` = `{ ...neutralFg(8), dim: true }`. `ruleFrame` = `textTertiary` tone; `ruleHairline` = same but may be dimmer. `affirmative`/`attention`/`failure` = palette 2/3/1. `link` = `{ fg: accentFor(0x58A6FF)… }`. `modePlan` = palette 6. Call `rebuildChromeTokens()` at module load.
- [ ] **Step 4: Run tests** → pass. `bun run typecheck` → clean.
- [ ] **Step 5: Commit.**

```bash
git add src/chrome-tokens.ts src/__tests__/chrome-tokens.test.ts
git commit -m "feat(chrome-tokens): single home for chrome colour, spacing, frame glyphs

One accent (#F0883E) meaning focus; a neutral text ramp; semantic
affirmative/attention/failure/link; the spacing scale and frame glyphs.
Rebuilt in place on OSC 11 detection so live re-theming keeps identity.
No consumers yet."
```

---

### Task 3: `neutral` state colour in `state-colors.ts`

**Files:**
- Modify: `src/state-colors.ts`, `src/config.ts`
- Test: `src/__tests__/state-colors.test.ts` (extend)

**Interfaces:**
- Consumes: existing module.
- Produces: `StateColor = { kind: "palette"; index: number } | { kind: "neutral" }`; `resolveStateColors(cfg?): Record<AgentState, StateColor>`; the configurable-name list gains `"neutral"` **without** disturbing the 16-entry ANSI→palette mapping (the ANSI list is `reduce`d positionally into indices — a 17th entry would become palette 16). `DEFAULT_STATE_COLORS.complete` becomes `"neutral"`. Consumers migrate in Tasks 4/5 of plan 3; this task only changes the resolver and default.

- [ ] **Step 1: Write failing tests** — `resolveStateColors()` with no config returns `{ kind: "neutral" }` for `complete` and `{ kind: "palette", index: 2/3 }` for running/waiting; an explicit `complete: "blue"` still resolves to `{ kind: "palette", index: 4 }`; `"neutral"` is an accepted config value; `"neutral"` never resolves to palette index 16.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Keep `STATE_COLOR_NAMES` (the 16 ANSI names) exactly as the positional palette source. Add a separate `STATE_COLOR_CHOICES = [...STATE_COLOR_NAMES, "neutral"]` for the picker. Change `resolveStateColors`'s return type to `Record<AgentState, StateColor>` and its body to emit `{ kind: "neutral" }` for the neutral name and `{ kind: "palette", index }` otherwise. Change `DEFAULT_STATE_COLORS.complete` to `"neutral"`. Update `config.ts`'s `StateColorConfig` validation to accept `"neutral"`.
- [ ] **Step 4:** Existing callers of `resolveStateColors` (sidebar, glass) will not typecheck against the new union. **This task is allowed to break their call sites' types** only if it also adapts them minimally to compile — but per the seam discipline, prefer: add a temporary `stateColorToPalette(c: StateColor): number` helper returning `c.kind === "neutral" ? 8 : c.index` (palette 8 = the neutral grey the current `complete` dim already approximates), and route existing callers through it so behaviour is unchanged and the tree stays green. Plan 3 replaces that helper with the real `stateAttrs`. Note the temporary helper in the report.
- [ ] **Step 5:** Full `bun test` + `bun run typecheck` → clean. The sidebar's `complete` indicator will now render palette-8 grey instead of blue dim — that is an authorised change from the spec (`complete` → neutral). Any sidebar test asserting blue `complete` is updated to the neutral tone.
- [ ] **Step 6: Commit.**

```bash
git add src/state-colors.ts src/config.ts src/__tests__/state-colors.test.ts src/sidebar.ts src/glass/view.ts
git commit -m "feat(state-colors): neutral state colour; complete defaults to neutral

resolveStateColors returns a StateColor union so complete can be neutral
rather than a palette index. The 16-entry ANSI list is untouched; neutral
is a separate picker choice. complete's default moves from blue to neutral
per the spec — a finished agent recedes. Callers route through a temporary
stateColorToPalette until plan 3's stateAttrs lands."
```

---

### Task 4: `InputRouter` classifies the chrome rows

**Files:**
- Modify: `src/input-router.ts`
- Test: `src/__tests__/input-router.test.ts` (extend)

**Interfaces:**
- Consumes: the extended `FrameLayout` (Task 1).
- Produces: `InputRouter.classifyRow(y1)` returns `"toolbar" | "rule" | "content" | "footer"`; rule rows are inert (no toolbar action, nothing forwarded); footer rows dispatch to a new `onFooterClick?(col: number)` option; content translation uses `layout.contentTop` rather than `layout.toolbarRows`.

- [ ] **Step 1: Write failing tests** using `computeFrameLayout` fixtures with `frameRulesEnabled: true, footerEnabled: true`: the frame-rule row classifies `"rule"` and is inert (no `onToolbarClick`, nothing to `onPtyData`); the footer row classifies `"footer"` and calls `onFooterClick` with `gridX`; a content click forwards translated by `contentTop` (which is now 2, not 1). Assert the exact forwarded SGR `y`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `classifyRow` reads `layout.topRuleRow`/`footerRuleRow` (→ `"rule"`), `footerRow` (→ `"footer"`), `toolbarRows` (→ `"toolbar"`), else `"content"`. Swallow `"rule"` early. Route `"footer"` clicks to `onFooterClick`. Replace the content y-offset (currently `contentTop()` returning `toolbarRows`) so it reads `layout.contentTop`. Add `onFooterClick?: (col: number) => void` to `InputRouterOptions`.
- [ ] **Step 4:** `bun test src/__tests__/input-router.test.ts` → pass. Existing tests that build layouts with the flags off still see `contentTop === toolbarRows`, so they are unaffected. Full `bun test` + typecheck → clean.
- [ ] **Step 5: Commit.**

```bash
git add src/input-router.ts src/__tests__/input-router.test.ts
git commit -m "feat(input-router): classify and route the chrome rows

The frame rules are inert (swallowed, never forwarded); footer clicks
dispatch to onFooterClick; content translation reads layout.contentTop so
inserting a rule row between the toolbar and content cannot displace a
forwarded mouse event. No visible change until the rows are turned on."
```

---

### Task 5: Frame rules, junctions, tab underline, neutral divider

**Files:**
- Modify: `src/renderer.ts`, `src/main.ts`
- Test: `src/__tests__/renderer.test.ts` (extend)

**Interfaces:**
- Consumes: `FrameLayout` (Task 1), `chrome-tokens` (Task 2).
- Produces: `compositeGrids` paints the top rule at `layout.topRuleRow` and footer rule at `layout.footerRuleRow`, with `┼` at the sidebar divider on the top rule and `┴` on the footer rule; the tab-range segment of the top rule is the underline. The split divider stops encoding focus. **This task turns `frameRulesEnabled: true` in production — first visible change.**

- [ ] **Step 1: Write failing tests.** Build a `FrameLayout` with rules on. Assert: the top-rule row is `─` (`ruleFrame`) across its width except `┼` at `dividerCol`; the footer-rule row has `┴` at `dividerCol`; the cells under the active tab's range are `━` (`frame.ruleHeavy`) in `accent`; an inactive tab's range is `─`; a hovered inactive tab is `─` in `accentMuted`; a bell tab is `─` in `attention` and **not** heavy; with a docked panel, only the focused region's active tab is `accent` (the other is `accentMuted`); the split divider column is `ruleFrame` regardless of `diffPanel.focused`. Assert glyph and colour independently.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** In `compositeGrids`, after the toolbar row, paint the rule rows using `writeCell`/`writeStyledLine` with `frame.ruleLight`, overwriting `dividerCol` and `panelDividerCol` with `crossDown`/`crossUp`. For the underline, consume the `layoutToolbar` placement (from the band-layout seam) to get each tab's `startCol`/`width`, and for each, write `ruleHeavy` accent / `ruleLight` per the table in the spec. Remove the focus-colour branch on the split divider (`renderer.ts` ~380) — it becomes plain `ruleFrame`. In `main.ts` `refreshGeometry()`, set `frameRulesEnabled: true` in both `computeFrameLayout` inputs.
- [ ] **Step 4:** `bun test` + typecheck → clean. Any existing renderer test asserting the old blue split divider is updated to `ruleFrame`.
- [ ] **Step 5: Interactive check.** Drive an isolated `--demo` jmux under its own tmux socket (as prior tasks did) and confirm: the header rule runs full width and joins the divider with `┼`; the active tab has a heavy accent underline; hovering an inactive tab lifts it; a docked diff panel shows only the focused side's underline in accent; nothing overlaps the tmux content. If you cannot drive it, say so.
- [ ] **Step 6: Commit.**

```bash
git add src/renderer.ts src/main.ts src/__tests__/renderer.test.ts
git commit -m "feat(renderer): joined frame rules and the accent tab underline

One rule runs full width and crosses the sidebar/panel dividers with the
right junction glyphs. The rule segment under the active tab is heavy and
accent — the separator becomes the focus indicator, and with a docked
panel only the focused region's underline is accent, which gives the panel
a focus cue it lacked. The split divider stops encoding focus (blue is now
links only)."
```

---

### Task 6: The footer

**Files:**
- Create: `src/footer.ts`
- Modify: `src/renderer.ts`, `src/main.ts`, `src/sidebar.ts`
- Test: `src/__tests__/footer.test.ts`

**Interfaces:**
- Consumes: `chrome-tokens`, `cell-grid` primitives, `FrameLayout`.
- Produces: `FooterSegment`, `FooterModel`, `buildFooter(state)`, `layoutFooter(model, cols)` returning `{ cells, ranges }`; the renderer paints the footer row; `main.ts` supplies footer state and wires `onFooterClick`; the sidebar's version row is removed (it moves to the footer). **Turns `footerEnabled: true` — second visible change.**

- [ ] **Step 1: Write failing tests** for `layoutFooter`: left keybind segments (`↵ open · ^a p palette · ? keys`) render key in `accentMuted`, label in `textSecondary`, `·` in `ruleHairline`; the right side (snapshot chip + version, or update-available text) is laid out first and never truncates; left segments drop whole, lowest-priority first, until they fit; at 80 cols ≥2 left segments survive; `layoutFooter` returns a click range for the version segment carrying a `"changelog"` action.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `footer.ts`** as a pure model + layout (mirroring `band-layout`/`packChips` discipline — no rendering, returns styled cells + ranges). Right side: snapshot chip (moved out of the toolbar) + version segment with `onClick: "changelog"`, rendering update-available text when present. Truncation: right first (never truncated), then drop left segments whole by ascending priority.
- [ ] **Step 4:** Renderer paints the footer row from `layoutFooter`. `main.ts` builds footer state, passes it in, and wires `onFooterClick` to dispatch the version range's `"changelog"` action to the existing `showVersionInfo()`; set `footerEnabled: true` in `refreshGeometry`. Remove the version/update-available rendering from `sidebar.ts` (`footerRows()` → 0) and its scroll-indicator dependence on it; the sidebar viewport shrinks by the footer via the geometry it is already handed.
- [ ] **Step 5:** `bun test` + typecheck → clean. Sidebar tests asserting the version row are updated.
- [ ] **Step 6: Interactive check** — footer renders full width, keybinds left, snapshot + version right; clicking the version opens the changelog; the sidebar no longer shows the version. Report if undriveable.
- [ ] **Step 7: Commit.**

```bash
git add src/footer.ts src/renderer.ts src/main.ts src/sidebar.ts src/__tests__/footer.test.ts
git commit -m "feat(footer): persistent footer with keybinds and ambient status

A typed footer model: keybinds left in the shared dialect, snapshot chip
and version right. The version keeps its changelog click; the update
notice survives the move off the sidebar. Right side never truncates;
left segments drop whole by priority. Reclaims the sidebar's version row."
```

---

### Task 7: Toolbar glyphs, separator, chip relocation

**Files:**
- Modify: `src/main.ts` (`makeToolbar`), `src/renderer.ts` (tab separator, snapshot chip removal)
- Test: `src/__tests__/renderer.test.ts` (extend)

**Interfaces:**
- Consumes: existing toolbar.
- Produces: corrected button glyphs; single-space glyph gutter; two-space tab separator; the snapshot status chip removed from the toolbar (it now lives in the footer).

- [ ] **Step 1: Write failing tests** — `makeToolbar()` buttons are `◧ + ◫ ▤ λ ⚙` in order; the toolbar no longer emits a status chip (`getToolbarStatusChipRange` returns null / chip absent); tab ranges reflect a two-space separator, not `" │ "`. Keep `λ` and plain `⚙` (no VS15 — `cellWidth` has no variation-selector handling).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** In `makeToolbar`: `panel ◧`, `new-window +`, `split-v ◫`, `split-h ▤`, `claude λ` (accent fg), `settings ⚙`; drop the `statusChip` from `ToolbarConfig` (or set it null) since the footer owns it. In `renderer.ts`, change the tab separator from `" │ "` (3 cols) to two spaces (`space.groupGutter`), and the inter-button gutter to one space. Remove the status-chip paint path.
- [ ] **Step 4:** `bun test` + typecheck → clean. Tab-range and click tests updated for the new separator width; band-layout `sepWidth` for tabs becomes 2.
- [ ] **Step 5: Interactive check** — buttons read as one control group with the corrected glyphs; tabs separated by space; no status chip in the toolbar (it is in the footer). Report if undriveable.
- [ ] **Step 6: Commit.**

```bash
git add src/main.ts src/renderer.ts src/__tests__/renderer.test.ts
git commit -m "feat(toolbar): corrected glyphs, tighter cluster, chip to footer

+ replaces the fullwidth ＋; ◫/▤ replace the pause/eject glyphs that meant
split-v/split-h; ◧ replaces the gem. One-space button gutter reads as one
group; the tab separator drops to two spaces now the underline delimits
tabs. The snapshot chip moves to the footer, freeing the toolbar's third
zone."
```

---

## Verification

- [ ] `bun test` — full suite green.
- [ ] `bun run typecheck` — clean.
- [ ] `bun run docker` — clean-env sanity.
- [ ] Interactive: joined frame, accent underline (active + focused-panel), footer with working version click, corrected glyphs, on both a dark and a light terminal background.

## Follows

Plan 3 (surfaces) migrates the sidebar row plan, modals, settings measure, panel views, and Command Center onto the tokens and the shared dialects, and adds the token lint. This plan is the visible frame; plan 3 is the interior.
