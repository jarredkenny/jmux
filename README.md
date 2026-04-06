<div align="center">

# jmux

**The terminal workspace for agentic development.**

Run Claude Code, Codex, or aider in parallel — jmux shows you which agents are working, which finished, and which need your review. Bring your own editor, your own Git workflow, any agent. Everything stays in your terminal.

[![npm](https://img.shields.io/npm/v/@jx0/jmux)](https://www.npmjs.com/package/@jx0/jmux)
[![license](https://img.shields.io/github/license/jarredkenny/jmux)](LICENSE)

![jmux with sidebar sessions, window tabs toolbar, and Claude Code](docs/screenshots/hero.png)

</div>

## Install

```bash
bun install -g @jx0/jmux
jmux
```

Requires [Bun](https://bun.sh) 1.2+, [tmux](https://github.com/tmux/tmux) 3.2+, [fzf](https://github.com/junegunn/fzf), and optionally [git](https://git-scm.com/) for branch display. jmux will offer to install tmux and fzf for you on first run.

New to tmux? See the **[Getting Started guide](docs/getting-started.md)** — no prior tmux knowledge needed.

---

## Why

AI coding agents work best when you can run many of them at once — different features on different branches, all in parallel. But switching between 10 terminal tabs to figure out which agent finished, which is stuck, and which needs your input is a workflow problem that most tools ignore.

jmux solves this. A persistent sidebar shows every session at a glance with real-time status indicators. An orange `!` appears when an agent finishes and needs review. Click to switch. Review the work. Move on.

**Use any tool.** jmux doesn't bundle an editor, a diff viewer, or a Git GUI. You bring vim, VS Code, lazygit, whatever you already use. This is a design choice, not a limitation — your workflow shouldn't change because you added an orchestrator.

**Work anywhere.** jmux runs in any terminal — local, SSH, containers, devboxes. Your workspace follows you because it's terminal-native, not because it syncs to a cloud.

**No lock-in.** Under the hood, jmux orchestrates tmux sessions. If you stop using jmux, your sessions are still there. Your tools are still your tools. Nothing is proprietary.

## Features

### Session Sidebar

Every session visible at a glance — name, window count, git branch. Sessions sharing a parent directory are automatically grouped under a header. Mouse wheel scrolling when sessions overflow.

- Green `▎` marker + highlighted background on the active session
- Green `●` dot for sessions with new output
- Orange `!` flag for attention (e.g., an agent finished and needs review)

### Toolbar with Window Tabs

The top toolbar shows clickable window tabs on the left and action buttons on the right — new window, split panes, launch Claude Code, settings. The active tab is highlighted in peach, inactive tabs are dim with separators between them. Hover states on everything. tmux's status bar is fully replaced.

### Smart Pane Titles

Pane borders show the running command with automatic detection for tools like Claude Code. Window tabs auto-name to the working directory. No more tabs full of `zsh` or garbled version strings.

### Instant Switching

`Ctrl-Shift-Up/Down` moves between sessions with zero delay. No prefix key, no menu, no mode to enter. Or just click a session in the sidebar. Click a window tab to switch windows. Hover states on sidebar sessions, toolbar tabs, and action buttons. Indicators only clear when you actually interact with a session — not when you're cycling through.

### New Session Modal

`Ctrl-a n` opens a two-step fzf flow: fuzzy-search your git repos for a directory, then name the session. Pre-filled with the directory basename.

### Bring Your Own Everything

jmux works with your existing `~/.tmux.conf`. Your plugins, theme, prefix key, and custom bindings carry over. jmux applies its defaults first, then your config overrides them. Only a small set of core settings are enforced.

Use any editor. Any Git tool. Any AI agent. Any shell. jmux doesn't replace your tools — it organizes them.

### Worktree-Native Workflows

jmux integrates with **[wtm](https://github.com/jarredkenny/worktree-manager)** to give each agent its own isolated branch — no stashing, no conflicts, no switching.

```bash
bun install -g @jx0/wtm     # one-time setup
wtm init git@github.com:you/repo.git
```

Then from jmux, press `Ctrl-a n`, select your project, and choose **+ new worktree**. jmux walks you through picking a base branch and naming the worktree, then opens a split-pane session with the setup running on the left and a ready shell on the right.

The sidebar automatically detects worktrees and groups sessions by project. Each worktree shows its branch name — you see at a glance which agent is working on which branch.

**The workflow:** spin up 5 worktrees from `main`, start Claude Code in each one, and let them work in parallel on different features. Review each one when the `!` flag appears. Merge the good ones.

### Works Great With

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** — AI coding agent with built-in attention flag support
- **[lazygit](https://github.com/jesseduffield/lazygit)** — Terminal Git UI. Run it in a jmux pane alongside your agent
- **[gh](https://cli.github.com/)** / **[glab](https://gitlab.com/gitlab-org/cli)** — GitHub and GitLab CLIs for PRs, issues, and reviews without leaving the terminal

### Agent Integration

Built for running multiple coding agents in parallel. One command sets up attention notifications:

```bash
jmux --install-agent-hooks
```

When Claude Code finishes a response, the orange `!` appears on that session in the sidebar. Switch to it, review the work, move on. Works with any agent that can run a shell command on completion. See [docs/claude-code-integration.md](docs/claude-code-integration.md) for details.

---

## Keybindings

### Sessions

| Key | Action |
|-----|--------|
| `Ctrl-Shift-Up/Down` | Switch to prev/next session |
| `Ctrl-a n` | New session |
| `Ctrl-a r` | Rename session |
| `Ctrl-a m` | Move window to another session |
| Click sidebar | Switch to session |
| Scroll wheel (sidebar) | Scroll session list |

### Windows

| Key | Action |
|-----|--------|
| Click tab | Switch to window |
| `Ctrl-a c` | New window |
| `Ctrl-Right/Left` | Next/prev window |
| `Ctrl-Shift-Right/Left` | Reorder windows |
| `Ctrl-a j` | fzf window picker |

### Panes

| Key | Action |
|-----|--------|
| `Ctrl-a \|` | Split horizontal |
| `Ctrl-a -` | Split vertical |
| `Shift-Left/Right/Up/Down` | Navigate panes (vim-aware) |
| `Ctrl-a Left/Right/Up/Down` | Resize panes |


### Utilities

| Key | Action |
|-----|--------|
| `Ctrl-a k` | Clear pane + scrollback |
| `Ctrl-a y` | Copy pane to clipboard |
| `Ctrl-a i` | Settings |

---

## Configuration

Config loads in three layers:

```
config/defaults.conf      <- jmux defaults (baseline)
~/.tmux.conf              <- your config (overrides defaults)
config/core.conf          <- jmux core (always wins)
```

Override any default in your `~/.tmux.conf` — prefix key, colors, keybindings, plugins. Only core settings jmux depends on are enforced (`mouse on`, `detach-on-destroy off`, window naming, `status off` since jmux renders its own toolbar).

See [docs/configuration.md](docs/configuration.md) for the full guide.

---

## Architecture

```
Terminal (Ghostty, iTerm, etc.)
  +-- jmux (owns the terminal surface)
       +-- Sidebar (26 cols) -- session groups, indicators, hover states
       +-- Border (1 col)
       +-- Main area (remaining cols)
            +-- Toolbar (row 0) -- window tabs (left), action buttons (right)
            +-- tmux PTY (remaining rows)
                 +-- PTY client ---- @xterm/headless for VT emulation
                 +-- Control client - tmux -C for real-time metadata
```

~2400 lines of TypeScript. No opinions about what you run inside tmux.

---

## License

[MIT](LICENSE)
