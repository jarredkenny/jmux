# Pin state lives in a per-session tmux option, mirrored to config.json

## Status

accepted

## Context & decision

Pins now drive pane-of-glass membership, so agents (via `jmux ctl`) must be able
to pin/unpin sessions and have the running TUI react. But the CLI talks **only to
tmux** — it has no IPC channel to the live jmux TUI process, and pin state
historically lived in the TUI's in-memory `pinnedSessions` set persisted to
`~/.config/jmux/config.json`, which the TUI owns. An agent has no clean way to
reach that: writing `config.json` behind the TUI's back is a clobber-race.

We made a **per-session tmux user option `@jmux-pinned` the runtime source of
truth**, reusing the exact pattern jmux already uses for `@jmux-agent-state`:

- The CLI writes the option (`jmux ctl session pin/unpin/pinned` →
  `tmux set-option @jmux-pinned`), staying within its tmux-only model — no new IPC.
- The TUI reflects the option in via the control channel, updates its set,
  re-tiles the glass live, and **mirrors it to `config.json`** for durability
  (tmux options die with the server; config survives). On startup the TUI
  re-applies config-saved pins onto matching live sessions.
- The TUI's own pin/unpin actions write the *same* option, so UI and CLI cannot
  diverge.

## Considered alternatives

- **Config file as sole source of truth, agents write it directly** — rejected:
  clobber-races with the TUI that owns the file, and no live-update signal.
- **New IPC socket between CLI and TUI** — rejected: a whole new protocol and
  lifecycle to maintain, when tmux options already bridge this exact gap.

## Consequences

- Pin state has two stores by design — the tmux option (live, shared, agent-
  writable) and `config.json` (durable) — reconciled by the TUI. A reader seeing
  both should know neither is redundant.
- The boundary is deliberate: agents control glass **membership**, never the
  user's **view**. Pinning populates the glass; it cannot force the user's screen
  into it.
