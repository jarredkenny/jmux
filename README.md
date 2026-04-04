# jmux

A persistent session sidebar for tmux. See every project at a glance, switch instantly, never lose context.

![jmux with Claude Code, process monitor, and sidebar showing all sessions](docs/screenshots/jmux.png)

---

## The Problem

You have 30+ tmux sessions. Each one is a project, a context, a train of thought. But tmux gives you a flat list and a status bar that shows one session name. To switch, you `prefix-s`, scan a wall of text, find the one you want, and hope you remember which window you were in.

You lose context constantly. You forget what's running where. You can't see at a glance which sessions have new output or which ones need attention.

## The Solution

jmux wraps tmux with a persistent sidebar that shows all your sessions, all the time. It doesn't replace tmux — it sits alongside it. Your keybindings, your panes, your workflow. Everything works exactly like before, plus a sidebar.

**What you get:**
- Every session visible at all times with its working directory and git branch
- Instant switching with `Ctrl-Shift-Up/Down` — no prefix, no menu, no delay
- Activity indicators that show which sessions have new output
- Attention flags that tools like Claude Code can trigger programmatically
- Mouse click to switch sessions
- A self-contained tmux config — ships its own keybindings, doesn't touch `~/.tmux.conf`

![jmux sidebar alongside vim with split panes and a dev server](docs/screenshots/blog.png)

## How It Works

jmux owns the terminal. It spawns tmux in a PTY, feeds the output through a headless terminal emulator ([xterm.js](https://xtermjs.org/)), and composites a 24-column sidebar alongside the tmux rendering. A separate tmux control mode connection provides real-time session metadata via push notifications.

Your tmux is unmodified. Sessions, windows, panes, keybindings — all unchanged. jmux just adds a persistent view of what's happening across your projects.

```
┌─ jmux sidebar ──┬─ your normal tmux ──────────────────────┐
│                  │                                         │
│  jmux            │  $ vim src/server.ts                    │
│ ──────────────── │  ...                                    │
│ ▎ api-server  3w │                                         │
│    ~/Code/api    │                                         │
│              main│                                         │
│                  │                                         │
│   dashboard   1w │                                         │
│    ~/Code/dash   │                                         │
│            feat/x│                                         │
│                  │                                         │
│ ● deploy      2w │                                         │
│    ~/Code/ops    │                                         │
│             v2.0 │                                         │
│                  ├─────────────────────────────────────────┤
│                  │  1:vim  2:zsh  3:bun                    │
└──────────────────┴─────────────────────────────────────────┘
```

## Installation

### Requirements

- [Bun](https://bun.sh) 1.2+
- [tmux](https://github.com/tmux/tmux) 3.2+
- [fzf](https://github.com/junegunn/fzf) (for window picker popup)
- [git](https://git-scm.com/) (optional, for branch display)

### Install

```bash
git clone https://github.com/jarredkenny/jmux.git
cd jmux
bun install
```

### Run

```bash
bun run bin/jmux
```

Or with a named session:

```bash
bun run bin/jmux my-project
```

### Isolated Server

To run jmux on a separate tmux server (won't interact with your existing sessions):

```bash
bun run bin/jmux -L jmux
```

## Keybindings

### Session Navigation (always active)

| Key | Action |
|-----|--------|
| `Ctrl-Shift-Up` | Switch to previous session |
| `Ctrl-Shift-Down` | Switch to next session |
| `Ctrl-a n` | Create new session (name prompt) |
| Click sidebar | Switch to that session |

### Sidebar Mode (`Ctrl-a j` to enter)

| Key | Action |
|-----|--------|
| `j` / `k` / arrows | Move highlight |
| `Enter` | Switch to highlighted session |
| `Escape` | Exit sidebar mode |

### Windows

| Key | Action |
|-----|--------|
| `Ctrl-a c` | New window (opens in `~`) |
| `Ctrl-Right` / `Ctrl-Left` | Next / previous window |
| `Ctrl-Shift-Right` / `Ctrl-Shift-Left` | Reorder windows |
| `Ctrl-a j` | fzf window picker |

### Panes

| Key | Action |
|-----|--------|
| `Ctrl-a \|` | Split horizontal |
| `Ctrl-a -` | Split vertical |
| `Shift-arrows` | Navigate panes (vim-aware) |
| `Ctrl-a arrows` | Resize panes |
| `Ctrl-a P` | Toggle pane border titles |

### Utilities

| Key | Action |
|-----|--------|
| `Ctrl-a k` | Clear pane screen and scrollback |
| `Ctrl-a y` | Copy entire pane to clipboard |
| `Ctrl-a Space` | Toggle scratchpad popup |

## Claude Code Integration

Tools can set an attention flag on any session:

```bash
tmux set-option -t my-session @jmux-attention 1
```

jmux shows an orange `!` indicator on that session. When you switch to it, the flag clears automatically.

This makes it trivial to set up hooks — for example, a Claude Code hook that flags a session when a task completes and needs review.

## Self-Contained Config

jmux ships its own `config/tmux.conf`. It never reads `~/.tmux.conf`. This means:

- Your existing tmux setup is untouched
- Every jmux user gets the same keybindings and behavior
- No plugin manager needed — everything is built in
- The status bar shows only window tabs (session info is in the sidebar)

## Architecture

```
Terminal (Ghostty, iTerm, etc.)
  └── jmux (owns the terminal surface)
       ├── Sidebar (24 cols) ── renders session list as a cell grid
       ├── Border (1 col) ──── vertical separator
       └── tmux PTY (remaining cols)
            ├── PTY client ──── spawns tmux, feeds output through @xterm/headless
            └── Control client ─ tmux -C for real-time session metadata
```

jmux is ~1000 lines of TypeScript. It has no opinions about what you run inside tmux.

## License

MIT
