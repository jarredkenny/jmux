<div align="center">

<img src="site/assets/logo.svg" alt="jmux" width="96" height="96">

# jmux

**The terminal workspace for running coding agents in parallel.**

Run Claude Code, Codex, or any agent across isolated sessions — jmux shows you which are working, which finished, and which need your review. Optionally connect [Linear](https://linear.app) and [GitLab](https://about.gitlab.com) or [GitHub](https://github.com) to go from triage to deployment without leaving your terminal.

[![npm](https://img.shields.io/npm/v/@jx0/jmux)](https://www.npmjs.com/package/@jx0/jmux)
[![license](https://img.shields.io/github/license/jarredkenny/jmux)](LICENSE)

![jmux with sidebar sessions, window tabs toolbar, and Claude Code](docs/screenshots/hero.png)

</div>

## Install

```bash
bun install -g @jx0/jmux
jmux
```

Requires [Bun](https://bun.sh) 1.3.8+, [tmux](https://github.com/tmux/tmux) 3.2+. jmux will offer to install tmux on first run. New to tmux? See the **[Getting Started guide](docs/getting-started.md)**.

Try it without credentials: `jmux --demo` runs with mock data so you can explore every feature.

---

## Linear, GitLab & GitHub Integration

Connect Linear and GitLab or GitHub to manage your workflow from the terminal. Open the info panel (`Ctrl-a g`) to see your issues grouped by team and status, MRs/PRs with pipeline state, and your review queue — all in tabbed views alongside an integrated diff viewer.

![jmux info panel showing Linear issues grouped by team and status](docs/screenshots/linear-issues.png)

Select an issue. Press `n`. jmux creates a worktree, opens a session, and launches your agent with the issue context — one keystroke from ticket to working code.

While agents work, the sidebar shows which sessions have new output (green dot), which need review (orange `!`), and what the pipeline looks like (`✓` `⟳` `✗`). Switch between sessions with `Ctrl-Shift-Up/Down`.

When the agent finishes, toggle the diff panel to review changes. Then flip to the MRs tab — approve, undraft, or update status without opening a browser.

![jmux info panel showing GitLab merge requests with pipeline status](docs/screenshots/gitlab-mrs.png)

Press `o` to open anything in your browser, `s` to update an issue's status, `a` to approve an MR, `r` to undraft. The keyboard shortcuts are shown at the bottom of each view.

**Setup (GitLab):**

```json
// ~/.config/jmux/config.json
{
  "adapters": {
    "codeHost": { "type": "gitlab" },
    "issueTracker": { "type": "linear" }
  }
}
```

Set `$LINEAR_API_KEY` and `$GITLAB_TOKEN` in your environment.

**Setup (GitHub):**

```json
// ~/.config/jmux/config.json
{
  "adapters": {
    "codeHost": { "type": "github" },
    "issueTracker": { "type": "linear" }
  }
}
```

Set `$LINEAR_API_KEY` and `$GH_TOKEN` (or `$GITHUB_TOKEN`) in your environment. Falls back to `gh auth token` if no env var is set. Token requires `repo` scope for full functionality (PRs, check runs, reviews, branch protection).

**Setup (GitHub Enterprise):**

```json
// ~/.config/jmux/config.json
{
  "adapters": {
    "codeHost": { "type": "github", "url": "https://github.mycompany.com/api/v3" }
  }
}
```

Or set `$GITHUB_ENTERPRISE_URL` in your environment instead of the config `url` field.

See [docs/issue-tracking.md](docs/issue-tracking.md) for the full guide.

---

## Features

### Session Sidebar

Every session visible at a glance — name, window count, git branch, pipeline status, linked issues. Sessions sharing a parent directory are automatically grouped. Mouse wheel scrolling when sessions overflow.

- Green `▎` marker + highlighted background on the active session
- Green `●` dot for sessions with new output
- Orange `!` flag for attention (e.g., an agent finished and needs review)
- Pipeline glyphs: `✓` passed, `⟳` running, `✗` failed, `◆` merged
- Linked issue identifiers (e.g., `ENG-1234`) and MR count

### Command Palette

Press `Ctrl-a p` to fuzzy-search sessions, windows, pane actions, settings, and issue/MR commands.

![Command palette floating over a jmux workspace](docs/screenshots/command-palette.png)

### Integrated Diff Panel

Press `Ctrl-a g` to open an embedded [hunk](https://github.com/modem-dev/hunk) diff panel — syntax-highlighted, word-level diffs with split and full-screen views.

![jmux with diff panel in split mode showing code changes alongside Claude Code](docs/screenshots/diff-panel-split.png)

- **Split** — diff panel docks to the right. See agent output and code changes simultaneously.
- **Full** — `Ctrl-a z` zooms the diff to take over the main area. Sidebar stays for session switching.

![jmux with diff panel in full-screen mode](docs/screenshots/diff-panel-full.png)

### Worktree-Native Workflows

jmux integrates with **[wtm](https://github.com/jarredkenny/worktree-manager)** to give each agent its own isolated branch — no stashing, no conflicts, no switching.

```bash
bun install -g @jx0/wtm     # one-time setup
wtm init git@github.com:you/repo.git
```

Press `Ctrl-a n`, select your project, choose **+ new worktree**. jmux walks you through picking a base branch and naming the worktree. The sidebar groups sessions by project and shows each worktree's branch name.

### Agent Integration

Built for running multiple coding agents in parallel. One command sets up attention notifications:

```bash
jmux --install-agent-hooks
```

When Claude Code finishes a response, the orange `!` appears. Switch to it, review the work, move on. Works with any agent that can run a shell command on completion. See [docs/claude-code-integration.md](docs/claude-code-integration.md).

### Agent Control CLI

`jmux ctl` is a JSON API that lets agents manage sibling sessions, windows, and panes programmatically.

```bash
# Create a session and launch Claude Code with a task
jmux ctl run-claude --name fix-auth --dir /repo --message "Fix the auth bug in src/auth.ts"

# Check if an agent finished (attention flag = needs review)
jmux ctl session info --target fix-auth | jq .attention

# Capture what's on screen in another pane
jmux ctl pane capture --target %12

# Send a follow-up prompt to a running agent
jmux ctl pane send-keys --target %12 "Now add tests for that fix"
```

jmux ships a [Claude Code skill](skills/jmux-control.md) that agents auto-discover inside jmux sessions — dispatch parallel agents, poll for completion, capture output, and chain tasks without human prompting.

### Bring Your Own Everything

jmux works with your existing `~/.tmux.conf`. Your plugins, theme, prefix key, and custom bindings carry over. Only a small set of core settings are enforced.

Use any editor. Any Git tool. Any AI agent. Any shell. No Electron. No proprietary runtime. If it runs tmux, it runs jmux.

### Built With the Best

- **[hunk](https://github.com/modem-dev/hunk)** — Terminal diff viewer. Syntax-highlighted, word-level diffs with split and full-screen views
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** — AI coding agent. jmux reads its telemetry for cache timers and attention flags
- **[Linear](https://linear.app)** — Issue tracking. Pull issues, link to sessions, update statuses from the terminal
- **[GitLab](https://about.gitlab.com)** — MR status, pipelines, approvals in the sidebar and info panel
- **[GitHub](https://github.com)** — PR status, check runs, approvals in the sidebar and info panel
- **[lazygit](https://github.com/jesseduffield/lazygit)** — Terminal Git UI. Run it in a jmux pane alongside your agent
- **[gh](https://cli.github.com/)** / **[glab](https://gitlab.com/gitlab-org/cli)** — GitHub and GitLab CLIs

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

### Panes

| Key | Action |
|-----|--------|
| `Ctrl-a \|` | Split horizontal |
| `Ctrl-a -` | Split vertical |
| `Shift-Left/Right/Up/Down` | Navigate panes (vim-aware) |
| `Ctrl-a Left/Right/Up/Down` | Resize panes |
| `Ctrl-a z` | Toggle pane zoom |


### Info Panel

| Key | Action |
|-----|--------|
| `Ctrl-a g` | Toggle info panel on/off |
| `[` / `]` | Cycle tabs (Diff, Issues, MRs, Review) |
| `Ctrl-a z` | Zoom panel (split <> full, when focused) |
| `Ctrl-a Tab` | Switch focus between tmux and panel |
| `Shift-Right` | Focus panel from rightmost pane |
| `Shift-Left` | Return focus to tmux from panel |
| `Up` / `Down` | Navigate items in issue/MR views |
| `o` | Open selected item in browser |
| `n` | Start session from selected issue |
| `l` | Link selected item to current session |
| `s` | Update issue status |
| `a` | Approve MR |
| `r` | Mark MR ready (undraft) |
| `g` / `G` | Cycle group-by / sub-group-by |
| `/` / `?` | Cycle sort field / toggle sort order |

### Utilities

| Key | Action |
|-----|--------|
| `Ctrl-a p` | Command palette |
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

Override any default in your `~/.tmux.conf` — prefix key, colors, keybindings, plugins. See [docs/configuration.md](docs/configuration.md) for the full guide.

---

## Architecture

```
Terminal (Ghostty, iTerm, etc.)
  +-- jmux (owns the terminal surface)
       +-- Sidebar (26 cols) -- session groups, indicators, pipeline glyphs
       +-- Border (1 col)
       +-- Main area (remaining cols)
       |    +-- Toolbar (row 0) -- window tabs (left), action buttons (right)
       |    +-- tmux PTY (remaining rows)
       |         +-- PTY client ---- @xterm/headless for VT emulation
       |         +-- Control client - tmux -C for real-time metadata
       +-- Info Panel (optional, split/full)
       |    +-- Tab bar ------------ Diff | Issues | MRs | Review
       |    +-- hunk PTY ----------- @xterm/headless (Diff tab)
       |    +-- Panel views -------- grouped/sorted item lists (other tabs)
       +-- Adapters
       |    +-- Linear ------------- issues, statuses, comments (GraphQL)
       |    +-- GitLab ------------- MRs, pipelines, approvals (REST)
       |    +-- GitHub ------------- PRs, check runs, approvals (REST + GraphQL)
       |    +-- Poll coordinator --- tiered polling, rate-limit backoff
       +-- jmux ctl (JSON API, used by agents inside sessions)
            +-- session / window / pane / run-claude
```

No opinions about what you run inside tmux.

---

## License

[MIT](LICENSE)
