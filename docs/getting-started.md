# Getting Started with jmux

A step-by-step guide for developers who haven't used tmux before. jmux handles the complexity of tmux for you — you don't need to learn tmux to use jmux.

---

## Install

```bash
bun install -g @jx0/jmux
```

jmux will check for dependencies and offer to install them automatically. If you prefer to install manually:

```bash
# macOS
brew install tmux fzf

# Ubuntu/Debian
sudo apt install tmux fzf

# Fedora
sudo dnf install tmux fzf

# Arch
pacman -S tmux fzf
```

You'll also need [Bun](https://bun.sh) 1.2+ and optionally [git](https://git-scm.com/) for branch display in the sidebar.

---

## First launch

```bash
jmux
```

You'll see a terminal split into two areas:

```
+--sidebar--+--main area---------------------+
| jmux      |                                 |
| ────────  |  Your shell prompt is here.     |
|           |  This is a normal terminal.     |
| ▎ default |  Everything works like usual.   |
|            |                                 |
+------------+---------------------------------+
```

- **Sidebar** (left): shows all your sessions, grouped by project
- **Main area** (right): your normal terminal — run commands, edit files, whatever you'd normally do

---

## Core concepts

### Sessions

A **session** is an independent workspace. Each session has its own set of windows and remembers what you were doing. Think of sessions like browser profiles — completely separate environments.

Use sessions to separate projects:
- One session for your API server
- One session for the frontend
- One session for running an AI coding agent

### Windows

A **window** is a tab within a session. The window tabs appear at the bottom of the screen. Each window is a full-screen terminal.

### Panes

A **pane** splits a window into multiple terminals side by side. Useful for watching logs while editing code, or running a server alongside a test runner.

---

## Essential keybindings

jmux uses `Ctrl-a` as the **prefix key**. Some actions require pressing `Ctrl-a` first, then the next key. Others work directly.

### Navigating sessions

| Action | Keys |
|--------|------|
| Next session | `Ctrl-Shift-Down` |
| Previous session | `Ctrl-Shift-Up` |
| Switch to session | Click it in the sidebar |

No prefix key needed — these work instantly.

### Creating things

| Action | Keys |
|--------|------|
| New session | `Ctrl-a` then `n` |
| New window (tab) | `Ctrl-a` then `c` |
| Split pane horizontally | `Ctrl-a` then `\|` |
| Split pane vertically | `Ctrl-a` then `-` |

### Navigating windows and panes

| Action | Keys |
|--------|------|
| Next window | `Ctrl-Right` |
| Previous window | `Ctrl-Left` |
| Switch pane | `Shift-Arrow` (any direction) |
| Window picker | `Ctrl-a` then `j` |

### Utilities

| Action | Keys |
|--------|------|
| Settings | `Ctrl-a` then `i` |
| Clear pane | `Ctrl-a` then `k` |
| Copy pane to clipboard | `Ctrl-a` then `y` |
| Rename session | `Ctrl-a` then `r` |
| Move window to session | `Ctrl-a` then `m` |

---

## Common workflows

### Running an AI agent alongside your editor

1. Start jmux: `jmux`
2. Open your editor (vim, etc.) in the main area
3. Split the window: `Ctrl-a` then `|`
4. In the right pane, start your agent: `claude`
5. Switch between panes with `Shift-Left` and `Shift-Right`

### Multiple agents on different projects

1. Start jmux: `jmux`
2. Create a new session: `Ctrl-a` then `n`
3. Pick a project directory, name the session
4. Start an agent in the new session
5. Repeat for more projects
6. Switch between sessions with `Ctrl-Shift-Up/Down` or click the sidebar

### Monitoring multiple agents

When you have several agents running in different sessions:

- **Green dot** `●` — this session has new output since you last looked
- **Orange bang** `!` — an agent finished and needs your review
- **Green bar** `▎` — you're currently viewing this session

Switch to a session to check on it. The indicators clear when you type something in that session — not when you're just passing through.

---

## Claude Code integration

Set up attention notifications so jmux tells you when Claude Code finishes:

```bash
jmux --install-agent-hooks
```

Now when Claude Code completes a response in any session, that session gets an orange `!` in the sidebar. Switch to it, review the work, move on.

---

## Settings

Press `Ctrl-a` then `i` to open the settings modal:

- **Sidebar Width** — adjust how wide the sidebar is
- **Project Directories** — which directories to search when creating new sessions
- **wtm Integration** — toggle git worktree support

Settings are saved to `~/.config/jmux/config.json` and most take effect immediately.

---

## Tips

- **Scroll the sidebar** with your mouse wheel when you have many sessions
- **Click the version** at the bottom of the sidebar to see release notes
- **Mouse selection** works — click and drag to select text, it copies to your clipboard
- **Your tmux config** still works. If you have `~/.tmux.conf`, jmux loads it. Your plugins, themes, and custom bindings carry over
- **Resize panes** with `Ctrl-a` then arrow keys (hold for continuous resize)
- **Pane borders** auto-show when a window has multiple panes and hide for single-pane windows

---

## Next steps

- Read the [cheat sheet](cheat-sheet.md) for a complete keybinding reference
- Set up [Claude Code integration](claude-code-integration.md) for agent notifications
- Try [wtm](https://github.com/jarredkenny/worktree-manager) for git worktree workflows
- See [configuration](configuration.md) for advanced tmux config layering
