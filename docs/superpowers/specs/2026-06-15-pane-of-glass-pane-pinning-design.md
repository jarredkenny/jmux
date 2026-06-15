# Pane of glass — pane-level pinning

> **REVISED 2026-06-15 (mid-build): pinning is NON-DESTRUCTIVE.** The sections
> below describing `break-pane` checkout into a `__jmux_glass` holding session,
> home-restore records, and the reconciler/executor are **superseded**. The pane
> is **never moved** — the Overview renders a *live mirror* of each pinned pane
> (a client attached to the pane's own session, shown full-bleed via a transient
> zoom that's restored on exit). The pin model (per-pane `@jmux-pinned`, tracker,
> CLI, palette, sidebar Overview, layout, labels) is unchanged. Full rewrite of
> this doc + ADR 0001/0002 pending. See `project_pane_of_glass` memory.

**Status:** design approved, ready for planning
**Date:** 2026-06-15
**Supersedes the pane-of-glass parts of:** `docs/adr/0001-pane-of-glass-live-composited-clients.md`, `docs/adr/0002-pin-state-in-tmux-option.md`, and the CONTEXT.md glossary entries for *Pin*, *Tile*, and *Agent pane*.

## Summary

The pane of glass is a single Overview view that renders **all pinned panes at
once**, each live and interactive, so the user can watch and *drive* several
parallel things — coding agents, test runs, dev servers — without switching
between sessions one at a time.

The unit of pinning is a **pane**, not a session. This is the central change
from the earlier design. Pinning a specific pane (the Claude pane, a test-output
pane, a dev-server pane) is more useful than pinning a whole session, and it
removes the need to *guess* which pane of a session a tile should show.

## Why pane-level (the decision that drives everything)

The earlier design pinned **sessions** and rendered each tile by zooming an
auto-detected "agent pane" (`@jmux-agent-pane`, recorded by hooks, with a
dead-pane fallback). Two problems:

1. It could only ever show one thing per session — the agent — and required
   machinery to detect which pane that was.
2. Zoom (`resize-pane -Z`) is a **window-global** flag, so the design carried a
   zoom save/restore dance and a "mutually-exclusive viewing rule" to stop two
   views of one session fighting over zoom.

Pinning panes explicitly fixes both:

- The user names the pane, so there is nothing to auto-detect — the entire
  `@jmux-agent-pane` capability is dropped.
- One session can contribute several tiles (Claude + tests + dev server).

The cost the user has explicitly accepted: rendering an arbitrary single pane
full-bleed requires **isolating** it, and the chosen isolation mechanism
(`break-pane`) is destructive to the pane's home window while it is pinned. See
*Rendering model* for how this is made coherent and recoverable.

## Rendering model: one hidden holding session + session-group clients

tmux has no native "show only this one pane, live and interactive." A client
attaches to a *session* and renders that session's current *window* with its
full pane layout; the only way to make a single pane fill a client is to isolate
it into a window of its own.

The model:

- A single hidden session **`__jmux_glass`** is the holding area ("glass-land").
- **Checking a pane out** (the reconciler's response to a new desired pin — see
  *Pin state*) `break-pane`s it into its own window inside `__jmux_glass`. That
  holding window then contains exactly one pane, so a client attached to it shows
  the pane full-bleed **with no zoom**. The reconciler records the pane's home —
  source session id, source window id, and the source window's `window_layout`
  string — for exact geometry restoration on unpin.
- **Each tile** is a pty running `tmux new-session -t __jmux_glass` — a
  *session-group member*. Group members share the window list but each gets its
  **own current-window and own size**. Each tile client `select-window`s its
  pane's holding window and is sized (manual `window-size`, driven via the tile
  pty dimensions) to its tile rectangle. N tiles = N group members on one
  holding session.
- **Unpin / glass teardown** `join-pane`s the pane back to its home window and
  re-applies the saved `window_layout`.

Three consequences, all strictly better than the zoom design:

1. **Mutual exclusivity is physical, not policed.** A pinned pane literally
   lives in `__jmux_glass`, so it cannot also be in its home window. The "tile
   XOR full-screen" invariant enforces itself — no zoom fight, no save/restore.
2. **Promote-to-fullscreen** (`Ctrl-a z` on a tile, or clicking the pane's
   sidebar entry) attaches the main client to `__jmux_glass` focused on that one
   holding window. The pane stays checked-out the whole time; only **unpin**
   sends it home. Mental model: *pinned = checked out into the dashboard; unpin =
   returned home.*
3. **Crash recovery is mostly free.** The holding session lives in the tmux
   server, so it survives a jmux crash; the break-records live in `config.json`
   (durable). On restart jmux re-adopts `__jmux_glass`. If the tmux *server*
   died, the processes are gone anyway, so there is nothing to restore.

The main interactive PTY client parks on a hidden scratch session
(**`__jmux_park`**) while the glass is up (so it constrains no real session's
size); the tile group-member clients are what jmux composites. Promote reuses a
client attached to the holding session.

### Internal sessions must be hidden everywhere

This model creates three classes of jmux-internal tmux session that must **never**
appear to the user or to agents: the holding session `__jmux_glass`, the parking
session `__jmux_park`, and one group-member session per tile
(`__jmux_tile_<paneId>`). All share the reserved **`__jmux_`** name prefix.

There is currently no internal-session concept in the codebase, and
`list-sessions` is consumed at many independent seams that would each surface
these sessions. **The plan must enumerate them from the source of truth — `rg
"list-sessions" src --glob '!src/__tests__/**'` — not from a fixed count**, since
the set drifts. As of writing that includes (non-exhaustive): `src/main.ts`
`fetchSessions` (sidebar) and `fetchAgentState`; `src/snapshot/capture.ts`
`onSessionsChanged` and `scrollbackTick`; `src/snapshot/restore.ts`; and the ctl
readers in `src/cli/session.ts` (several call sites, including the last-session
guard), `src/cli/agent.ts`, `src/cli/issue.ts`, `src/cli/status.ts`. Some already
filter to a specific session name and so won't surface internal sessions, but the
plan must audit each rather than assume.

**Contract:** a single shared predicate `isInternalSession(name)` (name starts
with `__jmux_`) is the one source of truth, applied at every relevant seam. Where
the query is a `list-sessions` call we additionally pass a tmux-level filter so
internal sessions are excluded at the source:

```
-f '#{?#{m:__jmux_*,#{session_name}},0,1}'
```

`-f` keeps rows whose format evaluates to a non-zero, non-empty value; the
conditional yields `0` for a name matching `__jmux_*` (skipped) and `1`
otherwise (kept). This form uses only operators documented in the tmux 3.6a
manual — there is **no** `#{!:}` logical-NOT operator, so do not use one. The TS
predicate is the belt-and-suspenders backstop for any reader that post-filters
rather than passing `-f`. The reserved prefix is also rejected by
`sanitizeTmuxSessionName` so a user cannot create a colliding session.

### Accepted cost

While a pane is pinned, its home window is genuinely missing that pane — it has
been checked out. The "checkout" framing makes this predictable, and the
sidebar `(N pinned)` marker on the source session explains it. This is
documented behavior, not a bug.

## Pin state: desired membership vs physical checkout

Two distinct pieces of state, deliberately separated. Conflating them is what
makes crash recovery fragile.

1. **Desired membership** — per-pane tmux user option **`@jmux-pinned`**, the
   declarative "this pane should be in the glass" signal. Same pattern as
   `@jmux-agent-state`, re-scoped from session to pane.
2. **Physical checkout** — the pane actually `break-pane`d into `__jmux_glass`,
   plus its home-restore record. This is the *effect* of a desired pin.

**Writers only touch desired state.** Both the TUI's own pin/unpin actions and
the CLI do nothing more than set/unset `@jmux-pinned`
(`set-option -p -t %ID @jmux-pinned 1` / unset). They never break/join panes.

**The TUI reconciler owns the physical state.** It reflects `@jmux-pinned`
changes via the control channel and drives the side effects: a pane that is
*desired-pinned but not yet checked out* gets broken into the holding session and
a home record written; a pane that is *checked out but no longer desired-pinned*
gets joined home and its record cleared. This single reconcile loop is also what
runs on startup, so crash recovery and steady-state use the exact same path — an
agent setting the option, a user clicking pin, and a restart all converge through
it. The reconciler mirrors home records to `config.json` for durability.

Because the CLI only writes an option and the TUI owns all break/join, there is
no IPC and the two can never diverge. This preserves ADR 0002's boundary:
**agents control glass *membership* (the option), never the user's *view*.**

**Durability scope:** pins are **tmux-server-lifetime**. A server restart kills
the pinned processes, so the config mirror only needs to cover
jmux-restart-while-the-server-is-alive. On restart the reconciler re-adopts the
surviving `__jmux_glass` holding windows against the persisted home records,
dropping any record whose pane no longer exists.

## Sidebar

The **Overview entry** sits at the top of the sidebar — a permanent synthetic
view selector, not a session. It expands to list the pinned panes themselves:

```
◉ Overview (3)
   │ api   › claude
   │ api   › npm test
   │ web   › vite dev
── sessions ──
  api   • (1 pinned)
  web   • (1 pinned)
  docs
```

- Selecting **Overview** enters the glass (all tiles).
- Selecting a **pinned-pane entry** promotes that one pane full-screen.
- Selecting a **session** leaves the glass and shows that session full-screen,
  as today.
- A session with a checked-out pane shows a `(N pinned)` marker, which doubles
  as the explanation for why a pane is missing from it.
- Pane label: `<session> › <pane label>`, where pane label is
  `pane_title || "${pane_current_command} · ${basename(pane_current_path)}"`.
  Including the cwd basename disambiguates the common case of two `node`/`bun`
  panes in one session.

The sidebar's active selection is therefore one of: a session id, a pinned-pane
id, or the Overview sentinel.

**Empty state:** with zero pinned panes the Overview entry is still present;
selecting it shows a "Pin panes to populate the glass" placeholder.

## Lifecycle

Ordering is chosen so that a crash at any step leaves enough information to
recover, never a pane stranded in glass-land without a way home.

**Home-restore record** (ID-based — tmux IDs stay valid for the server lifetime
even as names change):

```
{ paneId, homeSessionId, homeWindowId, homeLayout,
  displaySessionName?, displayWindowName? }   // names are for UI only
```

- **Pin** (reconciler, on observing a newly desired-pinned pane):
  1. Capture and **persist the home record** (`homeSessionId`, `homeWindowId`,
     `homeLayout`) to config *first*.
  2. Then `break-pane` the pane into `__jmux_glass`.
  3. Re-tile.

  Crash between (1) and (2): on restart the reconciler sees the pane still
  desired-pinned (`@jmux-pinned` set) but not yet in holding, so it **retries the
  checkout**, reusing or refreshing the persisted record. The record is discarded
  only when the desired pin is gone *or* the pane no longer exists — never merely
  because the pane is currently still home. Crash after (2): the record points
  home, so unpin/restore still works.

- **Unpin** (reconciler, on observing `@jmux-pinned` cleared):
  1. `join-pane` the pane back to `homeWindowId` and re-apply `homeLayout`.
  2. Only **after** the join+layout restore succeeds, drop the home record from
     config and re-tile.

  Keeping the record until restoration completes means a crash mid-unpin still
  finds the record on next startup and retries the join.

  - Home **window** gone but home **session** (`homeSessionId`) alive → rejoin as
    a new window.
  - Home **session** gone → promote the holding window into its own new
    user-visible session (**never kill the process**).

- **Pinned process exits** (test run finishes, dev server crashes): the pane is
  gone, so the reconciler clears the desired pin, discards the home record, and
  drops the tile. The glass shows only live panes.

## Navigation

The glass is navigated as if the tiles were tmux panes:

- **Click a tile** → it gets focus (input-router hit-tests tile rectangles).
- **`Shift+arrows`** move focus between tiles directionally; jmux intercepts
  these while the glass is up (outside the glass they pass through to tmux as
  normal pane navigation).
- **Keystrokes and mouse wheel** route to the focused tile's client, driving
  that pane for real. `Ctrl-a` still reaches the focused tile.
- **`Ctrl-a z`** promotes the focused tile to full-screen; clicking the pane's
  sidebar entry does the same. **`Enter`** always passes through to the focused
  pane, never promotes.

## Tile chrome

A tile must look and behave like a native tmux pane:

- jmux draws the border box per tile, styled to match `pane-border-*` in
  `config/defaults.conf`.
- The pane label sits in the top-left of the border (mirroring
  `pane-border-status top` / `pane-border-format`).
- The focused tile gets an active-border highlight.
- Each tile scrolls independently (each is its own attached client over its own
  holding window, so scrollback / copy-mode is naturally per-tile).

## Layout

Tiles are arranged in `columns = floor(mainWidth / minTileWidth)` columns
(`minTileWidth` configurable, ≈ 80 to keep agent TUIs legible), rows added as
needed. A narrow terminal degenerates to a single full-width column; an
ultrawide terminal uses 2–3. Tiles never shrink below the width floor; when
pinned panes overflow the screen the glass scrolls and the focused tile is kept
in view.

## Performance (P2)

Only **visible** tiles parse — each tile's `ScreenBridge` feeds its xterm.js only
while the tile is on-screen. Off-screen tiles (when pins overflow and the glass
scrolls) are paused, so CPU scales with visible tile count, not total pins.
Resuming into the glass on restart is therefore not a spawn-storm.

## Toolbar

While the glass is up the toolbar is hidden (tiles take full height; each tile's
border already carries its label). Promoting a tile restores the toolbar for
that pane's view.

## View persistence

The selected view (a session id, a pinned-pane id, or the Overview sentinel)
persists across restarts: quitting while in the glass re-enters the glass on
next launch. On restore jmux reconciles — pinned panes that no longer exist are
skipped (P2 means only visible tiles begin parsing).

## Agent surface (CLI)

Agents pin/unpin via the existing `pane` ctl group, talking only to tmux (no IPC
to the TUI):

- `jmux ctl pane pin --target %ID`
- `jmux ctl pane unpin --target %ID`
- `jmux ctl pane pinned` (list)

## Component boundaries & testable seams

Pure unit-testable logic (matching the existing `src/__tests__/*` style — no
spawned tmux):

- **`isInternalSession(name)` predicate** — `__jmux_` prefix detection; applied
  at every list-sessions seam (enumerated via `rg`, not a fixed count);
  `sanitizeTmuxSessionName` rejects the prefix.
- **Pin option parsing/reflection** — control-channel `@jmux-pinned` events →
  desired-membership set updates; config mirroring round-trip.
- **Reconciler** — given (desired-pinned set, checked-out set + home records,
  live panes), compute the break/join/discard actions. This is the crash-recovery
  and steady-state core; pure function over state, so directly unit-testable.
- **`jmux ctl pane pin/unpin/pinned`** — command construction (option set/unset
  only, no break/join) and JSON output.
- **Layout column math** — `floor(mainWidth / minTileWidth)`, row packing,
  overflow/scroll, focused-tile-kept-in-view.
- **Home-restore records** — ID-based record shape; the three unpin resolution
  branches (window gone / session gone / both present).
- **Sidebar render plan** — Overview entry with nested pinned-pane children,
  `(N pinned)` markers, empty state, selection model (session id | pane id |
  Overview sentinel).
- **Input routing** — tile hit-testing, `Shift+arrows` intercept gating on
  glass-up, focused-tile keystroke routing.

Integration-level behavior (break/join, session groups, multi-client
compositing) is exercised by running jmux, not by unit tests — consistent with
the project's "tests don't spawn tmux" rule.

## Doc impact

- **ADR 0001** revised: rendering is break-pane isolation into a holding
  session, not zoom of an agent pane. The zoom-conflict / mutually-exclusive
  rationale is replaced by "isolation makes exclusivity physical."
- **ADR 0002** revised: `@jmux-pinned` is a **per-pane** option, not per-session.
- **CONTEXT.md** glossary: rewrite *Pin* (pane-scoped), *Tile* (holding-window
  client, no zoom); drop *Agent pane* as a pinning concept; update *Overview
  entry* for nested pinned panes.
