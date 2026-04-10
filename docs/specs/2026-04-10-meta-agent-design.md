# Meta Agent Design

A persistent workflow copilot for jmux that manages the development lifecycle: picking up tickets, creating worktrees and sessions, dispatching agents, and tracking work items through to merge.

## Problem

jmux gives users powerful multi-session orchestration and agent control via `jmux ctl`. But the day-to-day development workflow — pick up a Linear ticket, create a worktree, spin up a session, seed Claude with context, create an MR, track review, clean up — is still manual and repetitive. Each step requires the user to context-switch between Linear, the terminal, git, and jmux.

## Solution

Three new capabilities that compose into an automated workflow:

1. **Task registry** — jmux tracks the relationship between tickets, sessions, worktrees, and MRs in a global state file
2. **Tool panel** — the existing diff panel generalizes into a tabbed panel hosting multiple tools
3. **Meta agent** — a Claude Code subprocess running in the tool panel that reads workflow configs, drives `jmux ctl`, and talks to external services via MCP

## Approach: Vertical Slice

Build one complete flow end to end: **"pick up a Linear ticket → create worktree/session → dispatch Claude with ticket context."** Implement just enough of each layer to make that single flow work, then widen.

---

## Task Registry

### Storage

Global JSON file at `~/.config/jmux/tasks.json`. Not per-project — avoids polluting repo file trees.

### Schema

```jsonc
{
  "tasks": {
    "MYAPP-123": {
      "source": "linear",
      "externalId": "uuid-from-linear",
      "url": "https://linear.app/team/MYAPP-123",
      "title": "Fix auth token refresh",
      "session": "myapp-123",        // jmux session name, null if not yet created
      "worktree": "/path/to/worktree", // null if standard session
      "project": "myapp",            // which project/repo
      "mrs": [
        { "url": "https://gitlab.com/.../merge_requests/42", "state": "open" }
      ],
      "status": "in_progress",       // pickup | in_progress | review | merged | closed
      "createdAt": "2026-04-10T00:00:00Z",
      "updatedAt": "2026-04-10T00:00:00Z"
    }
  }
}
```

The registry is **issue-tracker agnostic**. The `source` field is a discriminator (`"linear"`, `"github"`, etc.), but jmux doesn't call any external API — that's the meta agent's job via MCP. jmux only stores the mapping.

### CLI: `jmux ctl task`

New subcommand group. All output is JSON to stdout, consistent with existing `ctl` conventions.

| Command | Purpose |
|---------|---------|
| `task create --ticket ID --source TYPE [--title TEXT] [--session NAME] [--project NAME]` | Register a new task |
| `task list` | List all tasks |
| `task get --ticket ID` | Get a single task |
| `task update --ticket ID [--status S] [--session NAME] [--mr URL] [--mr-state STATE]` | Update task fields |
| `task remove --ticket ID` | Remove a task from the registry |

### Extended: `jmux ctl session create --worktree`

The existing `session create` command gains a `--worktree` flag:

```
jmux ctl session create --name myapp-123 --dir /path/to/repo --worktree --base-branch origin/main
```

This runs `git worktree add` directly (not `wtm create`, which is an optional dependency suited to the interactive modal path, not a programmatic CLI), creates a tmux session pointed at the new worktree, and applies `sanitizeTmuxSessionName` to keep the session name and worktree directory in sync. jmux already has worktree-aware logic (sidebar grouping, `sanitizeTmuxSessionName` at `main.ts:1217`), and this extension ensures the naming conventions are enforced by jmux rather than relying on agents to replicate them via raw shell commands.

Cleanup also becomes jmux's responsibility: `session kill` for a worktree-linked session can remove the worktree on disk (with a `--cleanup` flag or as default behavior).

### Sidebar integration

Task-linked sessions show the ticket ID alongside the session name in the sidebar. For the vertical slice, this is a display-only enhancement — the sidebar reads `tasks.json` and matches on the `session` field.

---

## Tool Panel

### Wrapping the diff panel — not refactoring it

The existing diff panel system works. Its wiring (~200+ lines across `main.ts` for subprocess lifecycle, ScreenBridge management, focus state, resize handling, input routing) stays where it is. The tool panel is a **new layer** that wraps the existing diff panel and also hosts the agent tab.

The panel container does not use a generic tool interface. With only two tabs, an abstraction would be premature — it would be so generic it wouldn't constrain or help either implementation. The container knows about its two specific tabs directly and switches between them. A `PanelTool` interface can be extracted when a third tool appears and the actual shared surface is visible.

### Panel structure

```
┌─ Tool Panel ──────────────────────────┐
│ [Diff] [Agent]            ← tab bar   │
├───────────────────────────────────────┤
│                                       │
│  (active tab's content)               │
│                                       │
└───────────────────────────────────────┘
```

### What the container owns

- **Tab bar rendering** — one row at the top, highlights active tab
- **Active tab state** — which tab is showing (diff or agent)
- **Input routing** — delegates input to the active tab's handler
- **Focus management** — delegates focus/blur to the active tab
- **Show/hide** — panel visibility toggle (existing behavior, preserved)

### What the container does NOT own

- Diff panel internals — subprocess lifecycle, ScreenBridge, zoom mode stay in `main.ts`
- Agent tab internals — Claude Code spawning, chat rendering, input editing are in `agent-tab.ts`

The diff tab is the existing code, called through by the container. The agent tab is new code, called through by the container. Neither needs to conform to a shared interface beyond what the container calls directly.

### Hotkeys

- Existing diff panel toggle still works, opens panel to last-active tab
- New hotkey to open panel directly to the agent tab
- Tab switching within the panel via key chord

### Rendering

The tab bar consumes one row from the top of the panel. The active tab gets the remaining height. Inactive tabs retain state but don't render (diff viewer keeps scroll position across tab switches).

---

## Meta Agent

### Spawn-per-message model

Claude Code's `--output-format stream-json -p "prompt"` is one-shot: single prompt in, streaming response out, process exits. There is no multi-turn stdin mode. The agent tab embraces this by spawning a **new subprocess for each user message**.

Each invocation receives a fresh system prompt assembled from:
1. The meta agent skill — a playbook teaching workflow patterns and `ctl task` commands
2. All discovered `.jmux/workflow.yml` configs from project directories
3. A snapshot of `tasks.json` — current state of tracked work
4. Current jmux session state via `jmux ctl session list` output
5. A scrollback summary — the last N user/assistant exchanges from the current panel session, so the agent has conversational continuity

**Prompt size budget:** A busy user with multiple workflow configs, several active tasks, and a conversation history could easily push the assembled prompt to 15-20K tokens before their actual message. The implementation must enforce a budget:
- Scrollback is the primary knob — summarize or truncate older exchanges first
- Task snapshot: only include active tasks (status `in_progress` or `review`), not closed/merged
- Workflow configs: only include configs for projects with active tasks, not all discovered configs
- Target: keep the assembled context under ~8K tokens, leaving headroom for the user message and Claude's response

This is the right model, not a compromise. Benefits:
- **No stale context** — each invocation gets the latest task and session state
- **No zombie subprocesses** — the process exits cleanly after each response
- **Simple error recovery** — if a spawn fails, the user just sends another message
- **Ephemeral by design** — state survives via the task registry, not the conversation

**Command:** `claude --output-format stream-json -p "<assembled prompt + user message>"`

**Spawning:** Lazy — only when the user sends a message in the agent tab.

### Agent tab UI

The agent tab is a chat interface rendered into a `CellGrid` region. Three zones:

```
┌─────────────────────────────────┐
│  scrollback                     │  ← message history (scrollable)
│  user: "Pick up MYAPP-123"      │
│  agent: "Creating worktree..."  │
│  [tool: jmux ctl task create]   │
│  agent: "Session myapp-123..."  │
│                                 │
├─────────────────────────────────┤
│  ▸ type a message...            │  ← input line (single line, bottom)
└─────────────────────────────────┘
```

**Input:** A single-line editor pinned to the bottom of the panel. Supports cursor movement (left/right, home/end), backspace/delete, and Enter to submit. No multi-line — if the user needs a longer message, they type naturally and the line scrolls horizontally. History (up/down to recall previous messages) is a nice-to-have, not required for the vertical slice.

**Scrollback:** A buffer of past message pairs (user message + agent response). Scrollable via Shift+Up/Down or mouse wheel when the panel is focused. The buffer retains all messages from the current jmux session. No persistence across restarts — the task registry is the durable state.

**Tool use display:** When the agent runs tools (bash commands, MCP calls), show a collapsed one-line indicator: `[tool: jmux ctl task create --ticket MYAPP-123]`. No expanding, no output display — the user can check results via the sidebar or by reading `tasks.json`. This keeps the chat area clean.

**Streaming:** As `stream-json` tokens arrive, the agent tab appends to the current response and triggers `scheduleRender()`. No special frame coalescing needed — it piggybacks on jmux's existing ~60fps render loop. While streaming, the input line shows a spinner or "thinking..." indicator and rejects new input.

**Narrow panels:** The chat wraps text at the panel width. At very narrow widths (< 30 cols), the agent tab is usable but cramped — same tradeoff the sidebar already makes.

### What the agent can do

All interaction with jmux is through `ctl`:
- `jmux ctl task create/update/list/get/remove` — manage the task registry
- `jmux ctl session create` — create sessions with worktrees
- `jmux ctl run-claude` — dispatch Claude Code in child sessions
- `jmux ctl session list` — read current state

All interaction with external services is through Claude Code's existing tools:
- Linear MCP — read tickets, check MR status
- GitHub/GitLab MCP or CLI — create MRs (future, not in vertical slice)
- File tools — read `.jmux/workflow.yml` from repos
- Bash — anything else

jmux does not need to understand Linear, GitLab, or any external service. The meta agent does, through Claude Code's MCP ecosystem.

---

## Workflow Config

### Location and discovery

`.jmux/workflow.yml` lives in project repos. The meta agent discovers them by scanning directories listed in jmux's `projectDirs` config.

### Schema

```yaml
project: myapp
description: "Main web application"

# Which tickets belong here — used for matching
tickets:
  linear:
    team: "Engineering"          # match by Linear team name
    projects: ["MYAPP"]          # match by project prefix

# How to set up a session
setup:
  worktree: true                 # create a git worktree (vs plain session)
  base_branch: "origin/main"    # worktree base branch
  naming: "lowercase-ticket-id"  # hint for the meta agent, not a literal value

# Context for the dispatched Claude agent
agent:
  # Prepended before the Linear ticket description
  context: |
    This project uses Rails + React. Run `bin/setup` if dependencies are stale.
  # Appended after the ticket description
  instructions: |
    When done, create an MR and run:
    jmux ctl task update --ticket <TICKET_ID> --mr <url> --status review
  skill: "jmux-control"

# MR conventions
merge_request:
  target_branch: "main"
```

### No template engine

The workflow config is **plain data** — flags, strings, and lists. No `{{variable}}` syntax, no filters, no interpolation. The meta agent is an LLM; it reads the config, reads the ticket data, and composes session names, prompts, and MR titles itself. The meta agent skill teaches it how to interpret fields like `naming: "lowercase-ticket-id"` and assemble prompts from `agent.context` + ticket description + `agent.instructions`.

This avoids introducing a mini-language that jmux needs to parse and the skill needs to document. If structured templating becomes necessary later, real usage patterns will inform the syntax.

### Prompt assembly

The dispatched child agent receives a prompt composed by the meta agent from:
1. `agent.context` from workflow config (project-specific setup notes)
2. The Linear ticket description (the actual task — Linear provides the prompt)
3. `agent.instructions` from workflow config (post-completion steps)

The meta agent handles the composition — it reads these fields and the ticket data, then writes the assembled prompt to a temp file for `jmux ctl run-claude --message-file`.

Both `context` and `instructions` are optional. A minimal workflow config only needs ticket routing:

```yaml
project: myapp
tickets:
  linear:
    projects: ["MYAPP"]
```

### Workflow setup skill

A separate Claude Code skill (not the meta agent skill) that helps users generate `.jmux/workflow.yml` for a project. It asks about the project's issue tracker, branching conventions, MR target, and agent setup notes, then writes the file.

---

## Meta Agent Skill

A Claude Code skill loaded into the meta agent subprocess. It teaches:

- How to use `jmux ctl task` commands to manage the registry
- How to read and interpret `.jmux/workflow.yml` files
- The workflow patterns: ticket pickup, session creation, agent dispatch
- How to assemble prompts from workflow config + ticket data
- How to check jmux state via `jmux ctl session list` and `jmux ctl task list`
- Convention: always update the task registry when state changes

This is the "senior engineer's playbook." The workflow config defines *what* to do per project; the skill teaches *how* to execute any workflow.

---

## Vertical Slice: End to End Flow

User opens the agent panel and types: **"Pick up MYAPP-123"**

1. Meta agent reads `tasks.json` — confirms MYAPP-123 is not already tracked
2. Meta agent queries Linear (via MCP) — gets ticket title, description, project
3. Meta agent matches project — scans workflow configs, finds the one where `tickets.linear.projects` includes "MYAPP", resolves to the repo path
4. Meta agent creates the task — `jmux ctl task create --ticket MYAPP-123 --source linear --title "Fix auth token refresh" --project myapp`
5. Meta agent creates the session — `jmux ctl session create --name myapp-123 --dir /path/to/repo --worktree --base-branch origin/main` (or without `--worktree` if `setup.worktree` is false)
6. Meta agent dispatches Claude — assembles prompt from workflow config + Linear ticket, runs `jmux ctl run-claude --name myapp-123 --message-file <prompt>`
7. Meta agent updates the task — `jmux ctl task update --ticket MYAPP-123 --session myapp-123 --status in_progress`
8. User sees a new session in the sidebar linked to MYAPP-123 with Claude working

---

## What's NOT in the vertical slice

These are future work, built by widening from the vertical slice foundation:

- **MR lifecycle** — creating MRs, monitoring review comments, merging
- **Session restore on startup** — recreating sessions from `tasks.json` after jmux restart
- **Multi-ticket operations** — "pick up the next 3 tickets from the sprint"
- **Status sync** — polling Linear for ticket/MR state changes
- **Cleanup automation** — "close MYAPP-123" triggering merge + worktree delete + session kill
- **Task dashboard** — a panel tab showing all tracked tasks and their status
- **Non-Linear issue trackers** — GitHub Issues, Jira, etc. (the registry schema supports it, the workflow config and MCP integrations need extending)

---

## Files touched

| File | Change |
|------|--------|
| `src/cli/task.ts` | New — `jmux ctl task` subcommands |
| `src/cli/session.ts` | Add `--worktree` and `--base-branch` flags to `session create` |
| `src/cli/cli.ts` | Add `task` group to command dispatch |
| `src/task-registry.ts` | New — read/write `tasks.json`, task schema types |
| `src/tool-panel.ts` | New — panel container with tab bar, wraps diff panel + agent tab |
| `src/agent-tab.ts` | New — Claude Code subprocess management, chat rendering, input line |
| `src/main.ts` | Wire up tool panel container, agent tab hotkeys, sidebar task display |
| `src/sidebar.ts` | Render ticket ID for task-linked sessions |
| `src/input-router.ts` | Route input to tool panel tab bar |
| `skills/jmux-meta-agent.md` | New — meta agent playbook skill |
| `skills/jmux-workflow-setup.md` | New — skill for generating `.jmux/workflow.yml` |
