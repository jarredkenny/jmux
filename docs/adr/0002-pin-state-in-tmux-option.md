# Pin state lives in a per-pane tmux option, as the sole source of truth

## Status

accepted

## Context & decision

Pins drive Command Center membership, so agents (via `jmux ctl`) must be able to
pin/unpin panes and have the running TUI react. But the CLI talks **only to
tmux** — it has no IPC channel to the live jmux TUI process. We needed a single
place to keep pin state that both the CLI and the TUI can read and write without
racing each other.

We made a **per-pane tmux user option `@jmux-pinned` the sole source of truth**,
reusing the exact pattern jmux already uses for `@jmux-agent-state`:

- The CLI writes the option (`jmux ctl pane pin/unpin/pinned` →
  `tmux set-option -p @jmux-pinned`), staying within its tmux-only model — no new
  IPC.
- The TUI reflects the option via a per-pane `#{P:...}` control-channel
  subscription, updates its set, and re-tiles the glass live.
- The TUI's own command-palette actions ("Pin to Command Center" /
  "Unpin from Command Center", operating on the active pane) write the *same*
  option, so UI and CLI cannot diverge.

Writers only set/unset the option — there is no second store to reconcile.

**Why no config mirror.** Pins are intentionally **tmux-server-lifetime**. The
option lives in the tmux server and is re-read by the TUI on restart, so a TUI
restart preserves pins without any external persistence. A *server* restart
clears the option — but a server restart also kills the agent processes the pins
pointed at, so there is nothing meaningful left to restore. Mirroring to
`config.json` would add a durable store with no live referent and a clobber-race
against the TUI that owns the file, for no benefit.

## Considered alternatives

- **Config file as a durable mirror of the tmux option** — rejected: a tmux
  server restart kills the agents, so persisted pins would point at nothing;
  the mirror buys no real durability and reintroduces a clobber-race with the
  TUI that owns the file.
- **Config file as sole source of truth, agents write it directly** — rejected:
  clobber-races with the TUI, and no live-update signal back to the running TUI.
- **New IPC socket between CLI and TUI** — rejected: a whole new protocol and
  lifecycle to maintain, when tmux options already bridge this exact gap.

## Consequences

- Pin state has exactly **one store** — the per-pane tmux option — live, shared,
  and agent-writable. No reconciliation logic exists or is needed.
- The boundary is deliberate: agents control glass **membership** (the option),
  never the user's **view**. Pinning populates the Command Center; it cannot force
  the user's screen into it.
- Auto-detected agent panes (the optional auto-pin setting) are **unioned in at
  render time and never written to `@jmux-pinned`**, so the option stays a clean
  record of *explicit* user/agent pins.
