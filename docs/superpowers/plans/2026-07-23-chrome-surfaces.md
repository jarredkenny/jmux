# Chrome Surfaces Implementation Plan (visible chrome, part 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Migrate the interior surfaces — settings, sidebar, modals, panel views, Command Center — onto the chrome tokens and shared dialects the frame established, completing the visual-language spec.

**Architecture:** Builds on the completed frame (`chrome-tokens`, `frame-layout` chrome rows, footer, accent underline). Replaces the temporary `state-colors` palette bridge with a real `stateAttrs`; gives the sidebar its group hairlines and neutral activity; caps and centres settings; adds the modal chrome primitive; migrates panel/glass colours to tokens; and guards it all with a scoped token lint.

**Tech Stack:** Bun 1.3.8+, TypeScript strict, `bun:test`, no bundler.

## Global Constraints

- Target **Bun, not Node**. `cellWidth`/`textCols` stay the single width table. Pure logic modules; no new deps.
- Colours from `src/chrome-tokens.ts`; paint via `writeCell`/`writeStyledLine`/`drawBox`; no hand-written `{char:"",width:0}` and no RGB literals in chrome surfaces.
- **One accent (`tokens.accent`, `#F0883E`) means focus.** Green = affirmative (running, pipeline-passed, enabled setting); yellow = attention; red = failure; blue (`tokens.link`) = links; `complete`/`activity` = neutral; cyan = plan mode.
- Pure `bun:test` unit tests; no test spawns tmux. Strict TypeScript; `any` unacceptable.
- `git add` only the files a task changes, by exact filename. Never `git add -A`; never add anything under `.superpowers/`.
- Never sign off as Claude in git.

**The temporary bridge to remove (Task 3):** plan-2 Task 3 left `paletteFromStateColors`/`stateColorToPalette` in `main.ts` and `state-colors.ts` mapping the `StateColor` union to palette indices (`neutral → 8`). Task 3 here replaces it with `stateAttrs`.

---

### Task 1: Settings & Command Center are clean full-screen views

**Files:**
- Modify: `src/main.ts` (the settings and glass render paths)
- Test: `src/__tests__/` (whatever seam is reachable — see step 4)

**Interfaces:**
- Consumes: `computeFrameLayout`.
- Produces: no new exports; these two views render at full height with no frame chrome.

**Context — the blemish this fixes:** the frame reserves a toolbar row + top rule + footer. Settings and Command Center pass `toolbar: null` (they have no window tabs), so the toolbar row (grid row 0) renders blank — a visible empty strip above those screens, plus they lose their bottom rows to the footer bands. They are full-screen takeovers, not content-in-the-main-pane, so they should not carry the frame at all.

- [ ] **Step 1: Write a failing test.** The render path is in `main.ts` (not directly importable), so test the layout decision: assert that the layout used for the settings/glass render has `toolbarRows === 0`, `topRuleRow === null`, `footerRow === null`, and `contentTop === 0` / `contentRows === termRows` — i.e. a full-screen chrome-less band. If the only reachable seam is `computeFrameLayout` itself, the test is: `computeFrameLayout({ ...base, toolbarRows: 0, frameRulesEnabled: true, footerEnabled: true })` yields no chrome and full-height content (this already holds from plan-2 Task 1's `resolveChrome` — `toolbarRows === 0 ⇒ NONE`). The real change is that `main.ts` passes `toolbarRows: 0` for these two renders.
- [ ] **Step 2: Run to verify** the current settings/glass render uses the toolbar-ful layout (reproduce the blank row by asserting the pre-change layout has `contentTop === 2`).
- [ ] **Step 3: Implement.** In the settings render branch and the glass render branch of `main.ts`, compute a dedicated full-screen layout: `computeFrameLayout({ termCols, termRows, sidebarWidth: <as today>, borderWidth: BORDER_WIDTH, toolbarRows: 0, diffState: "off", requestedPanelCols: 0, frameRulesEnabled: false, footerEnabled: false })`. Size the settings/glass content grid to that layout's `contentRows` (which is now `termRows`) and pass `toolbar: null` to `compositeGrids` with that layout. The sidebar still renders beside them (sized via `sidebarBottomRow(layout)`, which for a chrome-less layout returns `termRows`). Result: no blank toolbar row, no footer bands, content full height.
- [ ] **Step 4:** Full `bun test` + `bun run typecheck`. Interactive: open settings and Command Center in an isolated `--demo` jmux; confirm no blank strip at the top and nothing clipped at the bottom. Report which you verified.
- [ ] **Step 5: Commit.**

```bash
git add src/main.ts src/__tests__/<the test file>
git commit -m "fix(chrome): settings and Command Center render frameless full-screen

They pass toolbar:null, so the frame's reserved toolbar row rendered as a
blank strip above them and the footer bands clipped their bottoms. They are
full-screen takeovers, not main-pane content, so they now render with a
chrome-less full-height layout — no toolbar row, no rules, no footer."
```

---

### Task 2: Sidebar — neutral activity, group hairlines, tokens

**Files:**
- Modify: `src/sidebar.ts`
- Test: `src/__tests__/sidebar.test.ts` (extend)

**Interfaces:**
- Consumes: `chrome-tokens`.
- Produces: the sidebar's chrome colours come from `tokens.*`; the `activity` indicator is neutral; group headers use the `label ────` hairline; the selected-row name is `textPrimary` bold, not green.

- [ ] **Step 1: Write failing tests.** The `activity` indicator (`●`, currently palette-2 green, identical to `running`) resolves to `tokens.textTertiary` (neutral). Group headers render `label` in `textSecondary` then `frame.ruleLight` in `tokens.ruleHairline` to the sidebar's inner edge (replacing the `▾ label` disclosure form). The selected session's name renders `textPrimary` bold (not palette-2 green); the selection rail (`▎`) is `tokens.accent`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Migrate `ACTIVITY_ATTRS` → `tokens.textTertiary`. Change `GROUP_HEADER_ATTRS` and the group-header render to the hairline idiom (`label` + space + `ruleHairline` fill). Change the active-row name attrs from green to `tokens.textPrimary` bold and the rail to `tokens.accent`. Leave the state indicators (`running` green, `waiting` yellow, `complete` neutral, `error`/`mcp-down` red) as they are — those are agent state, correct. Keep emphasis (waiting bold, complete dim).
- [ ] **Step 4:** `bun test` + `bun run typecheck`. Interactive: sidebar shows group headers as hairlines, activity as neutral (only running is green), the selected row's name white-bold with an accent rail. Report what you saw.
- [ ] **Step 5: Commit.**

```bash
git add src/sidebar.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): neutral activity, group hairlines, accent selection

activity was green — identical to running — so a session with mere tmux
output looked like a running agent; it goes neutral, leaving green to mean
running alone. Group headers become 'label ────' hairlines (the idiom used
by the frame and settings). The selected row's name is white-bold with an
accent rail rather than green-on-green with the running dot."
```

---

### Task 3: `stateAttrs` replaces the palette bridge

**Files:**
- Modify: `src/state-colors.ts`, `src/main.ts`, `src/sidebar.ts`, `src/glass/view.ts`
- Test: `src/__tests__/state-colors.test.ts` (extend)

**Interfaces:**
- Consumes: `StateColor` union (plan-2 Task 3), `chrome-tokens`.
- Produces: `stateAttrs(c: StateColor, emphasis: { bold?: boolean; dim?: boolean }): CellAttrs` — the single exhaustive resolver from a `StateColor` to drawing attrs, with `neutral` → `tokens.textTertiary`'s tone. Removes `paletteFromStateColors`/`stateColorToPalette`.

- [ ] **Step 1: Write failing tests.** `stateAttrs({kind:"palette",index:2}, {})` → palette-2 attrs; `stateAttrs({kind:"neutral"}, {dim:true})` → a neutral dim attr (matching `tokens.textTertiary`), NOT palette 8 by number; emphasis flags applied. Exhaustive over the union.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `stateAttrs`.** Route the sidebar's state indicators + labels, the Command Center breakdown row, glass tile borders, and the glass strip through it. `sidebar.setStateColors` may change from `Record<AgentState, number>` to `Record<AgentState, StateColor>` (or accept resolved `CellAttrs`) — pick the cleaner and update the call sites. Delete `paletteFromStateColors`/`stateColorToPalette`.
- [ ] **Step 4:** `bun test` + `bun run typecheck`. `complete` still renders neutral (now via `stateAttrs`, tone from `tokens.textTertiary` rather than palette 8) — a subtle tone shift is acceptable as long as it reads as a receded neutral. Update any test asserting the palette-8 number to the token tone.
- [ ] **Step 5: Commit.**

```bash
git add src/state-colors.ts src/main.ts src/sidebar.ts src/glass/view.ts src/__tests__/state-colors.test.ts
git commit -m "refactor(state-colors): stateAttrs replaces the palette bridge

The temporary paletteFromStateColors/stateColorToPalette bridge mapped the
StateColor union to palette indices (neutral->8). stateAttrs is the single
exhaustive resolver to drawing attrs, with neutral sourced from the chrome
token rather than a magic palette number. Sidebar indicators/labels, the
Command Center breakdown, and glass borders/strip all route through it."
```

---

### Task 4: Sidebar row collapse-on-promotion

**Files:**
- Modify: `src/sidebar.ts`, `src/session-view.ts`
- Test: `src/__tests__/sidebar.test.ts`, `src/__tests__/session-view.test.ts` (extend)

**Interfaces:**
- Consumes: existing.
- Produces: `SessionView.hasStateRow: boolean` (`agentState !== null`); `itemHeight` returns 3 for a promoted session, 2 otherwise; a `buildSidebarLayout` row plan drives render, scroll, clamp, and both hit maps; non-promoted sessions surface their context figure in row 2's right cluster.

**This is the one behaviour change with reflow risk — do it carefully.**

- [ ] **Step 1: Write failing tests.** `hasStateRow` true iff `agentState !== null`. `itemHeight(session)` is 3 when promoted, 2 otherwise. `rowToSelection`/`rowToSessionIndex` agree with the rendered slot height for a mixed list. On promotion of an off-screen session, the selected session keeps its on-screen position (scroll re-anchored) and hover is recomputed or cleared (never stale). A non-promoted session with a context figure surfaces it in row 2's right cluster; a promoted one leaves it on row 3.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Add `hasStateRow` to `buildSessionView`. Make `itemHeight` height-of-state-aware. Introduce `buildSidebarLayout(items, viewport)` returning per-item start row + height + selection target; render, `clampScroll`, the row maps, keyboard scroll-into-view, and hit-testing all read it. On layout change: re-anchor scroll to keep the selected session's screen position where possible; recompute hover from the pointer's last position or clear it. Row-2 field order for a non-promoted session: the context figure joins the right cluster ahead of the timer, dropped first under truncation (`session-view.ts`'s documented drop priority).
- [ ] **Step 4:** `bun test` + `bun run typecheck`. Interactive: a mixed list of promoted/non-promoted sessions shows no ragged empty rows; promoting a session doesn't strand the cursor or scroll. Report what you saw.
- [ ] **Step 5: Commit.**

```bash
git add src/sidebar.ts src/session-view.ts src/__tests__/sidebar.test.ts src/__tests__/session-view.test.ts
git commit -m "feat(sidebar): collapse the state row on non-promoted sessions

A session slot was a fixed 3 rows, but row 3 (context + state label) is
empty until an agent state exists, so bare sessions rendered with a blank
row. Non-promoted sessions now drop row 3 and surface their context figure
in row 2's right cluster; a single row plan drives render, scroll, clamp
and hit-testing so promotion can't strand hover or the scroll anchor."
```

---

### Task 5: Settings measure, section hairlines, collapsed marker

**Files:**
- Modify: `src/settings-screen.ts`
- Test: `src/__tests__/settings-screen.test.ts` (new)

**Interfaces:**
- Consumes: `chrome-tokens`.
- Produces: content capped at `space.measure` (64) and centred in the main rect; section headers as `label ────` hairlines; a `n hidden` marker on collapsed sections (replacing the `(n)` counts); the hint line in the shared dialect.

- [ ] **Step 1: Write failing tests.** Content never exceeds `space.measure` columns and is centred in the main rectangle at widths 80/120/240. A collapsed section renders `n hidden` at the right of its hairline; an expanded section renders a bare hairline (no `(n)`). Navigation moves between setting indices and never lands on a blank row. Dot leaders are at least two dots, `ruleHairline` tone, computed within the measure.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Introduce a visual-row plan separating setting indices from rendered rows (blank rows between sections can never be focused). Cap and centre at `space.measure` within the main rect. Section headers → hairline idiom; keep collapse (Enter toggles it) but show `n hidden` only on collapsed sections; drop the `(n)` counts. `HEADER_ATTRS` → `tokens.accent`. Hint line → shared dialect (moves to nothing special — settings is frameless per Task 1, so it keeps its own hint line at the band bottom in the shared dialect).
- [ ] **Step 4:** `bun test` + `bun run typecheck`. Interactive: settings content is a centred 64-col column, sections are hairlines, a collapsed section shows `n hidden`. Report what you saw.
- [ ] **Step 5: Commit.**

```bash
git add src/settings-screen.ts src/__tests__/settings-screen.test.ts
git commit -m "feat(settings): measured, centred, hairline sections, collapsed marker

Dot leaders ran to the terminal edge, so the layout got worse the wider the
terminal. Content is now capped at 64 columns and centred; section headers
become 'label ────' hairlines; collapse is kept but shown as 'n hidden'
only when collapsed rather than a count on every section; the header uses
the accent."
```

---

### Task 6: Modal chrome — title, hairline, hint footer, accent

**Files:**
- Modify: `src/modal.ts` and each modal (`command-palette`, `input-modal`, `list-modal`, `content-modal`, `new-session-modal`, `textarea-modal`, `create-issue-modal`)
- Test: the modal test files (extend)

**Interfaces:**
- Consumes: `chrome-tokens`, `footer` dialect helpers.
- Produces: a `ModalChrome`/`modalContentRect`/`drawModalChrome` primitive; every modal gains a title, a hairline under the input, and a hint footer; the prompt and fuzzy-match highlight move green → `tokens.accent`; the current-tag chip yellow → `textPrimary` bold.

- [ ] **Step 1: Write failing tests.** `modalContentRect(chrome, outer)` returns an interior rect leaving room for title + hairline + hint footer; content drawn inside it; degradation drops hint→count→title as height shrinks. `PROMPT_ATTRS`/`MATCH_ATTRS`/`SELECTED_MATCH_ATTRS` are `tokens.accent` (were green); `CURRENT_TAG_ATTRS` is `textPrimary` bold (was yellow). The renderer positions the modal within the content band, not the full terminal (so a tall modal can't overlap the footer).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the `ModalChrome` primitive in `modal.ts`; each modal declares its chrome (title + hint list), asks for its content rect, draws inside it, and expresses cursor position relative to that rect. Migrate the shared attrs. Fix the renderer's modal placement to the content band.
- [ ] **Step 4:** `bun test` + `bun run typecheck`. Interactive: open the command palette — it has a title, a hairline under the input, a hint footer, and an accent prompt/match. Report what you saw.
- [ ] **Step 5: Commit.**

```bash
git add src/modal.ts src/command-palette.ts src/input-modal.ts src/list-modal.ts src/content-modal.ts src/new-session-modal.ts src/textarea-modal.ts src/create-issue-modal.ts src/__tests__/*modal*.ts src/__tests__/command-palette.test.ts
git commit -m "feat(modals): title, hairline, hint footer, accent prompt/match

Every modal gains a title, a hairline under the input, and a hint footer in
the shared dialect via one ModalChrome primitive. The prompt caret and
fuzzy-match highlight move from green to accent (green now means running; a
match is focus), and the current-tag chip from yellow to white-bold.
Modals are positioned within the content band so a tall one can't overlap
the footer."
```

---

### Task 7: Panel views + glass colour migration

**Files:**
- Modify: `src/panel-view-renderer.ts`, `src/info-panel.ts`, `src/glass/view.ts`, `src/glass/strip.ts`
- Test: the corresponding test files (extend/replace)

**Interfaces:**
- Consumes: `chrome-tokens`, `stateAttrs` (Task 3).
- Produces: panel/glass colours from tokens; the third orange retired; focus precedence on glass tile borders; the glass label accent-on-focus.

- [ ] **Step 1: Write failing tests.** `CURSOR_ACCENT`/`ACTIVE_TAB_ACCENT` (pale peach `#FBD4B8`) → `tokens.accent`. `LINK_ACCENT` stays blue (`tokens.link`). `PRIORITY2_ACCENT` (`#FF8C00`, the third orange) retired — priority uses weight, not hue. Glass tile border: the **focused** tile is `tokens.accent`; an unfocused tile keeps its state colour (via `stateAttrs`); a stateless tile uses `tokens.ruleFrame`. `labelChipAttrs(true)` (glass focused label, currently green) → `tokens.accent`; unfocused → `textSecondary`. The glass strip routes state dots through `stateAttrs`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the migrations. Glass border focus precedence: exactly one accent border can be on screen (the focused tile); others show state or `ruleFrame`. Panel-view footer adopts the shared hint dialect.
- [ ] **Step 4:** `bun test` + `bun run typecheck`. Update `glass/border-color.test.ts` and `label-chip.test.ts` (they encode the old state-coloured borders / green label) to focus precedence + accent label. Interactive: Command Center focused tile has an accent border, the focused label is accent, links in panels are blue. Report what you saw.
- [ ] **Step 5: Commit.**

```bash
git add src/panel-view-renderer.ts src/info-panel.ts src/glass/view.ts src/glass/strip.ts src/__tests__/panel-view-renderer.test.ts src/__tests__/glass/border-color.test.ts src/__tests__/glass/label-chip.test.ts src/__tests__/info-panel.test.ts
git commit -m "feat(panels): token colours, retire the third orange, glass focus border

CURSOR/ACTIVE_TAB accent move to the shared accent; the third orange
(#FF8C00 priority) retires in favour of weight; links stay blue. On a
Command Center tile, focus outranks state: the focused tile's border is
accent (exactly one on screen), unfocused tiles keep their state colour,
and the focused label goes accent instead of green."
```

---

### Task 8: The token lint

**Files:**
- Create: `src/__tests__/chrome-token-lint.test.ts`

**Interfaces:**
- Consumes: the source tree.
- Produces: a test that fails if a chrome module introduces a raw colour literal instead of sourcing from `chrome-tokens`/`state-colors`.

- [ ] **Step 1: Write the lint test.** Over a named list of chrome modules (`sidebar`, `renderer`, `modal` + the modals, `settings-screen`, `panel-view-renderer`, `info-panel`, `glass/view`, `glass/strip`, and `main`'s `makeToolbar`/footer state), assert no `CellAttrs` `fg`/`bg` value originates from a raw RGB literal (`0x??????` shifted or direct) or a bare numeric palette index that isn't a documented exception. Prefer an AST walk (Bun can parse via `Bun.Transpiler` or a lightweight regex over `fg:`/`bg:` assignments as a pragmatic first cut — a regex that flags `fg: 0x` / `fg: <digit>` outside an allowlist is acceptable if an AST is too heavy, as long as it doesn't false-positive on `chrome-tokens.ts`/`state-colors.ts`/`theme.ts`/tests). Document the allowlist (palette indices that are genuinely semantic and token-backed, e.g. the bell `3`/idle `8` already noted as token-equal).
- [ ] **Step 2: Run it** — it should PASS now (Tasks 1–7 migrated the chrome). If it flags a real remaining literal, fix that literal (route it through a token) rather than widening the allowlist.
- [ ] **Step 3:** `bun test` + `bun run typecheck`.
- [ ] **Step 4: Commit.**

```bash
git add src/__tests__/chrome-token-lint.test.ts src/<any file whose literal it caught>
git commit -m "test(chrome): guard the token single-source with a scoped lint

A test over the chrome modules that fails if a raw colour literal reappears
where a chrome-tokens/state-colors reference belongs. Scoped to the chrome
surfaces by construction — theme derivation, parsers, transport and tests
are out of scope — so it can't false-positive on legitimate literals."
```

---

## Verification

- [ ] `bun test` — full suite green.
- [ ] `bun run typecheck` — clean.
- [ ] `bun run docker` — clean-env sanity.
- [ ] Interactive, dark AND light terminal: settings (measured, centred, no blank strip), sidebar (hairlines, neutral activity, accent selection, collapsed rows), a modal (title/hairline/hint/accent), Command Center (accent focus border), panel links blue.
- [ ] The whole-branch review certifies the visual language is coherent end to end.

## Sequencing note

Tasks 1, 2, 5, 6, 7 are visible; 3, 4, 8 are structural. Task 3 (`stateAttrs`) should land before Task 7 (glass consumes it). Task 4 (row collapse) is the one behaviour change and is independent. Task 8 (lint) runs last, after every surface has migrated.
