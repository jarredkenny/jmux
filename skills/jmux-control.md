---
name: jmux-control
description: Control jmux sessions, windows, and panes programmatically. Dispatch Claude Code instances, monitor their progress, and interact with them. Use when inside a jmux-managed tmux session ($JMUX=1).
---

# jmux Agent Control

You are inside a jmux-managed tmux session. You can create sibling sessions,
dispatch other Claude Code instances, monitor their progress, and interact
with them using the `jmux ctl` CLI.

All commands output JSON to stdout. Errors output JSON to stderr.

## Detection

Check `$JMUX` — if it's `1`, you're inside jmux and these commands work.
If not set, you're outside jmux and most commands require explicit `--session` flags.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `jmux ctl session list` | List all sessions |
| `jmux ctl session create --name N --dir PATH` | Create new session |
| `jmux ctl session info --target NAME` | Session details |
| `jmux ctl session kill --target NAME` | Kill a session |
| `jmux ctl session rename --target NAME --name NEW` | Rename a session |
| `jmux ctl session switch --target NAME` | Switch to a session |
| `jmux ctl run-claude --name N --dir PATH --message "..."` | Launch Claude Code |
| `jmux ctl window list` | List windows in current session |
| `jmux ctl window create` | Create new window |
| `jmux ctl window select --target @ID` | Switch to a window |
| `jmux ctl window kill --target @ID` | Kill a window |
| `jmux ctl pane list` | List panes in current window |
| `jmux ctl pane split --direction h` | Split pane horizontally |
| `jmux ctl pane split --direction v` | Split pane vertically |
| `jmux ctl pane send-keys --target %ID text here` | Type into a pane |
| `jmux ctl pane capture --target %ID` | Read pane contents |
| `jmux ctl pane kill --target %ID` | Kill a pane |
| `jmux ctl status` | One-shot snapshot of the whole workspace |
| `jmux ctl agent state [--session N] [--all]` | Structured agent state (running/waiting/complete) |
| `jmux ctl agent watch [--session N] [--all]` | Stream agent state changes as JSONL |
| `jmux ctl session attention set --target N [--reason "..."]` | Flag a session as needing the human |
| `jmux ctl session attention clear --target N` | Clear the attention flag |
| `jmux ctl issue start <issue-id> [--repo P]` | Start (or resume) work for an issue |
| `jmux ctl issue get <issue-id>` | Fetch issue details from the tracker |
| `jmux ctl issue link <session> <issue-id>` | Link a session to an issue |
| `jmux ctl issue unlink <session>` | Remove a session's issue link |

## Global Flags

| Flag | Description |
|------|-------------|
| `--session NAME` | Target session (default: current session from env) |
| `--socket NAME` / `-L NAME` | tmux server socket (default: from `$TMUX`) |

## Conventions

1. **Use returned names.** Session names are sanitized (`.` and `:` become `_`).
   Always use the `name` field from the JSON response, not your original input.

2. **Use IDs from responses.** Capture `id`, `pane`, `window` fields from
   create/list responses and pass them as `--target` in later commands.

3. **Don't kill what you didn't create.** Only kill sessions/panes you spawned.
   Kill commands refuse to destroy your own session/pane without `--force`.

4. **Prefer structured state over pane scraping.** To know whether an agent is
   working, waiting for permission, or done, read `jmux ctl agent state` or
   `jmux ctl status` — never grep `pane capture` output for a shell prompt.
   Reach for `pane capture` only when you need the actual screen *text* (e.g. to
   read what an agent wrote), not to infer lifecycle.

5. **Parse JSON.** All output is structured JSON. Don't regex it.

## Orchestration

These commands expose jmux's higher-level work model so an orchestrator can
dispatch, monitor, and clean up work **without scraping panes**. All read
directly from tmux, so they work whether or not the jmux TUI is running (pass
`--socket`/`-L` when outside a session).

### `status` — one snapshot of the whole workspace

A single cheap command that answers "what work exists and what needs me?":

```bash
jmux ctl status
```

Each session reports its agent state, linked issue/MR, branch, attention flag,
and pinned state. This is the right command for a heartbeat / work-radar loop.

### `agent state` — is the agent running, waiting, or complete?

```bash
jmux ctl agent state --session TRA-123   # one session
jmux ctl agent state --all               # every session (default with no flag)
```

State comes from the same source the sidebar uses — the `@jmux-agent-state`
tmux option set by Claude Code's hooks — so it reflects lifecycle exactly:

- `running` — the agent is actively working.
- `waiting` — the agent is blocked on a permission prompt (needs input).
- `complete` — the agent finished its turn.
- `null` — no agent (e.g. a plain shell), or hooks not installed.

`ageSeconds` tells you how long it's been in that state — useful for spotting a
stale/stuck session (e.g. `running` for an implausibly long time).

### `agent watch` — react to transitions without a poll loop

```bash
jmux ctl agent watch --session TRA-123    # stream one session
jmux ctl agent watch --all                # stream all sessions
```

Emits one JSON object **per line** (JSONL) on every state change, until you
SIGINT it. Use it instead of a `pane capture` polling loop:

```bash
jmux ctl agent watch --session TRA-123 | while read -r event; do
  state=$(echo "$event" | jq -r .state)
  case "$state" in
    waiting)  echo "Agent needs permission" ;;
    complete) echo "Agent done"; break ;;
  esac
done
```

### Attention — flag a session for the human

Mark a session as needing Jarred **only** when there's a real decision: a
blocker, a failed verification, a permission wait, or a review gate.

```bash
jmux ctl session attention set --target TRA-123 --reason "tests fail; needs a call"
jmux ctl session attention clear --target TRA-123
```

The flag and reason surface in `jmux ctl status` (`attention` / `attentionReason`).

## Patterns

### Fan-Out: Dispatch N agents and wait on structured state

```bash
# Spawn agents
result1=$(jmux ctl run-claude --name task-auth --dir /repo --message "Fix auth bug in src/auth.ts")
result2=$(jmux ctl run-claude --name task-tests --dir /repo --message "Add tests for src/utils.ts")
session1=$(echo "$result1" | jq -r .session)
session2=$(echo "$result2" | jq -r .session)

# Monitor via agent state — no pane scraping
while true; do
  states=$(jmux ctl agent state --all | jq -r \
    --arg a "$session1" --arg b "$session2" \
    '.agents[] | select(.session==$a or .session==$b) | .state')
  if ! echo "$states" | grep -qv complete; then
    echo "Both agents finished"
    break
  fi
  sleep 5
done
```

### Pipeline: Chain agents sequentially

```bash
# Step 1: dispatch first agent
result=$(jmux ctl run-claude --name analyze --dir /repo --message "Analyze the auth module and write findings to /tmp/analysis.md")
session=$(echo "$result" | jq -r .session)

# Step 2: block until it completes, reacting to the JSONL stream
jmux ctl agent watch --session "$session" | while read -r event; do
  [ "$(echo "$event" | jq -r .state)" = "complete" ] && break
done

# Step 3: feed its output to the next agent
jmux ctl run-claude --name refactor --dir /repo --message-file /tmp/analysis.md
```

### Interact: Send follow-up to a running agent

```bash
# Send a follow-up prompt (Enter is sent by default)
jmux ctl pane send-keys --target %12 "Now refactor the auth middleware"

# Send without pressing Enter (build up partial input)
jmux ctl pane send-keys --target %12 --no-enter "partial text"

# Send multiline content from a file
jmux ctl pane send-keys --target %12 --file /tmp/instructions.md
```

### Monitor: Check what's on screen

```bash
# Capture visible pane content (plain text, ANSI stripped)
jmux ctl pane capture --target %12

# Include scrollback (up to 1000 lines above visible)
jmux ctl pane capture --target %12 --lines 200

# Raw capture with ANSI escape codes preserved
jmux ctl pane capture --target %12 --raw
```

## Response Shapes

### session list
```json
{"sessions": [{"id": "$1", "name": "my-project", "windows": 3, "attached": true, "activity": 1712678400, "path": "/path/to/project"}]}
```

### session create / run-claude
```json
{"session": "fix-auth-bug", "pane": "%12", "claude_command": "claude", "command_dispatched": true}
```

### session info
```json
{"id": "$1", "name": "my-project", "windows": 2, "attached": true, "path": "/path", "windows_detail": [{"id": "@1", "index": 0, "name": "claude", "active": true, "zoomed": false, "bell": false}]}
```

### pane capture
```json
{"target": "%8", "content": "$ claude\n\nHello! How can I help?\n\n> "}
```

### status
```json
{
  "sessions": [
    {
      "id": "$1", "name": "TRA-123", "path": "/repo/worktree",
      "branch": "TRA-123-fix-auth",
      "agent": { "state": "running", "since": 1781480000, "ageSeconds": 123 },
      "links": [{ "type": "issue", "id": "TRA-123" }, { "type": "mr", "id": "5812" }],
      "attention": false, "attentionReason": null, "pinned": false
    }
  ]
}
```
`agent` is `null` when there's no agent in the session. `branch` is `null` if the path isn't a git repo.

### agent state
```json
{"agents": [{"session": "TRA-123", "sessionId": "$1", "state": "running", "since": 1781480000, "ageSeconds": 123, "agentPane": "%12", "activePane": "%12", "path": "/repo/worktree"}]}
```
`agentPane` is the pane actually running Claude (set by the hooks) — target it for `pane send-keys`. It is `null` if the hooks predate this option (re-run `jmux --install-agent-hooks`); fall back to `activePane`, which is the session's active pane and can drift after splits.

### agent watch (one JSON line per change)
```json
{"type": "agent_state_changed", "session": "TRA-123", "state": "waiting", "since": 1781480000}
```

### session attention set / clear
```json
{"target": "TRA-123", "attention": true, "reason": "tests fail; needs a call"}
```

### issue start
```json
{"session": "TRA-123-fix-auth", "pane": "%12", "cwd": "/repo-worktrees/TRA-123-fix-auth", "issue": "TRA-123", "reused": false}
```
`reused: true` means a session was already linked to the issue and is returned as-is (idempotent).

### issue link / unlink
```json
{"session": "TRA-123", "issue": "TRA-456", "repo": "/repo", "linked": true}
```

## Limitations

- `agent watch` streams real-time state transitions (JSONL). For raw screen *text*, `pane capture` remains a point-in-time snapshot.
- `session switch` only works from inside tmux (not from external processes).
- `run-claude` confirms the command was dispatched, not that Claude actually started — check `agent state` to confirm it began.
- The CLI does not manage tmux config, keybindings, or display settings.
- `issue get` / `issue start` need a configured tracker (`LINEAR_API_KEY` or `LINEAR_TOKEN`). `issue start` resolves the repo from `--repo` or `issueWorkflow.teamRepoMap`, creates a worktree with `git worktree add`, links it via the `@jmux-linear-issue` tmux option, and (unless `--no-launch-agent`) launches Claude with the issue context. When a tracker is configured, an issue id that doesn't resolve is rejected (no silent worktree for a typo); only with no tracker configured does `issue start` proceed offline, and only when `--repo` is given explicitly.
- `jmux ctl status` is the orchestrator's source of truth for issue/MR links. Links set via `jmux ctl issue link` / `issue start` are stored as tmux session options and always appear in `status`; a running TUI does not yet re-render them in its sidebar (it reads its own in-memory link store), so Jarred's sidebar and your `status` view can differ until a later pass teaches the TUI to read the tmux-option links.
- `session attention` survives jmux TUI restarts. (Older builds cleared `@jmux-attention` on every launch; that cleanup is now a one-time-per-tmux-server legacy migration, so orchestrator-set flags persist.)
