# Command Center renders live composited tmux clients, not a polling dashboard

## Status

accepted

## Context & decision

The Command Center shows all pinned panes at once so the user can watch *and
drive* several parallel coding agents. We had two fundamentally different ways to
get multiple panes' content onto one screen:

- **(A) Polling dashboard** — periodically `capture-pane` each pinned pane and
  render read-only tiles, dropping into a session to interact.
- **(B) Live multiplexer** — one real attached tmux client per tile (each its own
  `ScreenBridge`), composited by jmux like a tiling window manager, every tile
  fully live and typeable.

We chose **(B)**. Driving the agents from the single pane of glass — not just
watching them — is the entire point; a read-only dashboard fails the core use
case.

Each tile is a **second real tmux client attached directly to the pinned pane's
own session** (`TmuxPty` strictAttach → `tmux attach-session`), each with its own
xterm.js `ScreenBridge`. jmux composites the tiles into a width-floored columns
grid and draws tmux-style border chrome per tile, since tmux cannot itself show
panes from different sessions in one window. To show the pinned pane full-bleed
(not its sibling panes) jmux applies a **transient zoom** (`resize-pane -Z`) only
while in the glass and only when the pane's window has sibling panes; the zoom is
restored on teardown.

The mechanism is **pane-level and non-destructive.** A pinned pane never leaves
its own session/window/layout. Tile teardown only **detaches** the client (kills
the pty) and undoes any transient zoom — it never runs `new-session` or
`kill-session`. This is the property that makes the Command Center safe to enter
and leave at will.

## Considered alternatives

- **Polling dashboard (A)** — rejected; read-only tiles cannot drive agents.
- **Break-pane checkout** — *implemented and then reverted.* This earlier design
  moved each pinned pane into a shared `__jmux_glass` holding session (via
  `break-pane`/`move-pane`) so the glass owned a clean set of panes, then moved
  them home on teardown via recorded "home" coordinates. It was abandoned because
  it physically removes panes from their sessions — disrupting the user's layout
  and, for a sole-pane session, destroying the session entirely on break. The
  non-destructive attach-and-zoom design above replaces it; there is no holding
  session anymore.

## Consequences

- jmux now runs **N attached tmux clients + N xterm.js bridges** instead of one.
  CPU scales with tile count, so we cap it: only **visible** tiles parse (P2);
  off-screen tiles (when pins overflow and the glass scrolls) are paused.
- The real (main) client is **parked on a hidden `__jmux_park` session** while
  the glass is up, so the tile clients' window sizes don't constrain the real
  sessions; the main client is restored on exit.
- The Command Center is **mutually exclusive** with the single-session view: the
  sidebar's active selection is either a session id **or** the Command Center
  sentinel, so nothing has to police two simultaneous views.
- Tile clients are spawned **on-demand** when the glass is entered and torn down
  on exit (detach only). Tile order is **deterministic** — by session name then
  pane id — so tiles stay stable across detach/reattach.
- The set of tiles is the union of **manual pins** (`@jmux-pinned`, see ADR 0002)
  and, when the *auto-pin* setting is enabled, **auto-detected agent panes**.
  Auto-detection is an optional convenience, not the core mechanism: the baseline
  model is that users pin panes explicitly. Auto-detected panes are never written
  to `@jmux-pinned`.
