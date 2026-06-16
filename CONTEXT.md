# jmux — Domain Context

This file captures the domain language of jmux: the terms that are meaningful
when reasoning about the product, independent of implementation detail. Keep it
honest and current — when a term's meaning sharpens during design, update it here.

## Glossary

### Pin / Pinned pane

A **pane** the user (or an agent) has marked for the Command Center. A pin is
**pane-scoped and non-destructive**: it adds the pane as a live tile in the
Command Center without ever moving the pane out of its own session / window /
layout. To remove a pane from the Command Center, you unpin it.

**Source of truth.** Pin state lives in a **per-pane** tmux user option
`@jmux-pinned`, and that option is the *sole* source of truth. The TUI reflects
it via a per-pane `#{P:...}` control-channel subscription (the same family of
mechanism as `@jmux-agent-state`). Pins are deliberately **tmux-server-lifetime**
— the option is re-read on TUI restart, and a server restart that would clear it
also kills the agent processes the pins pointed at, so there is nothing to
restore. There is **no** config-file mirror. The TUI's own pin/unpin actions and
the CLI both write the *same* option, so they can never diverge.

**Agent surface.** Agents pin/unpin via the CLI:
`jmux ctl pane pin` / `unpin` / `pinned` (list). The TUI exposes the same via
command-palette actions "Pin to Command Center" / "Unpin from Command Center"
(operating on the active pane). This rides the CLI's existing "talk only to tmux"
model — no IPC to the TUI is required. The boundary is deliberate: **agents
control Command Center *membership* (pins), never the user's *view*.** Pinning a
pane makes it appear as a tile; it does not force the user's screen into the
glass. Choosing to look at the Command Center is always the human's sidebar
selection.

### Command Center

A single view that renders *all currently pinned panes at once*, so the user can
watch and **drive** several parallel agents without switching between them one at
a time. Contrast with the default single-session view, where exactly one session
occupies the main area and the user toggles between sessions via the sidebar or
hotkeys.

Every tile is fully **live and interactive** (not a snapshot): each is a real
attached tmux client, so keystrokes routed to the focused tile drive that pane
for real. (This is the deliberately harder of the two possible designs; a
read-only polling dashboard was rejected — driving the agents is the point.)

### Command Center entry

A permanent, synthetic entry at the **very top of the sidebar** — always present.
It is *not* a session; it is a view selector. Selecting it enters the Command
Center. Selecting any real session leaves the glass and shows that session
full-screen. This makes the sidebar's "active selection" no longer always a
session id: it is either a session id **or** the Command Center sentinel.

The entry's sidebar block shows **counts only — never a per-pane list**:

- A bold header `⌘ Command Center · N` where `N` is the number of pinned/surfaced
  panes.
- A colored **agent-state breakdown** line — `n RUN / n WAIT / n DONE` — using
  the sidebar agent-state palette (running = green, waiting = yellow,
  complete = blue).

While the Command Center is selected the entry gets the active-selection chrome
(the `ACTIVE_BG` highlight and the `▎` marker), exactly like a selected session.

### Tile

One cell of the Command Center. A tile is a **live mirror** of one pinned pane: a
second real tmux client attached directly to that pane's **own session**
(`TmuxPty` strictAttach → `tmux attach-session`), with its own xterm.js
`ScreenBridge`. The pane is shown full-bleed via a **transient zoom**
(`resize-pane -Z`) applied only while in the Command Center and only when the
pane's window has sibling panes; the zoom is restored on teardown. Teardown only
**detaches** the client — it never runs `new-session` or `kill-session` — which
is what keeps tiles non-destructive.

**A tile must look and behave like a native tmux pane.** Specifically:

- **jmux draws the tile chrome itself** (tmux cannot, because the tiles span
  separate sessions): a border box per tile.
- **A label chip top-left** showing `session › pane-title` (or
  `command · cwd-basename`), styled like the toolbar tabs.
- **The border color encodes the pane's agent state** — running = green,
  waiting = yellow, complete = blue (matching the sidebar palette); a pane with
  no agent state uses bright-white. **Focus is shown via weight**: the focused
  tile's border is **bold**, unfocused tiles are **dim** (bright-white panes use
  bright-white focused / gray unfocused).
- **Each tile scrolls independently.** Because every tile is its own attached
  tmux client, scrollback / copy-mode is naturally per-tile — wheeling over one
  tile scrolls only that tile.

**Deterministic order.** Tiles are ordered by **session name, then pane id**, so
the grid stays stable across detach/reattach and refreshes.

### Tile focus & navigation

The Command Center is navigated as if the tiles were tmux panes:

- **Click a tile → it gets focus** (input-router hit-tests tile rectangles).
- **`Shift+arrows` move focus between tiles**, directionally. jmux *intercepts*
  these while the glass is up.
- **Keystrokes route to the focused tile's client**, driving that agent for real.
- **Mouse events (wheel + press / drag / release) forward to the tile under the
  cursor**, so scrollback and tmux copy-mode text selection work per-tile.

### Layout (width-floored columns)

Tiles are arranged in `columns = floor(mainWidth / minTileWidth)` columns
(`minTileWidth` ≈ 80 to keep agent TUIs legible), clamped to the tile count, with
rows added as needed. A narrow terminal degenerates to a single full-width column
(vertical stack); an ultrawide terminal uses 2–3 columns. Tiles never shrink
below the width floor; when tiles overflow the screen, **the grid scrolls
vertically** and the focused tile is kept in view. Only **visible** tiles parse
(P2) — off-screen tiles are paused.

### Auto-pin agent panes

An optional setting, "Auto-pin agent panes to Command Center". When enabled, the
grid auto-surfaces every detected agent pane without a manual pin:

- the **active pane of any session that has `@jmux-agent-state` set** (catches
  Claude), plus
- panes whose `pane_current_command` matches a configurable, case-insensitive
  regex (default `codex`) (catches Codex).

Auto-detected panes are **unioned with manual pins on each refresh** and are
**never written to `@jmux-pinned`**, so the option stays a clean record of
explicit pins. Auto-pin is a convenience layer on top of the core model, which is
that users pin panes explicitly.

### Agent state

Per-pane agent state (`@jmux-agent-state`: running / waiting / complete, set by
the agent hooks) is not a *pinning* mechanism, but it drives three things in the
Command Center: the **breakdown line** on the Command Center entry, each **tile's
border color**, and **auto-detection** of agent panes when auto-pin is enabled.

### Mutually-exclusive viewing rule

A pane's session is shown **either** in the Command Center **or** full-screen in
the single-session view — never both at once. This is enforced structurally by
the singular sidebar selection (Command Center sentinel **xor** session id) and
by **parking**: while the glass is up the real (main) client is parked on a
hidden `__jmux_park` session, so the tile clients' window sizes don't constrain
the real sessions. On exit the main client is restored. There is no state in
which both views are live.
