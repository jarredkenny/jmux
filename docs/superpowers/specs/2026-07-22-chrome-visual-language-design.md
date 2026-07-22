# Chrome visual language — UX/UI polish pass

> Revision 2. Revision 1 was reviewed adversarially against the source and
> blocked: it invented an architecture for the Command Center, claimed jmux had
> no panel-focus indicator when it has one, and specified layout changes in prose
> without a canonical geometry. The visual design below is unchanged from the
> version that was approved; the implementation model is new.

## Problem

jmux's chrome has accumulated one styling decision at a time. Each was
reasonable in isolation; together they don't read as one designed surface.
Verified against a live v0.22.0 render and the source:

- **The frame doesn't join.** The sidebar's header rule dead-ends into the
  divider (`──────│`) with no junction glyph, and the main area has no rule at
  all under the toolbar.
- **The active tab is signalled by colour alone** (peach fg + bold,
  `renderer.ts:248`), which disappears on a monochrome terminal and for anyone
  who can't separate orange from grey.
- **Seven hues do thirteen jobs**, with three collisions:
  - Two oranges both mean "active" in the same toolbar row — `#FBD4B8`
    (`renderer.ts:248`, `settings-screen.ts:41`, `panel-view-renderer.ts:260`,
    `info-panel.ts:9`) and `#F0883E` (`main.ts:432`).
  - Green means `running`, *and* `activity` (`sidebar.ts` indicator switch),
    *and* the wordmark, *and* the active sidebar row's name.
  - Blue means `complete`, *and* the panel link accent
    (`panel-view-renderer.ts:262`), *and* the split-divider focus colour
    (`renderer.ts:380`).
- **The sidebar looks ragged.** `itemHeight()` returns a fixed 3 rows for every
  session (`sidebar.ts:356`), but row 3 is empty on sessions with no OTEL data,
  so a bare session renders as name, branch, blank.
- **The settings screen has no measure.** The label is capped at half the
  available width (`settings-screen.ts:238`) and the dot leader fills the rest,
  so the leader grows with the terminal — the layout degrades as the terminal
  gets bigger.
- **There is no global footer.** The sidebar spends its last row on the version
  string instead (`sidebar.ts:722`).
- **Three hint dialects** coexist: `[o] Open`, `Enter to edit · Esc to close`,
  and nothing at all in the command palette.
- **Toolbar glyphs are wrong.** `＋` is fullwidth among 1-cell glyphs; `⏸`
  (pause) means split-vertical; `⏏` (eject) means split-horizontal
  (`main.ts:431-438`).

## Scope

A visual pass over jmux's own chrome: frame, toolbar, sidebar, footer, modals,
settings, panel views, Command Center tiles.

**Behaviour changes are limited to this list, and there are no others:**

- `complete` and `activity` lose colours they shouldn't have had.
- Sessions without agent state stop rendering an empty third row.
- Issue priority in panel views is carried by weight rather than a third orange.
- The settings screen's `(n)` counts are replaced by an `n hidden` marker that
  appears only on collapsed sections.
- The split divider stops changing colour on focus; the tab underline takes over
  that job (see "Panel focus").
- Settings and the Command Center gain the frame and footer rows, so their
  content band shrinks by up to 3 rows.

Explicit non-regressions, each of which revision 1 would have broken:

- The version indicator stays clickable and still opens the changelog.
- The update-available notice survives the move to the global footer.
- No keybinding moves; no command is added or removed.

Out of scope: Command Center tile *layout*, the diff panel's interior (that is
`hunk`'s output), agent-state derivation, and anything changing what data is
collected.

## Layout geometry — `src/layout.ts` (new)

This is the load-bearing part of the change and the reason revision 1 was not
implementable. Adding three chrome rows touches every row calculation in the
program, and PTY height is currently derived by an open-coded
`(process.stdout.rows || 24) - toolbarHeight` in **13 places in `main.ts`**
(383, 386, 1049, 1061, 1094, 1337, 1713, 2026, 2057, 2732, 3542, and the
respawn/zoom paths). Any site missed silently mis-sizes the PTY, and tmux
renders at the wrong height.

One pure function becomes the only place row and column bands are decided:

```ts
export interface LayoutGeometry {
  termCols: number;
  termRows: number;

  /** Clickable toolbar band: rows [0, toolbarRows). 0 when chrome is off. */
  toolbarRows: number;
  /** The frame rule row. Not clickable, not part of the toolbar band. */
  topRuleRow: number | null;

  /** First row of the content band, and its height. */
  contentTop: number;
  contentRows: number;

  footerRuleRow: number | null;
  footerRow: number | null;

  sidebarCols: number;            // 0 when the sidebar is suppressed
  dividerCol: number | null;
  mainStartCol: number;
  mainCols: number;
  panelDividerCol: number | null;
  panelStartCol: number | null;
  panelCols: number;

  /** What the PTY and ScreenBridge are resized to. */
  ptyRows: number;                // invariant: === contentRows
  ptyCols: number;                // invariant: === mainCols
}

export function computeLayoutGeometry(input: {
  termCols: number; termRows: number;
  toolbarEnabled: boolean; windowBranchesEnabled: boolean;
  sidebarCols: number; diffPanel: "off" | "split" | "full";
}): LayoutGeometry;
```

**Every** consumer reads from this: PTY resize, `ScreenBridge.resize`, the diff
PTY and bridge, `Sidebar.resize`, modal placement, cursor placement, mouse
routing, and the renderer's compositor. `ptyRows === contentRows` is asserted by
a test, and a second test asserts no `- toolbarHeight` arithmetic survives in
`main.ts`.

### Degradation on short terminals

Chrome is dropped in this order as `termRows` shrinks, so a tiny terminal always
gets a usable content band rather than zero or negative PTY rows:

| `termRows` | Chrome present |
|---|---|
| ≥ 12 | toolbar, top rule, footer rule, footer |
| 10–11 | toolbar, top rule, footer (no footer rule) |
| 8–9 | toolbar, top rule |
| 6–7 | toolbar only |
| < 6 | none — `contentRows === termRows` |

`contentRows` is clamped to a minimum of 1 in all cases.

### Surface matrix

Every mode names the chrome rows it gets. Revision 1 left this to inference and
two engineers would have disagreed.

| Surface | Toolbar | Top rule | Footer | Content band |
|---|---|---|---|---|
| Normal | yes | yes | yes | sidebar + tmux |
| Diff split / full | yes | yes | yes | sidebar + tmux + panel |
| Settings | yes | yes | yes | settings, centred in main rect |
| Command Center (Glass) | yes | yes | yes | tile grid + optional strip |
| Narrow (no sidebar) | yes | yes | yes | tmux full width |
| Modal open | unchanged | unchanged | unchanged | modal overlays content band only |

Two consequences, both accepted:

- **Settings currently renders with no toolbar** (`main.ts:1275`). It gains the
  full frame. Its own hint line is removed — those hints move to the footer,
  which is the point of having one.
- **Command Center currently uses nearly the whole terminal** (`main.ts:1294`).
  Its tile grid now lives in the content band, so tiles lose up to 3 rows. Its
  mouse mapping must be derived from `contentTop`, not from row 0.

### The no-sidebar path

`renderer.ts:206` currently short-circuits — `if (!sidebar) return main;` —
bypassing toolbar, modal and diff composition entirely, while `main.ts:383`
still subtracts toolbar height. That is a live inconsistency and the new chrome
would inherit it.

The early return is removed. The compositor always runs; the sidebar and its
divider become optional components keyed on `geometry.sidebarCols > 0`. The
existing test at `renderer.test.ts:89` enshrines the early-return behaviour and
is replaced, not extended.

## Input routing — `src/input-router.ts`

`this.toolbarRows` currently carries two different meanings: a hit region
(`mouse.y <= this.toolbarRows`, lines 264 and 347) and the content y-offset
(`mouse.y - 1 - this.toolbarRows`, lines 384 and 391, and
`translateMouse(data, dividerX, this.toolbarRows)` at 399 and 414). Inserting a
non-clickable rule row between the toolbar and the content forces those apart.
Conflating them produces a one-row displacement on every mouse event forwarded
to tmux — the single most likely visible regression in this whole change.

`setToolbarRows(n)` is replaced by `setGeometry(geometry: LayoutGeometry)`, and
each y-coordinate is classified explicitly:

```
row < toolbarRows                     → toolbar    (clickable)
row === topRuleRow                    → rule       (inert; swallow, do not forward)
contentTop ≤ row < contentTop+rows    → content    (translate by contentTop)
row === footerRuleRow                 → rule       (inert)
row === footerRow                     → footer     (clickable — see below)
```

`translateMouse` takes `geometry.contentTop` rather than `toolbarRows`. The
existing diff-panel mouse tests assume a one-row offset
(`input-router.test.ts:299`) and are rewritten against the geometry, not
extended.

## Colour roles

### Single source of truth — `src/chrome-tokens.ts` (new)

Chrome colours are raw literals scattered across seven modules, each with its
own `rebuildXColors()` hook. That duplication is how the three collisions arose,
so the fix is structural. `chrome-tokens.ts` owns every chrome colour, spacing
constant, and frame glyph. Existing `rebuildXColors()` functions stay — their
identity-preserving in-place mutation is load-bearing for live re-theming — but
become thin re-reads of tokens.

```ts
export const ACCENT_BASE = 0xF0883E;

export interface ChromeTokens {
  accent: CellAttrs;          // focus
  accentMuted: CellAttrs;     // mix(termBg, anchor, 0.55) — hover, unfocused active tab
  textPrimary: CellAttrs;
  textSecondary: CellAttrs;
  textTertiary: CellAttrs;
  ruleFrame: CellAttrs;
  ruleHairline: CellAttrs;
  affirmative: CellAttrs;     // green — see the inventory below
  attention: CellAttrs;       // yellow
  failure: CellAttrs;         // red
  link: CellAttrs;            // #58A6FF
  modePlan: CellAttrs;        // cyan
  modeAcceptEdits: CellAttrs; // yellow-family, distinct from attention by weight
}

export const space = {
  inset: 1, modalInset: 2, glyphGutter: 1, groupGutter: 2,
  blockGap: 1, measure: 64,
} as const;

export const frame = {
  ruleLight: "─", ruleHeavy: "━", crossDown: "┼", crossUp: "┴", divider: "│",
} as const;
```

`rebuildChromeTokens()` runs at module load and again on OSC 11 detection.
Accent routes through `accentFor()`; neutrals through `neutralFg()`.

### Semantic inventory

Revision 1 claimed "green means exactly one thing". That was false even after
its own migration — green is also the pipeline-passed glyph
(`sidebar.ts` `PIPELINE_GLYPH_COLORS`) and the focused Glass label chip
(`glass/view.ts:43`). Rather than assert an exclusivity the code doesn't have,
green is defined by what it actually means across every surface:

| Role | Colour | Every surface that uses it |
|---|---|---|
| focus | accent `#F0883E` | active tab underline, selected sidebar rail, panel cursor, settings header, modal prompt, fuzzy-match chars, focused Glass tile border + label |
| affirmative | green | agent `running`, pipeline passed, an enabled setting value |
| attention | yellow | agent `waiting`, bell tab, cache-timer urgency |
| failure | red | `error`, `mcp-down`, pipeline failed |
| receded | textTertiary | agent `complete`, `activity`, unfocused Glass tile border |
| link | `#58A6FF` | panel links only |
| mode | cyan / yellow | plan mode, accept-edits mode |

Retired: `#FBD4B8` (collapses into `#F0883E`), `#E8A0B4` (the Claude button
goes accent), `#FF8C00` (`panel-view-renderer.ts:261` — priority uses weight).

**Match highlighting counts as focus, not as a state** — the fuzzy-match chars
and the modal prompt are the accent because they mark where your attention is,
which is the same role the underline plays.

### Agent-state colours — `src/state-colors.ts`, `src/config.ts`

`complete`'s default becomes a neutral, which `Record<AgentState, number>`
cannot express. Appending `"neutral"` to `STATE_COLOR_NAMES` is **not**
acceptable — that array is `reduce`d positionally into palette indices
(`state-colors.ts:29`), so a 17th entry would resolve to palette index 16.

The configurable-name list and the ANSI-palette list are therefore separated:

```ts
export const ANSI_COLOR_NAMES = [...16 names];         // positional → palette index
export const STATE_COLOR_CHOICES = [...ANSI_COLOR_NAMES, "neutral"];  // picker

export type StateColor =
  | { kind: "palette"; index: number }
  | { kind: "neutral" };

export function resolveStateColors(cfg?): Record<AgentState, StateColor>;
/** The single exhaustive StateColor → CellAttrs resolver. */
export function stateAttrs(c: StateColor, emphasis: StateEmphasis): CellAttrs;
```

`DEFAULT_STATE_COLORS.complete` changes from `"blue"` to `"neutral"`. Users with
an explicit `stateColors.complete` are unaffected. Emphasis modifiers are
unchanged (waiting bold, complete dim).

Consumers, all of which must route through `stateAttrs`: sidebar indicators,
sidebar state labels, the Command Center breakdown row, Glass tile borders
(`glass/view.ts` `borderAttrsForState`), and **the Glass strip**
(`glass/strip.ts:17`) — which revision 1 omitted.

## The frame — `src/renderer.ts`

One rule row spans the full width at `geometry.topRuleRow`, and a matching rule
at `geometry.footerRuleRow`.

- Sidebar portion and main portion: `─` in `ruleFrame`.
- At `dividerCol`: `┼` on the top rule (the divider continues below), `┴` on the
  footer rule (the divider terminates).
- At `panelDividerCol`, when a panel is docked: the same junctions. Revision 1
  defined junctions only for the sidebar divider.

**Tab underline.** For each range from `getToolbarTabRanges()`, the rule cells in
that range are overwritten:

| Condition | Glyph | Colour |
|---|---|---|
| active, focused region | `━` | accent |
| active, unfocused region | `━` | accentMuted |
| hovered, not active | `─` | accentMuted |
| bell | `─` | attention |
| otherwise | `─` | ruleFrame |

Weight means *active*; hue means *state*. A bell tab stays light-weight so it
cannot be confused with the active tab — today it is bold and competes.

**Tab separator.** `" │ "` becomes two spaces; the underline delimits tabs and a
vertical bar competes with the divider junctions.

**Two-row toolbar.** The rule sits below both rows. The active tab's branch text
on row 2 renders one step brighter.

### Panel focus

`renderer.ts:380-384` already signals panel focus — the split divider is
`#58A6FF` when focused and palette 8 when not. Revision 1 claimed jmux signalled
this nowhere and would have added a second, conflicting cue.

Resolution: **the divider stops encoding focus** and is always `ruleFrame`. The
accent tab underline becomes the single focus cue, applied to whichever region
holds focus. This frees blue completely for links, and keeps one visual meaning
per signal.

Accepted cost: focus moves from a full-height vertical line to a short segment
at the top of the region, which is a quieter cue on a tall panel.

### Tab-range ownership

`InfoPanel` builds its own one-row tab grid (`info-panel.ts:98`) which the
renderer copies into row 0 (`renderer.ts:398`). The underline lives on a
*different* row, owned by the renderer, so the panel's tab ranges have to cross
that boundary.

`InfoPanel` gains `getTabRanges(): TabRange[]` returning ranges in panel-local
columns plus each tab's active/hover/bell state. The renderer offsets them by
`panelStartCol` and feeds them to the same rule compositor as the window tabs.
Neither component draws the underline itself.

## The footer — `src/footer.ts` (new), rendered by `src/renderer.ts`

Revision 1 described the footer in prose and its sample advertised `? keys`,
which is not a binding that exists — normal input falls through to tmux
(`input-router.ts:491`). It also moved the version string without noticing the
version row is clickable (`main.ts:1497` → `showVersionInfo()`).

A typed model, so hints, truncation and click targets are all decided in one
pure place:

```ts
export interface FooterSegment {
  key?: string;                 // rendered in accentMuted
  label: string;                // rendered in textSecondary
  onClick?: FooterAction;
}
export interface FooterModel {
  left: FooterSegment[];        // context keybinds
  right: FooterSegment[];       // ambient status
}
export function buildFooter(state: FooterState): FooterModel;
export function layoutFooter(model: FooterModel, cols: number):
  { cells: StyledLine; ranges: Array<{ startCol: number; endCol: number; action: FooterAction }> };
```

- **Hints are context-dependent**: normal, modal open, settings, Command Center,
  and panel-focused each supply their own left segments. Only bindings that
  exist may appear.
- **Right side**: the snapshot health chip (moved out of the toolbar) and the
  version segment, which carries `onClick: "changelog"` — preserving today's
  behaviour — and renders the **update-available** text when an update exists,
  which is the more important of the two signals and which revision 1 lost
  entirely.
- **Truncation**: the right side is laid out first and never truncates; left
  segments are dropped whole, lowest priority first, until they fit. A segment
  is never rendered partially. At 80 columns at least two left segments survive.
- `layoutFooter` returns click ranges; `InputRouter` dispatches footer clicks
  from them.

## Hint dialect — used everywhere

Key in `accentMuted`, label in `textSecondary` lowercase, `·` in `ruleHairline`.
No brackets, no "to".

```
↵ open  ·  ^a p palette  ·  ^a n new
```

Replaces `[o] Open  [l] Link  [a] Approve` in panel views, the settings hint
line (which moves into the footer), and the palette's absence of hints.

## Sidebar — `src/sidebar.ts`, `src/session-view.ts`

### Row plan

A session's height is `itemHeight()` (`sidebar.ts:356`), which returns a fixed
3; the gap between sessions is a separate `{type: "spacer"}` RenderItem. Scroll
and clamp already sum `itemHeight` over items, so those follow a height change
correctly. Two things do **not**:

- **Hover** is stored as a physical row. After a height change the same physical
  row belongs to a different session.
- **Scroll anchoring** — a promotion above the viewport shifts everything below
  it, so the selected session can slide out of view.

`buildSidebarLayout(items, viewport)` becomes the single row plan, returning per
item its start row, height, and selection target. Rendering, `clampScroll`,
`rowToSessionIndex`, `rowToSelection`, keyboard scroll-into-view, and hit-testing
all read it. On any layout change: scroll is re-anchored so the selected
session keeps its on-screen position where possible, and hover is recomputed
from the pointer's last physical position (or cleared if it now lands on a
different item).

**Collapse on promotion.** `itemHeight` for a session becomes 3 when the session
has agent state and 2 otherwise. `buildSessionView` gains
`hasStateRow: boolean` (`agentState !== null`) so height is a property of the
view model rather than probed during rendering.

Column arithmetic within a slot, which the code already satisfies and this spec
formalises: col 0 selection rail (`space.inset`), col 1 state glyph, col 2
gutter, col 3 first text column.

### Row 2 field order

Revision 1 said the context figure moves "ahead of the timer" and claimed it is
"only ever 3–4 characters". That is false — `formatContext` emits `10.0M` for
large values, and a test already asserts million formatting
(`session-view.test.ts:195`).

`SessionView` gains `contextLabel: string | null` (the formatted figure), so
formatting stops being private to `buildSessionRow3`. Row 2's right cluster is
packed right-to-left in this fixed order, and fields are dropped whole in this
priority when space runs out:

| Order (right → left) | Field | Drop priority |
|---|---|---|
| 1 | pipeline glyph | 5 (last dropped) |
| 2 | MR id | 4 |
| 3 | timer | 3 |
| 4 | context label *(non-promoted only)* | 1 (first dropped) |
| 5 | pinned count | 2 |

The branch takes the remaining width and truncates with `…`, as today.

### Group headers, rail, indicators

- `▾ private/tmp` becomes `private/tmp ─────────` — label in `textSecondary`,
  hairline in `ruleHairline` to the inner edge. Same idiom in settings sections
  and modal dividers.
- The selected row's rail (`▎`) is accent; the background tint is unchanged; the
  name becomes `textPrimary` bold rather than green.
- The six indicators keep their glyphs. Two lose a colour:

| Kind | Glyph | Today | After |
|---|---|---|---|
| error | `⨯` | red bold | unchanged |
| mcp-down | `⊘` | red dim | unchanged |
| running | `⏵` | green | unchanged |
| waiting | `!` | yellow bold | unchanged |
| complete | `✓` | blue dim | `textTertiary` dim |
| activity | `●` | green | `textTertiary` dim |

`activity` means "tmux saw output and there is no agent state" — not an agent
state, so it cannot wear one.

### Sidebar viewport

`HEADER_ROWS = 2` (`sidebar.ts:21`) hard-codes the sidebar's own wordmark+rule
header, and `main.ts:3548` passes it full terminal rows. With a 2-row toolbar
plus the frame rule, content starts at row 3 while the sidebar still starts
sessions at row 2; at the bottom it would draw under the footer.

`Sidebar.render()` takes the sidebar rectangle from `LayoutGeometry` instead of
assuming rows 0..height-1. Its internal header collapses to the wordmark only —
the frame rule is now the renderer's, not the sidebar's — and `footerRows()`
returns 0 since the version moves to the global footer. The scroll indicator
anchors to the bottom of the sidebar rectangle.

## Modals — `src/modal.ts` and each modal

`Modal` exposes only `preferredWidth`/`getGrid`/cursor/input; each modal owns
its own height, padding and cursor. "The shared layout does the rest" was not
implementable. A chrome primitive is introduced instead:

```ts
export interface ModalChrome {
  title: string;
  count?: string;
  hints: FooterSegment[];
  hairlineAfterInput?: boolean;
}
/** Returns the interior rect the modal may draw into, given its chrome. */
export function modalContentRect(chrome: ModalChrome, outer: { cols: number; rows: number }):
  { top: number; left: number; cols: number; rows: number };
export function drawModalChrome(grid: CellGrid, chrome: ModalChrome): void;
```

Each modal declares its chrome, asks for its content rect, and draws inside it;
cursor positions are expressed relative to that rect and translated once. The
renderer positions the whole thing within the **content band**, not the
terminal — `renderer.ts:146` currently places modals at one-third of
`totalGridRows` and only clamps the top, so a tall modal would now overlap the
footer.

Minimum-height behaviour is explicit: below the height needed for chrome plus
one content row, the hint footer is dropped first, then the count, then the
title.

Shared attr changes: `PROMPT_ATTRS` and `MATCH_ATTRS`/`SELECTED_MATCH_ATTRS`
green → accent; `CURRENT_TAG_ATTRS` yellow → `textPrimary` bold. New
`TITLE_ATTRS`, `COUNT_ATTRS`, `HINT_KEY_ATTRS`, `HINT_LABEL_ATTRS`,
`HAIRLINE_ATTRS`.

Affected: `command-palette`, `input-modal`, `list-modal`, `content-modal`,
`new-session-modal`, `textarea-modal`, `create-issue-modal`.

## Settings screen — `src/settings-screen.ts`

- Content is capped at `space.measure` (64) and centred **within the main
  rectangle** (i.e. `mainStartCol + (mainCols - 64) / 2`), not the terminal.
- Section headers become `Display ─────────`.
- **Collapsing stays.** Removing the disclosure triangle would hide real state —
  Enter toggles collapse (`settings-screen.ts:458`) and collapsed categories
  suppress their rows (`:592`). A collapsed section renders `n hidden` at the
  right of its hairline; an expanded one renders a bare hairline. The marker
  appears only when it means something, so it is not noise on every row. The
  `(n)` counts on expanded sections go.
- A **visual row plan** is introduced. Blank rows between sections break the
  current row↔index assumptions in rendering, navigation and scrolling
  (`:191`, `:562`, `:667`); navigation moves between *setting* indices while
  rendering maps them to visual rows, so a blank row can never be focused.
- Dot leaders are computed within the measure, `ruleHairline`, minimum two dots.
- `HEADER_ATTRS` moves from `#FBD4B8` to accent; the hint line moves to the
  footer.

## Panel views — `src/panel-view-renderer.ts`, `src/info-panel.ts`

- `CURSOR_ACCENT` and `ACTIVE_TAB_ACCENT` (`#FBD4B8`) → accent.
- `LINK_ACCENT` stays `#58A6FF`; with `complete` no longer blue and the divider
  no longer blue, blue means links alone.
- `PRIORITY2_ACCENT` (`#FF8C00`) retired; priority uses weight.
- Footer adopts the hint dialect.
- `InfoPanel` exposes `getTabRanges()` (see "Tab-range ownership").

## Command Center — `src/glass/`

Revision 1 described this section entirely wrongly, claiming tile borders were
tmux pane borders coloured via `toHex()` and that a cyan session-name chip lived
in the bottom-right border. Neither is true, and an implementation following it
would have edited the wrong layer.

What is actually there: `GlassView.drawTile()` paints borders directly into a
`CellGrid` (`glass/view.ts:504`) using `borderAttrsForState(agentState,
isFocused, stateColors)` (`:19`), and draws a **single label into the top
border** (`:524`) built by `buildPaneLabel()` as `"<session> › <title>"`
(`glass/pane-label.ts:16`). There is no second chip.

Changes:

- `borderAttrsForState` gains focus precedence: the focused tile's border is
  **accent**; unfocused tiles keep their state colour; a tile with no agent
  state uses `ruleFrame`. Exactly one accent border can exist, so "orange border
  = the pane I'm in" stays unambiguous while the state read across the other
  tiles is untouched. Focus currently rides on bold-vs-dim, which stays as a
  secondary cue.
- `labelChipAttrs(isFocused)` (`:43`) currently returns **green** when focused.
  Green is `affirmative`; focus is accent. It becomes accent when focused,
  `textSecondary` otherwise.
- The label itself is unchanged — the session prefix stays.
- The Glass strip (`glass/strip.ts`) routes its state dots and active-tab
  styling through `stateAttrs` and the tab-underline treatment respectively.
- Tile geometry derives from the content band, so tiles shrink by the chrome
  rows and Glass mouse mapping offsets by `contentTop`.

## Toolbar buttons — `src/main.ts` `makeToolbar()`

| Action | Today | After | Why |
|---|---|---|---|
| toggle panel | `◈` | `◧` | reads as a docked panel |
| new window | `＋` | `+` | `＋` is fullwidth — 2 cells among 1-cell glyphs |
| split vertical | `⏸` | `◫` | `⏸` is a pause button |
| split horizontal | `⏏` | `▤` | `⏏` is an eject button |
| launch Claude | `λ` | `λ` | kept; the pink goes to accent |
| settings | `⚙` | `⚙` | **unchanged** |

The settings glyph stays plain. Revision 1 proposed `⚙︎` with a VS15 text
selector; `cellWidth()` has no variation-selector handling (`cell-grid.ts`) and
`writeString`/`textCols` advance per code point, so jmux would allocate two
cells for a glyph the terminal draws in one — shifting every subsequent button
range and its mouse hit box. Making the text pipeline grapheme-aware is a
separate change and is not in scope.

Button separation drops to one space (`space.glyphGutter`); `space.groupGutter`
separates the cluster from the tab strip. The snapshot chip moves to the footer.

## Sequencing

1. `src/layout.ts` + migrate all 13 `- toolbarHeight` sites and
   `InputRouter.setGeometry`. **No visible change** — the geometry returns
   today's bands until chrome rows are enabled. This step is independently
   shippable and de-risks everything after it.
2. `chrome-tokens.ts`, the `StateColor` union, config, `stateAttrs`.
3. Enable the frame rules, tab underline, footer, toolbar glyphs; remove the
   no-sidebar early return.
4. Sidebar row plan and indicator tones.
5. Modals, settings, panel views, Glass — mutually independent.
6. Enable the token lint (below).

## Testing

Pure unit tests over logic modules. (`snapshot/integration-tmux.test.ts` is the
one exception in the suite; it spawns real tmux behind a `hasTmux()` guard and
is untouched by this work.)

**`layout.test.ts` (new) — the highest-value tests here**
- A geometry matrix across `termRows` ∈ {5, 6, 8, 10, 12, 24, 60} × toolbar
  height {1, 2} × diff {off, split, full} × sidebar {on, off}, asserting band
  boundaries are contiguous, non-overlapping, and cover exactly `termRows`.
- `ptyRows === contentRows` and `ptyCols === mainCols` in every case.
- `contentRows ≥ 1` at every size.
- Degradation order matches the table.
- A source assertion that `main.ts` contains no `- toolbarHeight` arithmetic.

**`input-router.test.ts` (rewrite the coordinate tests)**
- Every y-coordinate class (toolbar / top rule / content / footer rule / footer)
  routes correctly at toolbar heights 1 and 2, with and without a panel.
- Rule rows are inert — no toolbar action, no forward to tmux.
- Forwarded tmux coordinates match `contentTop` exactly (the one-row-off guard).
- Footer click ranges dispatch the right action, including the version segment.

**`renderer.test.ts` (extend + replace)**
- Junctions: `┼` at the sidebar and panel dividers on the top rule, `┴` on the
  footer rule.
- Tab underline for all five conditions, asserting glyph and colour separately.
- Exactly one region's active tab is accent when a panel is docked.
- The split divider is `ruleFrame` regardless of focus.
- Cursor placement is absolute and correct at toolbar heights 1 and 2.
- Modals never overlap the footer rows at any terminal height.
- The no-sidebar path composites toolbar, rules and footer (replaces `:89`).

**`sidebar.test.ts` (replace fixed-height assertions, don't extend)**
- `sidebar.test.ts:870` hard-codes 3-row slots; those become height-derived.
- `itemHeight` is 3 when promoted, 2 otherwise.
- Both hit maps agree with `buildSidebarLayout` for a mixed list.
- Promotion of an off-screen item preserves the selected session's screen
  position; hover is recomputed or cleared, never stale.
- Group header renders label + hairline to the inner edge.
- `complete` and `activity` resolve to the neutral tone.

**`session-view.test.ts` (extend)**
- `hasStateRow` iff `agentState !== null`; `contextLabel` is populated.
- Row-2 packing across the full combination of context / pinned / timer / MR /
  pipeline, including `10.0M`-width context values, asserting the documented
  drop priority.

**`state-colors.test.ts` (extend)** — `neutral` resolves to the neutral variant
and never to palette 16; an explicit `complete: "blue"` still resolves to
palette 4; `stateAttrs` is exhaustive over the union.

**`footer.test.ts` (new)** — truncation drops whole segments in priority order;
the right side never truncates; ≥2 left segments survive at 80 cols; click
ranges align with rendered columns; the update notice replaces the version when
present.

**`glass` tests** — `border-color.test.ts:5` and `label-chip.test.ts:11` encode
today's state-coloured borders and green focused label; both are **replaced** to
assert focus precedence and the accent label.

**`settings-screen.test.ts` (new)** — content never exceeds 64 cols and is
centred in the main rect at widths 80/120/240; navigation skips blank rows;
a collapsed section shows `n hidden` and an expanded one does not.

**Modal tests (extend each)** — chrome rows present, content drawn inside
`modalContentRect`, cursor absolute position correct, degradation order at small
heights.

## Token lint

Revision 1 proposed a repository-wide lexical ban on colour literals. That is
unworkable: it would flag `cell-grid.ts`'s structural defaults, the OSC 11
parser, RGB transport code and every test fixture, while missing shift-composed
literals like `(0xF0 << 16)` — which is the exact form the real offenders use.

Instead: an AST-based check over a named list of **chrome modules** (`sidebar`,
`renderer`, `modal` and the modals, `settings-screen`, `panel-view-renderer`,
`info-panel`, `glass/view`, `glass/strip`, `main`'s `makeToolbar`) asserting
that `CellAttrs` `fg`/`bg` values originate from a `chrome-tokens` or
`state-colors` import rather than a literal or a local expression. Theme
derivation, parsers, transport code, cell defaults and tests are out of its
scope by construction, not by exception list.

## Out of scope (YAGNI)

- Making the accent configurable.
- A light/dark toggle — OSC 11 derivation already handles this.
- Animation or transitions.
- Nerd-font glyphs.
- Making the text pipeline grapheme/variation-selector aware (this is why `⚙`
  stays plain).
- Restyling the diff panel's interior.
- Making footer contents configurable.

## Affected files

| File | Change |
|---|---|
| `src/layout.ts` | **new** — `computeLayoutGeometry`, the only row/col authority |
| `src/chrome-tokens.ts` | **new** — colours, spacing, frame glyphs |
| `src/footer.ts` | **new** — typed footer model, layout, click ranges |
| `src/theme.ts` | accent base; token rebuild hook |
| `src/state-colors.ts` | split name lists; `StateColor`; `stateAttrs` |
| `src/config.ts` | `"neutral"` accepted |
| `src/input-router.ts` | `setGeometry`; y-classification; footer clicks |
| `src/renderer.ts` | frame rules, junctions, underline, footer, no-sidebar path, modal placement |
| `src/main.ts` | 13 arithmetic sites → geometry; toolbar glyphs; footer state |
| `src/sidebar.ts` | row plan, variable height, viewport rect, hairlines, tones |
| `src/session-view.ts` | `hasStateRow`, `contextLabel`, row-2 order |
| `src/modal.ts` + 7 modals | chrome primitive, content rect, accent attrs |
| `src/settings-screen.ts` | measure, visual row plan, collapsed marker |
| `src/panel-view-renderer.ts` | accent, retire third orange, hint dialect |
| `src/info-panel.ts` | accent, `getTabRanges()` |
| `src/glass/view.ts`, `strip.ts` | focus precedence, accent label, `stateAttrs` |
