<div align="center">

<img src="site/assets/logo.svg" alt="jmux" width="96" height="96">

# jmux

### Run a fleet of coding agents in parallel — and always know which one needs you.

Claude Code, Codex, or any agent — each in its own isolated session. jmux is the mission control that shows you who's working, who finished, and who's blocked on you.

[![npm](https://img.shields.io/npm/v/@jx0/jmux)](https://www.npmjs.com/package/@jx0/jmux)
[![license](https://img.shields.io/github/license/jarredkenny/jmux)](LICENSE)

![jmux with sidebar sessions, window tabs toolbar, and Claude Code](docs/screenshots/hero.webp)

```bash
curl -fsSL https://jmux.build/install | sh && jmux
```

**[▶ Watch the walkthrough](https://jmux.build/#demo)** — real agents, nothing staged.

</div>

## Get running

- **Install** — the command above needs no runtime; it installs a self-contained
  binary. Also on Homebrew (`brew install jarredkenny/tap/jmux`) and npm
  (`bun install -g @jx0/jmux`, which needs [Bun](https://bun.sh) 1.3.8+ and is
  the only option on Alpine/musl).
- **Requirements** — [tmux](https://github.com/tmux/tmux) 3.2+. jmux offers to install it on first run.
- **Just want to look around?** `jmux --demo` runs with mock data — explore every feature, no credentials needed.
- **New to tmux?** Start with the **[Getting Started guide](docs/getting-started.md)**.

---

## Features

### See every agent at a glance

Kicking off five agents is easy. Keeping track of them is the hard part — which one is still thinking, which one stopped to ask you a question, which one quietly finished ten minutes ago.

jmux answers that at a glance. The **sidebar** lists every session with live indicators, and the **Command Center** gives you a single grid of every agent you care about — each tile a live, drivable mirror of a pinned pane, its border colored by state so you see who needs you without hunting.

![jmux Command Center: a grid of live Claude agent panes, borders colored by state](docs/screenshots/fleet.gif)

- **Green `●`** — new output.  **Orange `!`** — an agent finished and needs your review.
- **Pipeline glyphs** — `✓` passed, `⟳` running, `✗` failed, `◆` merged, right in the sidebar.
- **Pin any pane** into a named Command Center tab (`Backend`, `Review`, …) — panes stay in their own session, never moved or broken.
- **Jump between sessions** with `Ctrl-Shift-Up/Down`. Sessions sharing a project are grouped automatically.

<details>
<summary><b>Setup</b> — live agent state for Claude Code, Codex and pi</summary>

`jmux --install-agent-hooks` installs a state emitter into every supported agent it finds, so the sidebar shows RUNNING / WAITING / COMPLETE per agent pane. [How it works](docs/agent-integration.md).
</details>

### From ticket to merged, without leaving the terminal

Connect [Linear](https://linear.app) and [GitLab](https://about.gitlab.com) or [GitHub](https://github.com), open the info panel with `Ctrl-a g`, and the whole loop lives in your terminal:

**Pick an issue → press `n` → jmux creates a worktree, opens a session, and launches your agent with the issue context.** One keystroke from ticket to working code.

![jmux info panel showing Linear issues beside a live agent](docs/screenshots/ticket.gif)

While it works, watch the sidebar. When it finishes, toggle the **integrated diff panel** to review the changes side-by-side with the agent's output.

![jmux with diff panel in split mode showing code changes alongside Claude Code](docs/screenshots/diff-panel-split.webp)

Then flip to the **MRs tab** — approve, undraft, or update status without opening a browser. `o` opens anything in your browser, `s` updates an issue's status, `a` approves, `r` undrafts.

Each agent gets its own isolated branch via **[wtm](https://github.com/jarredkenny/worktree-manager)** — no stashing, no conflicts, no switching. `Ctrl-a n` → pick a project → **+ new worktree**.

### Define your own workflow

Your tracker has a lot of statuses — `Ready for Development`, `Awaiting QA Sign-off`, `Pending Release Approval` — most of them named for someone else's process. You don't think in 25 states. You think in five.

So jmux has you define **your own workflow stages** and sit each one on top of one or many of your tracker's statuses:

```
Urgent       ──  Customer Escalation, Failed QA
To do        ──  Ready for Development, Triaged
In Progress  ──  In Progress, Reopened
Waiting      ──  In Code Review, Awaiting QA Sign-off, Pending Release Approval, …
Done         ──  Released
```

A stage shows up as a tab in the info panel, but that's how it *appears*, not what it *is* — it's one rung on the ladder you actually work by, and its place in the list is its priority. Every status then has exactly two settings: **which stage it belongs to**, and **whether it parks**.

That second one is what keeps a fleet manageable:

- **Park what you've handed off.** A teammate has it in review, QA has it, it's blocked on someone else — that session collapses into a single `Parked (n)` row at the bottom of the sidebar. Nothing is killed: the session, its worktree and its scrollback are untouched.
- **Parking reverses itself.** The issue moves, someone comments, the MR is touched, a pipeline goes red, or the agent wants you — it comes straight back out, flagged. That's what makes it safe to trust.

![Marking a status as parked in the workflow screen; its sessions collapse into a Parked row in the sidebar](docs/screenshots/flow.gif)

- **See what you haven't started.** Each stage can show the work sitting in it that nobody has picked up — issues with no session — as dimmed rows right under the sessions that do. Click one and it becomes real: worktree, session, agent, issue linked. The sidebar stops being a list of what's running and becomes the whole board.
- **Pull the next thing** with `Ctrl-a u`. It takes the top item from your first non-empty stage and does the whole ticket-to-worktree-to-agent dance. The daily ritual is one keystroke.
- **Capture without losing your place** — `Ctrl-a a` files a Linear issue from wherever you are. `Enter` files it and returns you; `Ctrl-S` files it *and* starts work on it.
- **Status updates as a byproduct.** Optionally move an issue along when you start a session on it, when an MR appears on its branch, and when that MR merges — with `TRA-123 → QA  ^a Z undo` in the toolbar for twenty seconds. All of it defaults to off: **jmux never writes to your tracker until you say so.**

<details>
<summary><b>Setup</b> — one screen, <code>Ctrl-a W</code></summary>

Everything above is configured on one screen. It's two blocks: your panel tabs, then a table of every status your tracker offers.

```
Workflow                             Linear · 25 statuses · 8 unmapped

  Your workflow ──────────────────────────────────────────────────────
    Urgent ··································· 1st up next  2 statuses
    To do ···································· 2nd up next  3 statuses
    In Progress ··········································· 3 statuses
    Waiting ···························· no unstarted  ⏸ 8  8 statuses
    Done ············································ hidden  1 status
    + New stage

  Statuses ───────────────────────────────────────────────────────────
    Status                     Stage                     Parks  Issues
    Customer Escalation        Urgent                                2
    Ready for Development      To do                                 5
    In Code Review             Waiting                   ⏸           7
    Awaiting QA Sign-off       Waiting                   ⏸          19
    Backlog                    —                                     5

  Unstarted work ─────────────────────────────────────────────────────
    Show unstarted work in the sidebar ··············· ◂ 3 per stage ▸

  Awaiting QA Sign-off · 19 issues · Waiting · parks its sessions (3 now)
  ↑↓ move · ↵ stage · space parks · d remove · ⇧↑↓ order · esc close
```

Two blocks: your stages, then a table of every status your tracker offers. Each status has exactly two settings — which stage it belongs to (`Enter`) and whether it parks (`space`) — and they're independent, so a status can park while belonging to no stage at all. The line above the keys tells you what the selected row will actually do, including when it will do nothing.

Each **stage** carries two more: `s` shows or hides it in the sidebar, `space` shows or hides its unstarted work there. A row only mentions either when it's off its default, which is why most say nothing. Hiding a stage hides its heading, never its sessions — those fall to the flat list at the bottom, because no setting here should be able to make an agent that's waiting on you disappear.

Full guide: [docs/issue-tracking.md](docs/issue-tracking.md).
</details>

<details>
<summary><b>Setup</b> — Linear + GitLab / GitHub / GitHub Enterprise</summary>

```jsonc
// ~/.config/jmux/config.json
{
  "adapters": {
    "codeHost": { "type": "gitlab" },      // or "github"
    "issueTracker": { "type": "linear" }
  }
}
```

- **GitLab** — set `$LINEAR_API_KEY` and `$GITLAB_TOKEN`.
- **GitHub** — set `$LINEAR_API_KEY` and `$GH_TOKEN` (or `$GITHUB_TOKEN`; falls back to `gh auth token`). Token needs `repo` scope for PRs, check runs, reviews, and branch protection.
- **GitHub Enterprise** — add `"url": "https://github.mycompany.com/api/v3"` to the `github` adapter, or set `$GITHUB_ENTERPRISE_URL`.

Full guide: [docs/issue-tracking.md](docs/issue-tracking.md).
</details>

### Agents that command agents

`jmux ctl` is a JSON API that lets an agent manage sibling sessions, windows, and panes — so one agent can dispatch, monitor, and chain others without a human in the loop.

```bash
# Spin up a session and launch Claude Code with a task
jmux ctl run-claude --name fix-auth --dir /repo --message "Fix the auth bug in src/auth.ts"

# Check whether it finished (attention flag = needs review)
jmux ctl session info --target fix-auth | jq .attention

# Send a follow-up prompt to a running agent
jmux ctl pane send-keys --target %12 "Now add tests for that fix"
```

jmux ships a [Claude Code skill](skills/jmux-control.md) that agents auto-discover inside jmux sessions — fan out parallel agents, poll for completion, capture output, and chain tasks. Run `jmux ctl --help` for the full command surface.

### It's real tmux. Bring everything.

jmux wraps a real tmux process — it doesn't replace it. Your `~/.tmux.conf`, prefix key, plugins, theme, and custom bindings all carry over. Only a small set of core settings are enforced.

jmux paints its own sidebar, toolbar, and rounded window chrome — and it **fully adapts to your terminal's color scheme**. Every glyph and surface is drawn from your terminal's own palette, so jmux inherits whatever theme you already run and looks native in **light or dark**, with no config. Tune the state colors, adapters, and pane widths from the settings screen (`Ctrl-a I`).

![jmux in a dark terminal theme showing the sidebar, window tabs, and a Claude Code session](docs/screenshots/theme-dark.webp)

![jmux in a light terminal theme showing the same session, its chrome adapting to the palette](docs/screenshots/theme-light.webp)

Use any editor. Any Git tool. Any AI agent. Any shell. No Electron. No proprietary runtime. **If it runs tmux, it runs jmux.**

### Screenshots render in the terminal

A screenshot pasted into a Linear issue or a GitHub comment shows up as an **actual picture** in the info panel — not a link you have to leave the terminal to follow. jmux draws it with the kitty graphics protocol, which works in Ghostty, kitty, WezTerm and Konsole.

It works because jmux is the outermost program on your terminal: tmux runs inside a pty jmux owns, so nothing has to be passed through a multiplexer. Nothing to turn on — jmux asks your terminal whether it can draw and believes the answer. Where it can't, images stay the clickable links they always were. Clicking a rendered image still opens it.

See [Images in issue previews](docs/issue-tracking.md#images-in-issue-previews).

### Also included

- **Command palette** (`Ctrl-a p`) — fuzzy-search sessions, windows, pane actions, settings, and issue/MR commands. ([screenshot](docs/screenshots/command-palette.webp))
- **Diff panel zoom** (`Ctrl-a z`) — blow the diff up to full-screen; the sidebar stays for session switching. ([screenshot](docs/screenshots/diff-panel-full.webp))
- **Settings screen** (`Ctrl-a I`) — themes and state colors, code-host/issue-tracker adapters, per-repo defaults. `Ctrl-a i` is a shorter palette of one-shot toggles. ([screenshot](docs/screenshots/settings.webp))
- **Workflow screen** (`Ctrl-a W`) — define your own workflow stages, then map every tracker status onto one in a single table.

---

## Reference

### Keybinding essentials

| Key | Action |
|-----|--------|
| `Ctrl-Shift-Up/Down` | Switch to prev/next session |
| `Ctrl-a n` | New session / worktree |
| `Ctrl-a p` | Command palette |
| `Ctrl-a g` | Toggle info panel (Diff / Issues / MRs / Review) |
| `Ctrl-a a` | Capture a new issue (`Ctrl-S` files it *and* starts work) |
| `Ctrl-a u` | Start the next issue from your stage rotation |
| `Ctrl-a W` | Workflow screen — your stages, their statuses, parking |
| `Ctrl-a \|` / `Ctrl-a -` | Split pane horizontal / vertical |
| `Ctrl-a z` | Zoom pane or diff panel |

**Full keybinding reference → [docs/cheat-sheet.md](docs/cheat-sheet.md)**

### Configuration

jmux layers tmux config in three tiers — jmux defaults, then your `~/.tmux.conf`, then the small set of settings jmux requires. jmux's own settings live in `~/.config/jmux/config.json`. Full guide: **[docs/configuration.md](docs/configuration.md)**.

### Architecture

jmux drives a real tmux process over two channels (an interactive PTY client and a control-mode client) and composites its own sidebar and toolbar around the output. The full design — the two-channel model, rendering pipeline, and adapters — is in **[docs/architecture.md](docs/architecture.md)**.

### Built with

[hunk](https://github.com/modem-dev/hunk) (diff viewer), [lazygit](https://github.com/jesseduffield/lazygit), [gh](https://cli.github.com/) / [glab](https://gitlab.com/gitlab-org/cli). Run any of them in a pane alongside your agent.

---

## License

[AGPL-3.0](LICENSE)
