# jmux — Domain Context

This file captures the domain language of jmux: the terms that are meaningful
when reasoning about the product, independent of implementation detail. Keep it
honest and current — when a term's meaning sharpens during design, update it here.

## Glossary

### Pin / Pinned session

A session the user has marked as important. A pin has two effects:

1. **Sidebar ordering** — the session floats to the dedicated pinned section at
   the top of the sidebar.
2. **Pane-of-glass membership** — the session appears as a live tile in the
   pane-of-glass view (see below).

These are two effects of *one* concept, not two separate concepts. The set of
pinned sessions is the single source of truth for both. To remove a session
from the pane of glass, you unpin it.

**Source of truth.** Pin state lives at runtime in a per-session tmux user
option `@jmux-pinned`, reflected into the TUI via the control channel (the same
mechanism as `@jmux-agent-state`) and mirrored to `~/.config/jmux/config.json`
for durability across tmux-server restarts. The TUI's own pin/unpin actions and
the CLI both write the *same* option, so they can never diverge. On startup the
TUI re-applies the config-saved pins onto matching live sessions.

**Agent surface.** Agents pin/unpin via the CLI:
`jmux ctl session pin --target NAME` / `unpin` / `pinned` (list). This rides the
CLI's existing "talk only to tmux" model — no IPC to the TUI is required. The
boundary is deliberate: **agents control glass *membership* (pins), never the
user's *view*.** Pinning a session makes it appear as a tile; it does not force
the user's screen into the glass. Choosing to look at the glass is always the
human's sidebar selection.

### Pane of glass

A single view that renders *all currently pinned sessions at once*, so the user
can watch and **drive** several parallel agents without switching between them
one at a time. Contrast with the default single-session view, where exactly one
session occupies the main area and the user toggles between sessions via the
sidebar or hotkeys.

Every tile is fully **live and interactive** (not a snapshot): each is a real
attached tmux client, so keystrokes routed to the focused tile drive that
session for real. (This is the deliberately harder of the two possible designs;
a read-only polling dashboard was rejected — driving the agents is the point.)

### Tile

One cell of the pane of glass. A tile corresponds 1:1 to a pinned session and
renders that session's **agent pane** — the pane running Claude / Codex / the
coding agent — zoomed to fill the tile (`resize-pane -Z`), so the tile shows the
agent full-bleed rather than wasting space on sibling panes (e.g. a parked
worktree shell). If a pinned session has no known agent pane, the tile falls
back to the session's active window as tmux lays it out.

**A tile must look and behave like a native tmux pane.** Specifically:

- **jmux draws the tile chrome itself** (tmux cannot, because the tiles are
  separate sessions): a border box per tile, styled to match the existing
  `pane-border-*` settings in `config/defaults.conf`.
- **Session name in the top-left of the border**, mirroring tmux's
  `pane-border-status top` / `pane-border-format` convention.
- **The focused tile gets an active-border highlight** (matching tmux's
  active-pane border styling) so focus is always visible.
- **Each tile scrolls independently.** Because every tile is its own attached
  tmux client over its own session, scrollback / copy-mode is naturally
  per-tile — wheeling over one tile scrolls only that tile.

### Tile focus & navigation

The glass is navigated exactly as if the tiles were tmux panes:

- **Click a tile → it gets focus** (input-router hit-tests tile rectangles).
- **`Shift+arrows` move focus between tiles**, directionally, mirroring the
  existing `bind -n S-Left/Right/Up/Down -> select-pane -L/-R/-U/-D` in
  `config/defaults.conf`. jmux *intercepts* these while the glass is up (the
  focused tile's zoomed single pane would no-op them anyway); outside the glass
  they pass through to tmux as normal pane navigation. Same key, context meaning.
- **Keystrokes (and mouse wheel) route to the focused tile's client**, driving
  that agent's session for real. `Ctrl-a` still reaches the focused tile, so its
  session's own tmux commands keep working.
- **`Ctrl-a z` promotes the focused tile to full-screen** (the zoom mnemonic — a
  tile *is* a zoomed pane, so this "un-tiles" it into the single-session view).
  Clicking the session in the sidebar does the same. `Enter` always passes
  through to the focused agent, never promotes.

### Layout (width-floored columns)

Tiles are arranged in `columns = floor(mainWidth / minTileWidth)` columns
(`minTileWidth` configurable, ≈ 80 to keep agent TUIs legible), rows added as
needed. A narrow terminal degenerates to a single full-width column (vertical
stack); an ultrawide terminal uses 2–3 columns. Tiles never shrink below the
width floor; when pinned sessions overflow the screen, **the glass scrolls** and
the focused tile is kept in view — tiles are never crammed smaller.

### Agent pane

The specific pane within a session that is running the coding agent. jmux must
*track which pane this is* to render and target it — historically jmux tracked
agent state only at the **session** level (`@jmux-agent-state`), so identifying
the pane is a new capability the pane-of-glass work introduces (the agent hooks
run inside the agent's pane and can record `$TMUX_PANE`).

### Overview entry

A permanent, synthetic entry pinned to the **top of the sidebar** — always
present, even with zero pinned sessions (it shows an empty state then). It is
*not* a session; it is a view selector. Selecting it enters the pane-of-glass
view. Selecting any real session leaves the glass and shows that session
full-screen, exactly as today. The Overview entry sits above the pinned section;
the two are complementary — the pinned section jumps you to *one* pinned
session, the Overview entry shows them *all together*.

This makes the sidebar's "active selection" no longer always a session id: it is
either a session id **or** the Overview sentinel.

While the glass is up the **toolbar is hidden** (tiles take the full height; each
tile's border already carries its session name, so the toolbar would be
redundant chrome). Promoting a tile to full-screen restores the toolbar for that
session.

**Empty state.** With zero pinned sessions the Overview entry is still present;
selecting it shows a "Pin sessions to populate the glass" placeholder rather
than vanishing.

**View persistence.** The selected view (a session, or the Overview sentinel)
persists across restarts: quitting while in the glass re-enters the glass on next
launch. On restore jmux *reconciles* — pinned sessions that no longer exist are
skipped, so a stale pin never produces a broken tile (and P2 means only visible
tiles begin parsing, so resuming into the glass is not a spawn-storm).

### Mutually-exclusive viewing rule

A session is shown **either** as a glass tile **or** full-screen in the
single-session view — never both at once (a tile zooms the agent pane, and tmux
zoom is window-global, so two simultaneous views would fight over zoom and
client size). This rule is *enforced structurally* by the singular sidebar
selection: when the Overview entry is selected the glass is up and nothing is
full-screen; when a session is selected the glass is not rendered. There is no
state in which both are live.
