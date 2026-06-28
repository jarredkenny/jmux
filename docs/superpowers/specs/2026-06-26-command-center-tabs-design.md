# Command Center — named tabs

**Status:** design approved, ready for planning
**Date:** 2026-06-26
**Builds on:** the shipped non-destructive Command Center (`src/glass/*`, `src/main.ts` glass orchestration). See the `project_pane_of_glass` memory and the (now-superseded-in-its-break-pane-parts) `2026-06-15-pane-of-glass-pane-pinning-design.md`.

## Summary

Today the Command Center is a **single flat grid** of every pinned pane —
manual pins (`@jmux-pinned="1"`, a per-pane tmux option) plus auto-detected
agent panes (the `autoPinAgentPanes` setting) — rendered as live, drivable
mirror tiles. It does not scale past a handful of agents: a dozen parallel
agents become a dozen tiles on one screen with no way to group them by what
they're *for*.

This adds **named tabs** to the Command Center. A pane is pinned to exactly one
tab; tabs are user-named buckets ("Backend", "Code Review") that can collect
panes from **disparate sessions**. The whole feature is **command-palette
driven** — create / rename / delete / reorder tabs, pin into a tab, move a
focused tile between tabs, unpin, and switch tabs — including while you're
already looking at the Command Center.

Nothing here touches the **non-destructive invariant**: every operation is a
tmux option write or a `config.json` edit. Panes are never moved, broken, or
joined. (See `project_pane_of_glass` — break-pane is permanently off the table.)

## The decisions that drive everything

Resolved up front because the rest of the design hangs off them:

1. **One tab per pane.** A pane lives in exactly one tab. "Move to tab" is an
   overwrite, not a set operation. Tabs read as workspaces/contexts, so a pane
   being in two at once muddies the model, doubles mirror cost for one pane, and
   complicates the per-tab counts. Genuine multi-tab membership is a possible v2
   "duplicate to tab", not the default.

2. **Membership rides on the pane, keyed by a stable tab id.** The existing
   per-pane option `@jmux-pinned` is promoted from the literal `"1"` to hold a
   **tab id** string (`@jmux-pinned="backend"`). Unset = unpinned. tmux stays
   the source of truth for membership; it survives jmux restarts; "move" is one
   `set-option`.

3. **Id, not display name, on the pane.** Renaming a tab must not require
   rewriting every member pane across every session (an N-pane fan-out with a
   drift window). The pane stores an immutable `id`; the human-facing `name`
   lives only in the registry. Rename touches one config entry, zero panes.

4. **The first tab (index 0) is the default.** It absorbs auto-detected agent
   panes, legacy `@jmux-pinned="1"`, and any **unknown id** (a pane pointing at
   a tab that's not in the registry). It is protected: non-deletable and pinned
   at position 0.

## Tab registry: `config.json`

tmux only knows about *panes*, so scanning panes can only ever reconstruct
**non-empty** tabs in an arbitrary order. Two things a pure scan can't
represent — **empty tabs** (you created "review" but haven't pinned into it yet)
and **tab order** ("first tab" is meaningless without one). So the ordered set
of tabs lives in the watched config file (`~/.config/jmux/config.json`), the
same place sidebar width / state colors already live and hot-apply:

```jsonc
"commandCenterTabs": [
  { "id": "default", "name": "Main" },     // index 0 — protected
  { "id": "backend", "name": "Backend" },
  { "id": "review",  "name": "Code Review" }
]
```

- **Array order = strip order.** Index 0 *is* the default tab; no separate
  `isDefault` flag — position defines it. Index 0 is protected: it cannot be
  deleted, and cannot be reordered out of position 0.
- **`id`** is frozen at creation: a slug of the initial name, deduped with a
  numeric suffix on collision (`backend`, `backend-2`). Rename changes only
  `name`. Reorder is array reordering of indices ≥ 1.
- **Seeding:** if `commandCenterTabs` is absent/empty, jmux synthesizes a single
  in-memory default (`{id:"default", name:"Main"}`) and does **not** write it
  back. The file stays clean until the user creates a real second tab — tabs are
  purely additive (untouched installs look exactly like today).
- **Drift is self-healing.** A pane carrying an id not in the registry (legacy
  `"1"`, a hand-edited config, a deleted-out-of-band tab) resolves to the
  default tab on the next reconcile — the same fallback bucket as everything
  else without an explicit home. No pane rewrite needed.

> **Gap — config-watch reload must handle the registry.** The watcher at
> `src/main.ts:~3341` (`configWatcher` → `configStore.reload()`) hot-applies
> sidebar width, claude command, cache timers, pinned sessions, and state colors,
> then resizes/renders. Tabs are written to this same watched file (palette CRUD
> persists here, and the user may hand-edit it), so the reload handler must, on
> every reload: **(1)** re-parse/validate/synthesize the tab registry (seed the
> in-memory default if absent; dedup ids; protect index 0); **(2)** **clamp the
> active and in-memory last-active tab** if a reload removed or reordered them
> (fall back to the default tab); **(3)** **rerun membership resolution**
> (`refreshPinnedPanes()`) so panes whose tab id vanished re-fold to default and
> the strip counts update; **(4)** recompute the shared `stripVisible` predicate
> and **resize + render** if it changed (a hand-edit adding the 2nd tab or
> deleting down to 1 changes glass height). This is the same hot-apply contract
> the other config fields already follow — the registry just has more dependent
> state to reconcile.

## Membership & reconciliation

`refreshPinnedPanes()` (`main.ts:3764`) is extended. Today it reads
`@jmux-pinned` per pane, unions in auto-detected panes, builds an ordered
`GlassTileSpec[]`, and feeds the single flat `GlassView`.

> **Blocker — raw pin values are discarded before resolution.** The current
> path throws the option value away in *three* places, so `@jmux-pinned="backend"`
> is treated as unpinned today; only the literal `"1"` survives. All three must
> change before any tab id can round-trip:
>
> 1. **`src/glass/reflect.ts:6-26`** — `PANE_STATE_FORMAT` does read
>    `#{@jmux-pinned}`, but `parsePaneStateLines` collapses it: `if (pin === "1")
>    pinned.add(paneId)` and `PaneState.pinned` is a `Set<string>` (presence
>    only). Change the parser to **return the raw value per pane** — e.g.
>    `pins: Map<string, string>` (paneId → raw `@jmux-pinned`) replacing/​besides
>    the boolean set. Empty/unset → absent from the map.
> 2. **`src/glass/pinned-pane-tracker.ts:33`** — `apply()` computes
>    `want = rawPinned === "1"` and stores presence in a `Set`. Change it to
>    **store `paneId → rawValue`** (a `Map`), emit on value change (not just
>    presence change), and expose the value. "Is this pane pinned" becomes
>    "has a non-empty value."
> 3. **`src/main.ts:3769`** — `pinnedTracker.apply(paneId, state.pinned.has(...)
>    ? "1" : null)` re-collapses to `"1"`. Pass the **raw value through** from
>    the parser map.

With the raw value preserved, resolution is:

- **Manual pin** = any **non-empty** `@jmux-pinned` value. Resolve it to a tab
  id: `registry.has(value) ? value : DEFAULT_ID`. Legacy `"1"` and any unknown
  id therefore fall to the default tab (Decision 4) — **no pane rewrite**, the
  value is simply interpreted as default at read time.
- **Auto-detected agent panes** carry no option, so they resolve to the default
  tab id. They are still never written to `@jmux-pinned`.
- Each `GlassTileSpec` gains a **`tabId`** field. Ordering within a tab keeps the
  existing deterministic sort (home session name → pane id).

The non-destructive mirror mechanics in `GlassView` (park main client, attach a
`strictAttach` mirror client per tile, transient zoom, restore on teardown) are
unchanged in kind — see *Architecture* for the tab-aware extension.

## Lifecycle — all palette-driven, all persisted

Tab subject for management verbs is the **active tab** (consistent with the
focused-tile subject used for tile verbs).

- **Create:** the pin flow's fused **pick-or-create** picker (see *Pinning*) is
  the creation entry point. A standalone "New Command Center tab…" command also
  exists. Name validation: trim; reject empty/whitespace; soft-cap ~24 chars
  (chips already truncate with `…`); reject **case-insensitive duplicate
  names**. `id` = deduped slug of the accepted name.
- **Rename** ("Rename Command Center tab…"): active tab, registry-only edit.
  Same validation. Zero pane writes.
- **Delete** ("Delete Command Center tab"): **blocked while the tab is
  non-empty** — the palette refuses with a count ("Tab 'Review' has 3 panes —
  move or unpin them first"). The default tab is never deletable. You clear a
  tab (move/unpin its tiles) before it can be removed. Chosen over
  reassign-to-default / unpin-all because it makes destruction explicit and
  never silently relocates or drops a long-running agent.
- **Reorder** ("Move tab left" / "Move tab right"): swaps the active tab with
  its neighbor, clamped so nothing crosses index 0. Only offered when the
  Command Center is active and the active tab is non-default (and the move isn't
  a no-op at the edge). Persisted as array reordering.

## Pinning, moving, unpinning

The palette is **context-aware** — it builds a different command set depending
on `glassActive()` (precedent: today's pin/unpin already toggle on whether the
active pane is pinned, `main.ts:2083`).

**From a session (not in glass)** — subject = current session's active pane:

- **"Pin to Command Center"** opens a **fused pick-or-create** picker: a
  `ListModal` of existing tabs (default first, each showing its pane count,
  e.g. `Backend (2)`), with **"+ New tab…"** as the **last** entry dropping into
  an `InputModal`. One command, pick-or-create in one flow. Pin = write the
  chosen/created tab id to `@jmux-pinned`.

**In the Command Center** — subject = the **focused tile's pane**
(`glassView.focusedPaneId()`; click a tile to focus, then command):

- **"Move tile to tab…"** — tab picker (excludes the current tab, includes
  "+ New tab…"). Move = overwrite `@jmux-pinned` with the target id.
- **"Unpin tile"** — unset `@jmux-pinned`.
- Tab CRUD + reorder + switch (above).
- Tile-targeted commands are **hidden when there are zero tiles** (empty tab /
  empty Command Center), leaving only tab management + switching.
- The session-context "Pin to Command Center" is suppressed in glass (nothing to
  pin — you're already looking at pins).

**Auto-detected panes are special** (they have no stored option):

- **Move** an auto-detected tile → **promote to a manual pin**: write
  `@jmux-pinned=<targetId>`. It becomes a real pin that won't vanish when it
  stops looking like an agent. This is the intuitive result of "put this in
  Backend."
- **Unpin** an auto-detected tile → the command appears as a **disabled, hinted
  row** ("Unpin tile — this pane is auto-pinned; disable auto-pin or it will
  return"). There's no option to unset, and detection would re-add it next
  refresh, so an enabled command would be a lie and fully hiding it gives the
  user nothing to learn from. The disabled row teaches the model and is not
  selectable.

> **Gap — no disabled/info primitive in the palette.** `PaletteCommand`
> (`src/types.ts:92`) is `{ id, label, category, sublist? }` — there is no way
> to render a non-selectable, hinted row. Add two optional fields:
> **`disabled?: boolean`** (renders dimmed, selection is a no-op) and
> **`hint?: string`** (an explanatory suffix/sublabel). This is the minimal honest
> primitive and preserves the Decision-18 UX as designed. The command-palette
> render + selection path (`src/command-palette.ts`) and its tests must respect
> `disabled` (skip on enter, dim on draw). *Alternative if a type change is
> unwanted:* drop the row entirely and surface the explanation via a transient
> `ContentModal` on an attempted unpin — but that's a worse fit (it requires the
> user to try and fail first), so the disabled-row primitive is preferred.

## Rendering & navigation

**Tab strip.** Tabs render in the **top toolbar row, repurposed while in glass**
(the toolbar is already hidden in glass today, `main.ts:1135`; the toolbar is
already a horizontal chip renderer). The sidebar keeps its single Command Center
summary block — tabs do **not** expand into the sidebar.

- **Hidden when only one tab exists.** Single-tab users see today's exact UI:
  no strip, full-height grid. The strip appears the moment a second tab exists.
  Tabs stay purely additive.
- **Chip content:** name + **one summary dot**, colored by the tab's
  most-attention-needed state with priority **waiting → running → complete →
  none** (a tab with any waiting agent shows the waiting color; a tab of only
  plain shells shows no dot). Reuses the configurable state palette
  (`state-colors.ts`) for theme consistency. **No per-state counts** — the dot
  is the signal. The state of each tile is its **home session's**
  `@jmux-agent-state`; the per-tab summary comes from the cheap metadata channel
  and is therefore available for **every** tab, warm or cold.
- Active chip gets focused styling (bold / emerald bg, like the tile labels);
  inactive chips dim. On a narrow terminal, names truncate first, the dot stays.

> **Gap — the strip needs real geometry + click-routing wiring.** "Reuse the
> toolbar row" is not free; today glass assumes the toolbar is gone, in three
> coupled places that must change together:
>
> 1. **`src/main.ts:1135`** renders glass with `null // no toolbar`. When the
>    strip is visible, render a Command-Center tab toolbar in that slot instead
>    (a new toolbar variant; the existing `makeToolbar()` is window-tab-shaped,
>    so this is a distinct render path, not a reuse of its contents).
> 2. **`src/main.ts:3850` `resizeGlass()`** gives glass the **full**
>    `process.stdout.rows`. When the strip is visible, reduce glass height by the
>    strip's row count so tiles don't render under it.
> 3. **`src/input-router.ts:~327`** glass mouse math is `cx = mouse.x -
>    sidebarCols - 1; cy = mouse.y - 1` with the comment "toolbar hidden in
>    glass". When the strip is visible, **offset `cy` by the strip rows**, and
>    **hit-test the strip first** (clicks on a chip switch tabs; clicks below it
>    fall through to tile routing). This is glass-specific toolbar click
>    handling, separate from the existing main-view toolbar click path.
>
> All three gate on the same predicate (strip visible = `glassActive()` **and**
> registry has ≥ 2 tabs, per the single-tab-hide rule), so it must be a single
> shared value, not recomputed independently at each seam.

**Switching tabs:**

- **Click** a tab chip.
- **Palette "Switch to tab…"** — works from anywhere; from a real session it
  enters glass and selects that tab.
- **`Ctrl-a <n>`** jumps to tab N, **scoped to `glassActive()` only**. Outside
  glass, tmux's normal `Ctrl-a <digit>` window-select is untouched. No prev/next
  chord (`Ctrl-a [` is tmux copy-mode and must keep reaching the focused tile;
  click + digits cover it).

> **Blocker — the current prefix intercept leaks `Ctrl-a` to the tile.** At
> `src/input-router.ts:211-219` the `\x01` (Ctrl-a) byte is forwarded to the PTY
> **immediately** (line 216) and only *then* is `prefixSeen` set; the next byte
> is matched against `p`/`n`/`i`/`d` (lines 168-209) and swallowed. So an
> intercepted post-prefix key still leaves the bare prefix already delivered —
> in glass that means the **focused tile receives a stray `\x01`** while the
> digit is swallowed. (The existing glass-`d` detach path has this same leak;
> its tests assert the forward, and it's harmless only because the client is
> being torn down.) For tab digits this is visible corruption.
>
> **Required: a glass-only buffered-prefix path.** When `glassActive()`, do
> **not** forward `\x01` eagerly; buffer it. On the next byte: if it's a tab
> digit `1..9`, send **neither** byte to the tile and switch tabs; for any other
> key, **flush** the buffered `\x01` followed by the key (preserving all existing
> in-tile prefix bindings, including copy-mode `[`). Outside glass, keep today's
> eager-forward behavior unchanged. The existing glass-`d` detach should move
> onto this same buffered path so it stops leaking too. Update the input-router
> tests accordingly (the current glass-detach forward assertion changes).

**Active tab on entry:** the **last-active tab, remembered in-memory** for the
process lifetime; cold-start (fresh jmux launch) lands on the first tab. Not
persisted to disk — keeps the config file pure structure, not ephemeral UI
state. Palette "Switch to tab… X" sets the new last-active.

**Empty active tab** (you unpinned/moved out its last tile): **stay put**, show
the existing "No pinned panes" hint. Auto-switching would yank context out from
under a deliberate action and fight the clear-then-delete workflow. If clearing
drops the **total** to one tab, the strip auto-hides (single-tab rule) and the
remaining tab shows flat.

## Architecture: one GlassView, tabId-tagged tiles

A **single `GlassView`** owns all *warm* tiles keyed by `paneId`, each tagged
with its `tabId`; it lays out and renders only the **active tab's** subset
(active tab is a render filter, not a separate view). Today's `setTiles()`
already reconciles by `paneId` — extend the spec with `tabId` and add an
`activeTabId`; spawn/teardown still key off `paneId` across the whole warm set,
while layout/render/focus iterate only matching tiles.

Consequences:

- **Move is nearly free.** Retag the tile's `tabId` in place (after the
  `@jmux-pinned` rewrite). The mirror client and its `ScreenBridge` survive
  untouched — the tile simply stops being drawn on tab A and starts on tab B. No
  teardown, no zoom churn, no flicker. Moving a tile out of the visible tab makes
  it vanish instantly and the remaining tiles re-flow.

**Mirroring strategy — lazy keep-warm.** A tab's mirror clients spawn the first
time you switch to it, then stay alive for the rest of the glass session
(leaving the Command Center entirely still tears everything down, as today). You
never spawn mirrors for tabs you never open. First visit pays the existing
enter-glass spawn cost; revisits are instant.

- Background (warm but not active) tiles still **consume bytes** to stay current
  but **suppress `scheduleRender`** — nothing visible changed, so they cost
  xterm parsing, not compositing.
- Bounded to "tabs you actually used" within one viewing session.

> **Gap — `setTiles()` spawns everything eagerly today.** The current
> `GlassView.setTiles()` (`src/glass/view.ts:113`) calls `ensureTile()`
> (`view.ts:347`) for **every** incoming spec immediately, and tears down any
> spec not present. That's exactly the eager behavior lazy keep-warm must avoid.
> The contract must split into two inputs:
>
> - **`allTileSpecs`** — full membership across all tabs (id → tabId → label →
>   state), used for layout/ordering/teardown bookkeeping and the strip counts.
> - **the warm set** — panes that have actually been spawned (active tab ∪
>   previously-visited tabs this session).
>
> `setTiles(allTileSpecs, activeTabId)` then: **spawns** only panes in the active
> tab that aren't already warm; **keeps** all warm tiles alive; **tears down**
> only panes that have left `allTileSpecs` entirely (unpinned / process exited) —
> never panes that merely left the active tab. The active-tab render filter
> (drawing only matching `tabId`) is separate from the warm/spawn lifecycle.

**The one genuine risk** to call out for the plan: the same-window zoom
collision (the wound that originally pushed toward `break-pane`). Each mirror is
a real tmux client that does `select-window` + transient `resize-pane -Z`; zoom
is **window-global**, so two warm tiles whose panes share one window can't both
zoom. Keep-warm widens this slightly (more simultaneous live mirrors), but only
across visited tabs and only for panes sharing a window — the typical agent case
(one agent pane per session) never hits it. **Add a regression test** around the
multi-tile-same-window case.

## Component boundaries & testable seams

Pure unit-testable logic (matching `src/__tests__/*` — no spawned tmux):

- **Tab registry** — parse/validate `commandCenterTabs`; seeding the in-memory
  default; id slug generation + dedup; rename/delete/reorder transforms (delete
  blocked when non-empty; default protected at index 0); name validation
  (trim/empty/length/case-insensitive dup).
- **Raw pin propagation** — `parsePaneStateLines` returns raw `@jmux-pinned`
  values (not a collapsed `"1"` set); `PinnedPaneTracker` stores paneId → raw
  value and emits on value change; round-trip from parser → tracker → resolution.
- **Membership resolution** — pane `@jmux-pinned` id → tab id with
  registry-miss / legacy-`"1"` / auto-detected all folding to the default id;
  any-non-empty-value = manual pin; per-tab grouping + deterministic intra-tab
  ordering.
- **Per-tab summary dot** — given each tile's home-session agent state, the
  waiting→running→complete→none reduction per tab.
- **Palette command set** — context-aware build (in-glass vs session): which
  verbs appear, focused-tile vs active-pane subject, zero-tile hiding,
  auto-pane move-promotes / unpin-as-disabled-hinted-row.
- **GlassView lazy keep-warm + active-tab filter** —
  `setTiles(allTileSpecs, activeTabId)` spawns active-tab-∪-warm only, tears down
  only panes gone from all specs, renders only matching `tabId`; move = retag
  without teardown; warm-set lifecycle keyed by paneId.
- **Tab-switch keybinding (buffered glass prefix)** — glass-only buffered `\x01`:
  digit `1..9` swallows both bytes and switches; any other key flushes `\x01` +
  key (copy-mode `[` etc. preserved); out-of-glass eager-forward unchanged; the
  glass-`d` detach moved onto the same path (its existing forward-assertion test
  changes).
- **Disabled palette row** — `PaletteCommand.disabled`/`hint` rendering + a
  no-op-on-enter selection path; auto-pane unpin renders as a disabled hinted row.
- **ctl parser/dispatch** — `tab` in `VALUE_FLAGS` (value capture); `cc` group +
  `tabs` action routing; `pane pin --tab <id|name>` resolution; `cc.ts` JSON
  output; shared registry parse/resolve module.
- **Strip render plan** — single-tab hide (shared `stripVisible` predicate);
  chip name + summary dot; active vs inactive styling; narrow-terminal truncation
  keeps the dot; reduced glass height + glass mouse `cy` offset + chip hit-test.

Integration-level behavior (mirror client spawn/teardown, multi-client zoom,
lazy keep-warm across tab switches) is exercised by running jmux, consistent
with the project's "tests don't spawn tmux" rule — except the same-window-zoom
regression noted above.

## Agent surface (CLI)

The `pane` ctl group already exposes pin/unpin/pinned writing `@jmux-pinned`.
Extend it tab-aware (no IPC to the TUI — option writes only):

- `jmux ctl pane pin --target %ID --tab <id|name>` — write the tab id (resolve a
  passed name to id via the registry; default tab when omitted).
- `jmux ctl pane unpin --target %ID` — unchanged (unset).
- `jmux ctl pane pinned` — include each pane's tab id in the JSON.
- `jmux ctl cc tabs` (new) — list the registry (id, name, order, count) so
  agents can discover tab ids. CRUD on tabs stays TUI/config-only for v1.

> **Blocker — the parser/dispatch don't support any of this yet.** Verified
> against `src/cli.ts`:
>
> 1. **`--tab` parses as a boolean.** The arg parser only treats flags in
>    `VALUE_FLAGS` as value-taking; everything else is "Unknown flag — treat as
>    boolean (permissive)" (`src/cli.ts:180`). `--tab backend` would set
>    `flags.tab = true` and leave `backend` as a stray positional. **Add `tab`
>    to `VALUE_FLAGS`.**
> 2. **`cc` is not a known group.** `KNOWN_GROUPS` (`src/cli.ts:17`) lacks `cc`,
>    and the dispatch `switch (parsed.group)` (`src/cli.ts:~218`) has no `cc`
>    case. **Add `cc` to `KNOWN_GROUPS`, a `handleCc` dispatch case, and a new
>    `src/cli/cc.ts` handler** (mirroring `src/cli/pane.ts`). Decide whether `cc`
>    is a `STANDALONE_GROUP` or takes an action (`cc tabs` → action `tabs`).
> 3. **Reading the registry from the CLI** — `cc tabs` and `pane pin --tab <name>`
>    resolution both need the tab registry, which lives in `config.json`. The CLI
>    already resolves context; the handler reads the config file directly (no
>    IPC). Pure registry parse/resolve logic should be a shared module unit-tested
>    independently of the CLI.
>
> Parser tests in `src/__tests__/cli/*` must cover `--tab` value capture and the
> `cc` group/action routing.

## Doc impact

- **CONTEXT.md** glossary: *Command Center* gains tabs; new terms *Tab*
  (registry-backed named bucket, id-keyed) and *Default tab* (protected index
  0, fallback bucket). *Pin* updated: `@jmux-pinned` holds a tab id, not `"1"`.
- **ADR** (new): tab membership = stable id on the pane + name in the config
  registry; the rename-fan-out avoidance rationale.
- Config docs: `commandCenterTabs` schema, additive/seeding behavior.

## Deliberately out of scope (v1)

- Multi-tab membership / "duplicate to tab".
- Persisting last-active tab across restarts.
- Sidebar tab expansion (top strip only).
- Per-state numeric counts on chips (summary dot only).
- Tab CRUD over the ctl CLI (read-only `cc tabs` only).
- A tombstone/suppress mechanism for unpinning auto-detected panes (unpin shows
  as a disabled hinted row instead).
