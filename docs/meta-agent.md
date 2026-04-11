# Meta Agent

The meta agent is a workflow copilot that runs inside jmux as a dedicated AI coding tool session. It manages the development lifecycle — picking up tickets, creating worktrees and sessions, dispatching agents, and tracking work items — using `jmux ctl` commands.

## Quick Start

```bash
# Inside jmux, press Ctrl-a m
# The agent launches and asks "What should I work on?"
# Tell it to pick up a ticket:
> Pick up MYAPP-123
```

The agent will:
1. Query your issue tracker (e.g. Linear via MCP) for the ticket details
2. Match the ticket to a project using `.jmux/workflow.yml` configs
3. Create a worktree and session via `jmux ctl session create --worktree`
4. Dispatch Claude Code with the ticket description via `jmux ctl run-claude`
5. Track the work item via `jmux ctl task create`

## How It Works

When you press `Ctrl-a m`:

1. **First time:** jmux creates `~/.config/jmux/agent/` with an instruction file (e.g. `CLAUDE.md`) that teaches the agent how to use `jmux ctl` commands, read workflow configs, and manage tasks. Your configured AI tool launches in a new tmux session.

2. **Subsequent times:** jmux switches to the existing `jmux-agent` session.

The agent session appears at the top of the sidebar with a distinctive `◈ Agent` label and "command & control" subtitle.

## Configuration

In `~/.config/jmux/config.json`:

```json
{
  "agent": {
    "command": "claude --dangerously-skip-permissions",
    "configFile": "CLAUDE.md",
    "kickoffPrompt": "What should I work on?"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `command` | `claudeCommand` then `"claude"` | AI tool to launch |
| `configFile` | `"CLAUDE.md"` | Instruction filename (`"AGENTS.md"` for Codex/OpenCode) |
| `kickoffPrompt` | `"What should I work on?"` | Message sent on first launch. `false` to disable |

### Using Different AI Tools

The meta agent works with any AI coding tool that reads a project-level instruction file:

```json
// Claude Code (default)
{ "agent": { "command": "claude" } }

// Codex
{ "agent": { "command": "codex", "configFile": "AGENTS.md" } }

// OpenCode
{ "agent": { "command": "opencode", "configFile": "AGENTS.md" } }

// Custom command with flags
{ "agent": { "command": "claude --dangerously-skip-permissions --verbose" } }
```

## Task Registry

The meta agent tracks work items in `~/.config/jmux/tasks.json` via `jmux ctl task`:

```bash
# Register a new work item
jmux ctl task create --ticket MYAPP-123 --source linear --title "Fix auth" --project myapp

# List all tracked tasks
jmux ctl task list

# Update task state
jmux ctl task update --ticket MYAPP-123 --status in_progress --session myapp-123

# Add an MR
jmux ctl task update --ticket MYAPP-123 --mr https://gitlab.com/.../merge_requests/42

# Remove a completed task
jmux ctl task remove --ticket MYAPP-123
```

### Status Values

| Status | Meaning |
|--------|---------|
| `pickup` | Ticket registered, session not yet created |
| `in_progress` | Session created, agent working |
| `review` | MR submitted, awaiting review |
| `merged` | MR merged |
| `closed` | Work complete, ready for cleanup |

Sessions linked to tasks show the ticket ID in blue on the sidebar detail line.

## Workflow Configs

Per-project `.jmux/workflow.yml` files teach the meta agent how to handle tickets for that repo:

```yaml
project: myapp
description: "Main web application"

tickets:
  linear:
    team: "Engineering"
    projects: ["MYAPP"]

setup:
  worktree: true
  base_branch: origin/main
  naming: lowercase-ticket-id

agent:
  context: |
    This project uses Rails + React. Run bin/setup if dependencies are stale.
  instructions: |
    When done, create an MR targeting main.

merge_request:
  target_branch: main
```

### Key Fields

- **`tickets.linear.projects`** — match tickets by project prefix (MYAPP-123 → MYAPP)
- **`tickets.linear.team`** — match tickets by Linear team name
- **`setup.worktree`** — `true` to create a git worktree, `false` for a plain session
- **`setup.base_branch`** — branch to base worktrees on
- **`agent.context`** — prepended to the ticket description in the agent prompt
- **`agent.instructions`** — appended after the ticket description

### Ticket Matching

When the meta agent receives "pick up MYAPP-123", it:
1. Extracts the prefix `MYAPP`
2. Scans workflow configs for `tickets.linear.projects` containing `MYAPP`
3. Uses that project's setup and agent config

If no workflow config matches, the agent asks the user where the ticket should go.

## Session Worktrees

`jmux ctl session create` supports worktree creation:

```bash
# Create a session with a git worktree
jmux ctl session create --name myapp-123 --dir /path/to/repo --worktree --base-branch origin/main

# Creates:
# 1. Git worktree at /path/to/repo/myapp-123
# 2. tmux session "myapp-123" pointed at the worktree
```

The meta agent uses this automatically based on the workflow config's `setup.worktree` field.
