# Chrome visual language — UX/UI polish pass

## Problem

jmux's chrome has accumulated one styling decision at a time. Each was
reasonable in isolation; together they don't read as one designed surface.
Captured from a live v0.22.0 render:

- **The frame doesn't join.** The sidebar's header rule dead-ends into the
  divider (`──────│`) with no junction glyph, and the main area has no rule at
  all under the toolbar. The sidebar and the toolbar read as two unrelated
  pieces of furniture.
- **The active tab is signalled by colour alone** (peach fg + bold), which
  disappears on a monochrome terminal and is invisible to anyone who can't
  separate orange from grey. The docked info panel renders a second tab bar into
  the same row with the same treatment, so two tab bars claim "active"
  simultaneously and nothing indicates which region has focus.
- **Seven hues do thirteen jobs**, with three outright collisions:
  - Two different oranges both mean "active" in the same toolbar row —
    `#FBD4B8` (window tabs, settings header, panel cursor, info-panel tab) and
    `#F0883E` (diff-panel toolbar button).
  - Green means `running`, *and* `activity`, *and* the `jmux` wordmark, *and*
    the active sidebar row's name.
  - Blue means `complete`, *and* the panel link accent, *and* the split-divider
    focus colour.
- **The sidebar looks ragged.** The slot is a fixed 4 rows, but rows 2 and 3 are
  frequently empty on sessions with no OTEL data, so a bare session renders as
  name, branch, blank, blank.
- **The settings screen has no measure.** Dot leaders run to the terminal's
  right edge, so on a 200-column terminal the eye tracks ~150 columns from label
  to value — the layout gets *worse* the bigger the terminal is.
- **There is no footer.** A whole sidebar row is spent on `v0.22.0` instead.
- **Three hint-bar dialects** coexist: `[o] Open`, `Enter to edit · Esc to
  close`, and (in the command palette) nothing at all.
- **Toolbar glyphs are semantically wrong or metrically wrong.** `＋` is
  fullwidth among 1-cell glyphs; `⏸` (pause) means split-vertical; `⏏` (eject)
  means split-horizontal.

## Scope

A visual pass over jmux's own chrome: the frame, toolbar, sidebar, footer,
modals, settings screen, and panel views.

**No behaviour changes.** No keybinding moves, no command added or removed, and
no data stops being collected. Precisely three things change *form*, and one
thing is removed:

- `complete` and `activity` lose colours they shouldn't have had.
- The sidebar stops rendering rows that would be empty (nothing they contained
  is lost — see "collapse on promotion").
- Issue priority in panel views is carried by weight rather than a third orange.
- **Removed:** the settings screen's disclosure triangles and `(n)` counts, and
  the Command Center tile's bottom-right session-name chip. Both are duplicates
  — the counts are visible as rows, the chip repeats the tile's own title.

Out of scope: the Command Center's tile *layout*, the diff panel's internal
rendering (that's `hunk`'s output), agent-state derivation, and anything that
changes what data is collected or displayed.

## Design

### Single source of truth — `src/chrome-tokens.ts` (new)

Chrome colours are currently raw literals scattered across `sidebar.ts`,
`renderer.ts`, `modal.ts`, `settings-screen.ts`, `panel-view-renderer.ts`,
`info-panel.ts` and `main.ts`, each with its own `rebuildXColors()` re-theming
hook. That duplication is how the three colour collisions arose, so the fix has
to be structural, not cosmetic.

`chrome-tokens.ts` owns every chrome colour, every spacing constant, and every
frame glyph. Existing `rebuildXColors()` functions stay (their identity-
preserving in-place mutation is load-bearing for live re-theming) but become
thin re-reads of tokens rather than independent sources.

```ts
export const ACCENT_BASE = 0xF0883E;

export interface ChromeTokens {
  // Focus — exactly one accent, meaning "this has focus", nothing else.
  accent: CellAttrs;          // active tab underline, active-row rail, cursor,
                              // settings header, modal prompt, fuzzy-match chars
  accentMuted: CellAttrs;     // hovered tab, unfocused region's active tab

  // Neutral text ramp.
  textPrimary: CellAttrs;     // names, prose
  textSecondary: CellAttrs;   // metadata, branch, hint labels
  textTertiary: CellAttrs;    // receded content, dot leaders, rules

  // Structure.
  ruleFrame: CellAttrs;       // the frame rule
  ruleHairline: CellAttrs;    // group headers, modal dividers, dot leaders

  // Semantics — reserved, never used for chrome.
  stateRunning: CellAttrs;
  stateWaiting: CellAttrs;
  stateComplete: CellAttrs;
  stateError: CellAttrs;
  link: CellAttrs;            // #58A6FF — panel links only
}

export const space = {
  inset: 1,        // docked panel content starts 1 col off its edge
  modalInset: 2,   // floating surfaces get more air
  glyphGutter: 1,  // between a state glyph and the text it labels
  groupGutter: 2,  // between the tab strip and the button cluster
  blockGap: 1,     // between session slots, between settings sections
  measure: 64,     // max width of read-top-to-bottom content
} as const;

export const frame = {
  ruleLight: "─", ruleHeavy: "━",
  crossDown: "┼",  // rule crosses a divider that continues below
  crossUp: "┴",    // rule terminates a divider from above
  divider: "│",
} as const;
```

`rebuildChromeTokens()` runs at module load (from `DEFAULT_THEME`) and again on
OSC 11 detection. Accent routes through the existing `accentFor()` so it darkens
on light backgrounds. `textPrimary`/`textSecondary` route through `neutralFg()`.

**Invariant:** no module outside `chrome-tokens.ts` and `state-colors.ts` may
contain a colour literal. This is enforced by a test (see Testing).

### Colour roles

| Role | Value | Means |
|---|---|---|
| accent | `#F0883E` | focus, and only focus |
| accentMuted | `mix(termBg, anchor, 0.55)` | hover, unfocused region's active tab |
| textPrimary / Secondary / Tertiary | terminal default fg, dim, dimmer | prose / metadata / receded |
| ruleFrame, ruleHairline | tertiary tones | structure |
| stateRunning / Waiting / Complete / Error | green / yellow / *neutral* / red | agent state, nothing else |
| link | `#58A6FF` | panel links, nothing else |

Retired: `#FBD4B8` (pale peach — collapses into `#F0883E`), `#E8A0B4` (pink,
the Claude button), and cyan as a decorative accent. Cyan survives only as the
plan-mode badge, which is a genuine distinct mode.

The pale peach is retired rather than kept because at one cell tall it
desaturates into "slightly warm white" and stops reading as a colour — which is
precisely the job the new tab underline gives it.

### The frame — `src/renderer.ts`

A single rule row spans the full terminal width directly below the toolbar, and
a matching rule row sits directly above the footer.

- Sidebar portion: `─` in `ruleFrame`.
- At the sidebar divider column: `┼` on the toolbar rule (the divider continues
  below), `┴` on the footer rule (the divider terminates).
- Main portion: `─` in `ruleFrame`, **except** the column range of each tab.

**Tab underline.** For each tab range returned by `getToolbarTabRanges()`, the
rule cells within that range are overwritten:

| Tab condition | Glyph | Colour |
|---|---|---|
| active, in the focused region | `━` | accent |
| active, in an unfocused region | `━` | accentMuted |
| hovered (and not active) | `─` | accentMuted |
| bell | `─` | stateWaiting |
| otherwise | `─` | ruleFrame |

Weight always means *active*; hue always means *state*. The two channels can
never contradict each other. A bell on an inactive tab stays light-weight so it
cannot be mistaken for the active tab — today it is bold, and competes.

**Focus.** When the diff/info panel is docked it renders its own tab bar into
row 0. Only the **focused** region's active tab gets `accent`; the other gets
`accentMuted`. This gives jmux a panel-focus indicator it currently has nowhere,
at no additional cost, and resolves the two-tab-bars ambiguity.

**Two-row toolbar.** When `toolbarHeight === 2` the rule drops below *both*
rows, so it still terminates the tab group as a unit. The active tab's branch
text on row 2 renders one step brighter than the others.

**Tab separator.** The current `" │ "` separator between tabs becomes two
spaces. The underline now delimits tabs; a vertical bar between them competes
with the divider and with the rule's junction glyphs.

### Layout cost

The rules and footer cost three rows of terminal that currently go to tmux:

```
row 0            toolbar                      (unchanged)
row 1            frame rule                   (new)
rows 2 … N-3     sidebar + tmux content
row N-2          footer rule                  (new)
row N-1          footer                       (new)
```

This is a deliberate, accepted trade. Both rule rows and the footer are gated on
the same flag as the toolbar (`toolbarEnabled`) — when chrome is off, all three
disappear and the layout is byte-identical to today.

### The footer — `src/renderer.ts`, content from `src/main.ts`

One row, full width, below the footer rule.

- **Left:** context keybinds in the shared hint dialect (below).
- **Right:** ambient status — the snapshot health chip (moved out of the
  toolbar, where it needed a third alignment zone) and the version string
  (reclaimed from the sidebar row it currently occupies).

### Hint-bar dialect — used everywhere

Key in `accentMuted`, label in `textSecondary`, lowercase, `·` in
`ruleHairline` between pairs. No brackets, no "to".

```
↵ open  ·  ^a p palette  ·  ^a n new  ·  ? keys
```

Replaces `[o] Open  [l] Link  [a] Approve` in panel views, `Enter to edit  ·
Esc to close` in the settings screen, and the absence of any hints in the
command palette.

### Sidebar — `src/sidebar.ts`, `src/session-view.ts`

**Slot geometry — collapse on promotion.** A session slot is:

| Row | Content | Rendered when |
|---|---|---|
| 1 | indicator · name · mode badge · issue id | always |
| 2 | branch · pinned count · timer · MR id · pipeline glyph | always |
| 3 | context tokens · agent-state label | **only when the session has agent state** |
| gap | blank | always (`space.blockGap`) |

Column arithmetic within a slot, which the existing code already satisfies and
this spec formalises rather than changes: col 0 is the selection rail
(`space.inset`), col 1 the state glyph, col 2 the gutter
(`space.glyphGutter`), col 3 the first text column for rows 1–3.

Non-promoted sessions drop row 3 and their context figure (only ever 3–4
characters, e.g. `12k`) moves into row 2's right cluster, ahead of the timer.
Nothing is deleted; rows that would render empty simply aren't rendered.

`buildSessionView` gains a derived `hasStateRow: boolean` (true iff
`agentState !== null`) so slot height is computed from the view model rather
than probed during rendering. The sidebar's row-index maps
(`rowToSessionIndex`, `rowToSelection`) are built from the same value, so
hit-testing follows automatically.

Accepted cost: the list reflows when a session is promoted. Promotion is
infrequent and is itself a meaningful event.

**Group headers.** `▾ private/tmp` becomes `private/tmp ─────────` — the label
in `textSecondary`, then a space, then `─` in `ruleHairline` to the sidebar's
inner edge. The same idiom is used for settings sections and modal dividers, so
"a labelled hairline starts a group" is learned once.

**Selection rail.** The selected row's marker (`▎`, cols 0 of rows 1–3) is
`accent`; the background tint (`theme.selected`) is unchanged. The row's name
becomes `textPrimary` bold rather than green — green is now exclusively
`running`, and today a selected running session renders green-on-green with a
green dot beside it.

**Indicators.** The existing six glyphs are good and are kept. Two lose a colour
they shouldn't have had:

| Kind | Glyph | Today | After |
|---|---|---|---|
| error | `⨯` | red bold | unchanged |
| mcp-down | `⊘` | red dim | unchanged |
| agent running | `⏵` | green | unchanged |
| agent waiting | `!` | yellow bold | unchanged |
| agent complete | `✓` | blue dim | **`textTertiary` dim** |
| activity | `●` | green | **`textTertiary` dim** |

`activity` means "tmux saw output and we have no agent state". It is not an
agent state, so it cannot wear a state hue — today it is the same green as
`running`. After this change green means exactly one thing.

### Agent-state colours — `src/state-colors.ts`, `src/config.ts`

`complete`'s default becomes a neutral rather than a palette colour, which the
current `Record<AgentState, number>` return type cannot express.

```ts
export type StateColor =
  | { kind: "palette"; index: number }
  | { kind: "neutral" };

export function resolveStateColors(cfg?): Record<AgentState, StateColor>
```

- `"neutral"` joins `STATE_COLOR_NAMES` as a valid configured value and appears
  in the settings picker, so the change is reversible from the UI.
- `DEFAULT_STATE_COLORS.complete` changes from `"blue"` to `"neutral"`.
- Users with an explicit `stateColors.complete` in their config are unaffected.

Every consumer of `resolveStateColors` (sidebar indicators, state labels,
Command Center breakdown row, glass tile borders via `toHex()`) switches on the
union. Emphasis modifiers are unchanged — waiting stays bold, complete stays
dim.

### Modals — `src/modal.ts` and each modal

Every modal gains the same three-part structure. The existing surface + shadow
does the edge; no border and no rail is added. A modal is unambiguously focused
already, so an accent rail there would be decoration and would dilute
"accent rail = focus".

```
  Commands                                    18     ← title (primary bold) + count (secondary)
  ▸ switch│                                          ← prompt (accent) + input
  ─────────────────────────────────────────────      ← hairline (ruleHairline)
  ▸ Switch to api-pagination            session      ← results
    …
  ↑↓ move  ·  ↵ run  ·  esc close                    ← hint footer
```

Content is inset by `space.modalInset`. Shared attr changes in `modal.ts`:

- `PROMPT_ATTRS`: green → accent.
- `MATCH_ATTRS` / `SELECTED_MATCH_ATTRS`: green → accent. Green now means
  `running`; a fuzzy-match highlight is not an agent state.
- `CURRENT_TAG_ATTRS` / `SELECTED_CURRENT_TAG_ATTRS`: yellow → `textPrimary`
  bold, for the same reason.
- New `TITLE_ATTRS`, `COUNT_ATTRS`, `HINT_KEY_ATTRS`, `HINT_LABEL_ATTRS`,
  `HAIRLINE_ATTRS`.

Modals affected: `command-palette`, `input-modal`, `list-modal`,
`content-modal`, `new-session-modal`, `textarea-modal`, `create-issue-modal`.
Each supplies a title string and a hint list; the shared layout does the rest.

### Settings screen — `src/settings-screen.ts`

- Content is capped at `space.measure` (64 columns) and centred within the main
  area. The layout stops degrading as the terminal grows.
- Section headers become the group-hairline idiom: `Display ─────────`.
- Disclosure triangles and `(n)` counts are removed. A collapsed section is rare
  enough that a marker on every row of a top-to-bottom screen is noise; a blank
  line (`space.blockGap`) between sections does the same job.
- Dot leaders are computed within the measure, `ruleHairline` tone, minimum two
  dots, one space either side.
- `HEADER_ATTRS` moves from `PEACH_BASE` (`#FBD4B8`) to the shared accent.
- The hint line adopts the shared dialect.

### Panel views — `src/panel-view-renderer.ts`, `src/info-panel.ts`

- `CURSOR_ACCENT` (`#FBD4B8`) → shared accent.
- `LINK_ACCENT` stays `#58A6FF` — with `complete` no longer blue, blue means
  links and nothing else.
- `PRIORITY2_ACCENT` (`#FF8C00`) is a third orange and is retired; issue
  priority uses the neutral ramp's weight, not a hue.
- Footer adopts the shared hint dialect.
- `info-panel.ts`'s `ACTIVE_TAB_ACCENT` (`#FBD4B8`) → shared accent, and its tab
  bar adopts the underline treatment including the focused/unfocused
  distinction.

### Toolbar buttons — `src/main.ts` `makeToolbar()`

| Action | Today | After | Why |
|---|---|---|---|
| toggle panel | `◈` | `◧` | reads as a docked panel, not a gem |
| new window | `＋` | `+` | `＋` is fullwidth — 2 cells among 1-cell glyphs |
| split vertical | `⏸` | `◫` | `⏸` is a pause button |
| split horizontal | `⏏` | `▤` | `⏏` is an eject button |
| launch Claude | `λ` | `λ` | kept — distinctive, and the pink goes to accent |
| settings | `⚙` | `⚙︎` | VS15 text selector; avoids emoji presentation |

Separation between buttons drops from two spaces to one (`space.glyphGutter`),
so the cluster reads as one control group; `space.groupGutter` (2) separates
that cluster from the tab strip. The snapshot status chip leaves the toolbar for
the footer.

### Command Center tiles — `src/glass/`

Tile borders are real tmux pane borders set via tmux options, so they are
coloured through `toHex()` and are not part of the `CellGrid` pipeline. Two
changes:

- **Focus outranks state on a tile border.** Tile borders are state-coloured
  today, which collides with using accent for focus. The rule: the focused
  tile's border is `accent`; every unfocused tile keeps its state colour, and a
  tile with no state uses `ruleFrame`. Exactly one accent border can be on
  screen, so "orange border = the pane I'm in" stays unambiguous, and the state
  read across the other tiles is untouched. State borders continue to route
  through `resolveStateColors` and must handle the `neutral` variant.
- The cyan session-name chip in the tile's bottom-right border is removed — it
  repeats the title already present in the top border.

## Sequencing

The work has one hard ordering constraint and is otherwise independent, which
matters because the literal guard fails until every consumer has migrated:

1. `chrome-tokens.ts` + `state-colors.ts` union + config — no visible change.
2. Frame rules, tab underline, footer, toolbar glyphs (`renderer.ts`,
   `main.ts`). This is the change with layout arithmetic in it.
3. Sidebar slot geometry and indicator tones.
4. Modals, settings screen, panel views, Command Center tiles — mutually
   independent, any order.
5. Enable the literal guard once step 4 is complete.

## Testing

Pure unit tests over the logic modules, per house convention. No test spawns
tmux.

**`src/__tests__/chrome-tokens.test.ts` (new)**
- Every role resolves to a complete `CellAttrs` under both `DEFAULT_THEME` and a
  detected light background.
- `accent` darkens on a light background (`accentFor` applied).
- `rebuildChromeTokens()` preserves object identity for every exported attr.
- **Literal guard:** every file in `src/` except `chrome-tokens.ts`,
  `state-colors.ts` and `theme.ts` is free of colour literals — no `0x??????`
  RGB constants and no bare `fg:`/`bg:` numeric palette indices. This is the
  test that keeps the collisions from growing back.

**`src/__tests__/session-view.test.ts` (extend)**
- `hasStateRow` is true iff `agentState !== null`.
- A non-promoted session with context tokens surfaces the figure in row 2's
  right cluster; a promoted one leaves it on row 3.
- Field priority under truncation is unchanged for every existing case.

**`src/__tests__/sidebar.test.ts` (extend)**
- Slot height is 3 rows + gap when promoted, 2 rows + gap otherwise.
- `rowToSelection` and `rowToSessionIndex` agree with the rendered slot height
  for a mixed list of promoted and non-promoted sessions.
- Group header renders `label` + space + hairline to the inner edge.
- `complete` and `activity` indicators resolve to the neutral tone.
- The selected row's rail is accent and its name is not green.

**`src/__tests__/renderer.test.ts` (extend)**
- The frame rule row: `┼` at the divider on the toolbar rule, `┴` on the footer
  rule, `─` elsewhere.
- Tab underline composition for each of the five conditions (active-focused,
  active-unfocused, hovered, bell, plain), asserted on glyph *and* colour
  independently so the two channels are verified separately.
- With a docked panel, exactly one region's active tab is `accent`.
- Two-row toolbar puts the rule below both rows.
- Tab ranges account for the two-space separator.
- With `toolbarEnabled === false` the grid is unchanged from today.

**`src/__tests__/state-colors.test.ts` (extend)**
- `resolveStateColors` returns the `neutral` variant for the new `complete`
  default and for an explicit `"neutral"` config value.
- An explicit `complete: "blue"` still resolves to palette 4.

**`src/__tests__/settings-screen.test.ts` (new)**
- Content never exceeds `space.measure` columns at terminal widths of 80, 120
  and 240, and is centred at each.
- Leaders are at least two dots and never overlap the label or the value.

**Modal tests (extend each)** — title row, hairline row and hint footer are
present, and content is inset by `space.modalInset`.

## Out of scope (YAGNI)

- Making the accent configurable. One accent, chosen well, is the point.
- A light/dark theme *toggle* — jmux already derives from the terminal
  background via OSC 11 and should keep doing exactly that.
- Animation or transitions of any kind.
- Nerd-font glyphs. Everything stays inside plain Unicode with a stated
  fallback story.
- Restyling the diff panel's interior — that's `hunk`'s output, not ours.
- Making the footer's contents configurable.

## Affected files

| File | Change |
|---|---|
| `src/chrome-tokens.ts` | **new** — colours, spacing, frame glyphs |
| `src/theme.ts` | accent base constant; token rebuild hook |
| `src/state-colors.ts` | `StateColor` union; `neutral`; `complete` default |
| `src/config.ts` | `"neutral"` accepted as a state colour |
| `src/renderer.ts` | frame rules, junctions, tab underline, footer, tab separator |
| `src/main.ts` | toolbar glyphs, footer content, layout row arithmetic |
| `src/sidebar.ts` | slot geometry, group hairlines, rail, indicator tones |
| `src/session-view.ts` | `hasStateRow`; context figure fallback into row 2 |
| `src/modal.ts` | accent prompt/match; title, count, hint, hairline attrs |
| `src/command-palette.ts` and 6 sibling modals | title + hint footer + inset |
| `src/settings-screen.ts` | measure, centring, section hairlines, leaders |
| `src/panel-view-renderer.ts` | accent, retire third orange, hint dialect |
| `src/info-panel.ts` | accent, tab underline, focus distinction |
| `src/glass/` | tile border focus colour, remove name chip |
