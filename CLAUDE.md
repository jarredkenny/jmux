# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

jmux is a tmux-wrapping TUI for running multiple coding agents in parallel. It replaces tmux's status bar with its own sidebar (session list) and toolbar (window tabs + actions). Target runtime is **Bun 1.2+**, not Node. Requires tmux 3.2+ at runtime.

~2400 lines of TypeScript. No bundler — the `bin/jmux` shim runs `src/main.ts` directly under Bun.

## Commands

```bash
bun run dev                # Run jmux from source (src/main.ts)
bun test                   # Run all tests
bun test src/__tests__/sidebar.test.ts   # Run a single test file
bun test -t "group label"                # Filter tests by name
bun run typecheck          # tsc --noEmit (strict mode)
bun run docker             # Build + run Dockerfile.test for a clean-env sanity check
bun run src/main.ts ctl --help           # Show agent control CLI help
bun run src/main.ts ctl session list     # List sessions (JSON)
```

There is no build step for running — `bin/jmux` is `import "../src/main.ts"`. The `dist/` dir is only produced by `tsc` and is not shipped in the npm package (see `package.json` `files`).

The published binary is installed with `bun install -g @jx0/jmux`. The `jmux --install-agent-hooks` subcommand writes a `Stop` hook into `~/.claude/settings.json` that sets the tmux `@jmux-attention` option — this is how the orange `!` indicator appears when Claude Code finishes a response.

## Architecture

jmux is **not** a tmux replacement — it drives a real tmux process via two channels and composites its own UI chrome around tmux's terminal output.

### The two-channel tmux model

Every running jmux instance talks to tmux in two ways simultaneously:

1. **PTY client** (`src/tmux-pty.ts`) — spawns `tmux new-session -A` in a real pty via `bun-pty`. This is the interactive client that receives keystrokes and produces the terminal bytes the user sees.
2. **Control client** (`src/tmux-control.ts`) — a separate `tmux -C attach` subprocess speaking tmux's control-mode protocol (`%begin`/`%end` blocks, `%sessions-changed`, `%client-session-changed`, etc.). Used for structured metadata (list-sessions, list-windows) and real-time events.

These are two different tmux *clients* attached to the same *server*. Several subtleties fall out of this that any change in this area must respect:

- Responses on the control channel carry a `flags` field. `flags=1` means "this is a reply to a command sent by this client"; `flags=0` is noise from other clients or the initial attach. `TmuxControl` filters on `flags === 1` (see `tmux-control.ts:166`).
- `%client-session-changed` is authoritative for the PTY client's current session. `%session-changed` on the control channel refers to the *control* client and is deliberately ignored during normal operation (see the event handler in `main.ts` around line 1309).
- Session switches must target the PTY client by name: `switch-client -c <ptyClientName> -t <session>`. The name is resolved by matching `list-clients` entries against the PTY's PID in `resolveClientName()` (`main.ts:368`).
- `refresh-client -f no-output` is sent at control startup to suppress `%output` notifications so they don't flood the parser.

### The rendering pipeline

jmux owns the terminal surface. Every frame flows through:

```
tmux PTY bytes → ScreenBridge (@xterm/headless) → CellGrid → Renderer → stdout
                                                         ↑
                           Sidebar / Toolbar / Modal overlays composited in
```

- **`src/screen-bridge.ts`** — feeds raw PTY bytes into a headless xterm.js terminal and reads back a `CellGrid` (2D array of `Cell` with fg/bg/mode/bold/italic/underline/dim). This is the ground truth for what tmux thinks the screen looks like.
- **`src/cell-grid.ts`** — owns the `Cell` shape, the `cellWidth` Unicode width table, and grid construction helpers. The width table must agree with `charDisplayWidth` in `renderer.ts`; they're both used for column tracking and drift here causes visible ghost gaps.
- **`src/renderer.ts`** — composites the main grid + sidebar + toolbar + optional modal overlay into a single frame, then diff-free emits SGR codes to stdout. Only re-emits SGR when attributes change between adjacent cells. After wide (width=2) cells it explicitly repositions the cursor to prevent drift between xterm.js's width model and the real terminal.
- **`src/sidebar.ts`** — the left 26-col (configurable) panel listing sessions with groups, activity dots, attention flags, hover states, scrolling. Grouping prefers a session's wtm `project` (bare-repo basename) over directory path matching.
- **`src/main.ts` `makeToolbar()` / renderer's toolbar logic** — the top row: window tabs on the left, action buttons (new window, splits, Claude, settings) on the right.

Rendering is coalesced to ~60fps via `scheduleRender()`. `writesPending` gates rendering while `ScreenBridge.write()` promises are still resolving, otherwise we'd render mid-write and tear frames.

### Input routing

**`src/input-router.ts`** sits between raw stdin and the PTY. It:

- Parses SGR mouse sequences (`\x1b[<...M`) and dispatches clicks/hovers to sidebar / toolbar / main area based on x-coordinate relative to `sidebarCols`. Mouse events in the main area have their x translated and forwarded to tmux so tmux's own mouse support keeps working.
- Implements a **soft prefix intercept**: `Ctrl-a` is forwarded to tmux as normal, *but* if the next byte is `p` / `n` / `i` within a short window, jmux intercepts it to open the palette / new-session modal / settings instead of letting tmux handle it. This is why the prefix key is still customizable via `~/.tmux.conf` — we piggyback on whatever tmux's prefix is by listening for the literal `\x01` byte that `Ctrl-a` produces. If a user rebinds their tmux prefix, the intercept needs to be thought about.
- Handles `Ctrl-Shift-Up/Down` (`\x1b[1;6A` / `\x1b[1;6B`) directly for session switching — these never reach tmux.

### Modals

Modals implement the `Modal` interface in `src/modal.ts` and are rendered as an overlay by the main renderer. When a modal is open, `InputRouter` routes input to `onModalInput` instead of the PTY. Existing modals: `CommandPalette`, `InputModal`, `ListModal`, `ContentModal`, `NewSessionModal`. Each returns `{type: "consumed" | "closed" | "result"}` from `handleInput`.

### Config layering

jmux's config layering for tmux is **three-tier** and order matters:

```
config/defaults.conf   ← jmux opinionated baseline
~/.tmux.conf           ← user overrides
config/core.conf       ← jmux requirements, sourced LAST, always wins
```

See `config/tmux.conf` for the loader. `core.conf` enforces the small set of settings jmux depends on: `mouse on`, `detach-on-destroy off`, `status off` (we render our own toolbar), pane border titles, and auto window naming. Do not add new settings to `core.conf` unless they're genuinely required for jmux to function.

jmux's own settings live in `~/.config/jmux/config.json` (sidebar width, claude command, project dirs, wtm integration). The file is watched; sidebar-width changes hot-apply without restart.

## Things to know when editing

- **Target Bun, not Node.** Code uses `Bun.spawn`, `Bun.spawnSync`, `Bun.$`, `FileSink`-style stdin writes, and `bun-pty`. Don't replace these with Node equivalents or add a Node-targeted build.
- **The session sanitization rule.** tmux session names reject `.` and `:`. Worktree creation uses `sanitizeTmuxSessionName` once and reuses that single name for the worktree directory, the `wtm create` argument, *and* the tmux session. Splitting these creates drift between the directory on disk and the session name. See `main.ts:905` and commit `f43c5c1`.
- **Wide characters.** Column bookkeeping is sensitive. Any new code that writes to a `CellGrid` needs to handle width-2 cells by leaving a width-0 continuation cell after them. See existing patterns in `renderer.ts` toolbar rendering and `sidebar.ts`.
- **OSC 52 clipboard passthrough.** `forwardOsc52` in `main.ts` buffers across chunked PTY data so copy sequences survive split reads. Don't replace it with a naive regex scan.
- **Tests are pure unit tests over the logic modules.** `src/__tests__/*` exercises `ControlParser`, `CellGrid`, `InputRouter`, `ScreenBridge`, modals, and the sidebar's render plan. They don't spawn tmux. When adding logic that depends on tmux protocol parsing or grid math, add a test at the same level — don't reach for integration tests.
- **No bundler, no transpile-on-publish.** Package `files` ships `bin`, `src`, `config`. `bin/jmux` imports `src/main.ts` directly; users run it under Bun. Imports must stay valid at runtime — don't add build-time-only tricks.
