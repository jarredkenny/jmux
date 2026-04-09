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
brew install tmux

# Ubuntu/Debian
sudo apt install tmux

# Fedora
sudo dnf install tmux

# Arch
pacman -S tmux
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

### Sessions = projects

A **session** is a project. Each session has its own set of windows and remembers what you were doing — think of sessions like browser profiles, completely separate environments.

Create one session per project:
- `myapp` — your main project
- `docs-site` — a separate project
- `infra` — your infrastructure repo

### Windows = concerns within a project

A **window** is a tab within a session. Window tabs appear in the toolbar at the top of the screen — click one to switch. Each window is a full-screen terminal.

Use windows to separate the things you're doing inside a project:
- One window for your editor
- One window for an AI coding agent
- One window for a dev server or test runner

### Panes = multiplexing within a window

A **pane** splits a window into multiple terminals side by side. Useful when you want to see two things at once — like a server's output while you're editing code in the same window, or two log streams next to each other.

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
| Resize pane | `Ctrl-a` then arrow keys (repeatable) |
| Toggle pane zoom | `Ctrl-a` then `z` |
| Window picker | `Ctrl-a` then `j` |

### Diff panel

| Action | Keys |
|--------|------|
| Toggle diff panel | `Ctrl-a` then `g` |
| Zoom diff panel (split ↔ full) | `Ctrl-a` then `z` (when diff is focused) |
| Switch focus (tmux ↔ diff) | `Ctrl-a` then `Tab` |
| Focus diff from rightmost pane | `Shift-Right` |
| Return focus to tmux | `Shift-Left` (from diff panel) |

Requires [hunkdiff](https://github.com/modem-dev/hunk) (`npm i -g hunkdiff`). Shows the active session's working tree changes.

### Utilities

| Action | Keys |
|--------|------|
| Command palette | `Ctrl-a` then `p` |
| Settings | `Ctrl-a` then `i` |
| Clear pane | `Ctrl-a` then `k` |
| Copy pane to clipboard | `Ctrl-a` then `y` |
| Rename session | `Ctrl-a` then `r` |
| Move window to session | `Ctrl-a` then `m` |

---

## Common workflows

### Setting up a project session

1. Start jmux: `jmux`
2. You're in your first session — this is your first project
3. Open your editor in the default window
4. Create a new window for your agent: `Ctrl-a` then `c`
5. Start your agent: `claude`
6. Create another window for your dev server: `Ctrl-a` then `c`
7. Switch between windows with `Ctrl-Right` / `Ctrl-Left` or click the tabs

Now you have one project with an editor, an agent, and a dev server — each in its own tab.

### Working on multiple projects

1. Create a new session: `Ctrl-a` then `n`
2. Pick a project directory, name the session
3. Set up windows for that project (editor, agent, etc.)
4. Repeat for more projects
5. Switch between projects with `Ctrl-Shift-Up/Down` or click the sidebar

### Parallel agents with worktrees (recommended)

The most powerful workflow: give each agent its own git branch in an isolated worktree. No conflicts, no stashing, agents can't step on each other.

**One-time setup:**

```bash
bun install -g @jx0/wtm
wtm init git@github.com:you/repo.git
```

This creates a bare repo with [wtm](https://github.com/jarredkenny/worktree-manager) — a git worktree manager built for this workflow.

**Daily workflow:**

1. Press `Ctrl-a` then `n` to create a new session
2. Select your wtm-managed project
3. Choose **+ new worktree**
4. Pick a base branch (e.g., `main`) and name your branch
5. jmux creates the worktree and opens a split-pane session
6. Start your agent: `claude`
7. Repeat for more features — each gets its own branch

The sidebar groups worktrees by project and shows each branch name. When an agent finishes (orange `!`), switch to it, review the diff, and merge if it's good.

**Example:** 5 agents, 5 branches, all working off `main` simultaneously:

```
myproject (sidebar)
  ● feature-auth        1w
    feature-auth
  ! feature-search      1w
    feature-search
  ● fix-validation      1w
    fix-validation
  ● refactor-api        1w
    refactor-api
    add-tests           1w
    add-tests
```

### Reviewing agent changes with the diff panel

When an agent finishes work and the `!` flag appears:

1. Switch to that session
2. Press `Ctrl-a g` to open the diff panel in split mode — you'll see the agent's terminal on the left and its code changes on the right
3. Click the diff panel or press `Shift-Right` to focus it, then use `j`/`k` to scroll and `[`/`]` to jump between hunks
4. Press `Ctrl-a z` to zoom the diff to full-screen for thorough review
5. Press `Ctrl-a z` again to unzoom, or `Ctrl-a g` to close the panel entirely

The diff panel shows the working tree changes for whichever session is active. Switch sessions in the sidebar and the diff updates automatically.

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

- **Command palette** (`Ctrl-a` then `p`) lets you fuzzy-search sessions, windows, pane actions, and settings — useful when you can't remember a keybinding
- **Scroll the sidebar** with your mouse wheel when you have many sessions
- **Click the version** at the bottom of the sidebar to see release notes
- **Mouse selection** works — click and drag to select text, it copies to your clipboard
- **Your tmux config** still works. If you have `~/.tmux.conf`, jmux loads it. Your plugins, themes, and custom bindings carry over
- **Resize panes** with `Ctrl-a` then arrow keys (hold for continuous resize)
- **Zoom a pane** with `Ctrl-a` then `z` — the tab shows ⤢ when zoomed, press again to unzoom
- **Pane borders** auto-show when a window has multiple panes and hide for single-pane windows

---

## Next steps

- Read the [cheat sheet](cheat-sheet.md) for a complete keybinding reference
- Set up [Claude Code integration](claude-code-integration.md) for agent notifications
- Try [wtm](https://github.com/jarredkenny/worktree-manager) for git worktree workflows
- See [configuration](configuration.md) for advanced tmux config layering
