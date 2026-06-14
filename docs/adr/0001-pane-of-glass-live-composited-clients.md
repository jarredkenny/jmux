# Pane of glass renders live composited tmux clients, not a polling dashboard

## Status

accepted

## Context & decision

The pane of glass shows all pinned sessions at once so the user can watch *and
drive* several parallel coding agents. We had two fundamentally different ways to
get multiple sessions' content onto one screen:

- **(A) Polling dashboard** — periodically `capture-pane` each pinned session and
  render read-only tiles, dropping into a session to interact.
- **(B) Live multiplexer** — one real attached tmux client per tile (each its own
  `ScreenBridge`), composited by jmux like a tiling window manager, every tile
  fully live and typeable.

We chose **(B)**. Driving the agents from the single pane of glass — not just
watching them — is the entire point; a read-only dashboard fails the core use
case. Each tile renders that session's **agent pane** (the pane running
Claude/Codex), zoomed full-bleed via `resize-pane -Z`, with jmux drawing
tmux-style border chrome (session name top-left, active-border highlight) since
tmux cannot itself show panes from different sessions in one window.

## Consequences

- jmux now runs **N attached tmux clients + N xterm.js bridges** instead of one.
  CPU scales with tile count, so we cap it: only **visible** tiles parse (P2);
  off-screen tiles (when pins overflow and the glass scrolls) are paused.
- Because a tile *zooms* the agent pane and tmux zoom is window-global, a session
  is shown **either** as a tile **or** full-screen, never both at once. This
  **mutually-exclusive viewing rule** is enforced structurally by the singular
  sidebar selection (Overview entry vs. a session), so nothing has to police it.
- Tile clients are spawned **on-demand** when the glass is entered and torn down
  on exit (warm-keeping would re-introduce the zoom/size conflict the rule
  prevents); the original single client is parked on a scratch session meanwhile.
- Identifying the agent pane is a new capability: agent hooks, which already set
  the session-level `@jmux-agent-state`, additionally record `$TMUX_PANE`
  (last-writer-wins, with a dead-pane fallback to the session's active window).
