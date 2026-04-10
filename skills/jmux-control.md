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
| `jmux ctl session info --target NAME` | Session details + attention flag |
| `jmux ctl session kill --target NAME` | Kill a session |
| `jmux ctl session rename --target NAME --name NEW` | Rename a session |
| `jmux ctl session switch --target NAME` | Switch to a session |
| `jmux ctl session set-attention --target NAME` | Flag for human review |
| `jmux ctl session set-attention --target NAME --clear` | Clear attention flag |
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

4. **Check attention, don't poll capture.** Use `jmux ctl session info --target NAME`
   and check the `attention` field to know when a Claude instance finished.
   Only use `pane capture` when you need the actual screen content.

5. **Parse JSON.** All output is structured JSON. Don't regex it.

## Patterns

### Fan-Out: Dispatch N agents for independent tasks

```bash
# Spawn agents
result1=$(jmux ctl run-claude --name task-auth --dir /repo --message "Fix auth bug in src/auth.ts")
result2=$(jmux ctl run-claude --name task-tests --dir /repo --message "Add tests for src/utils.ts")

# Extract session names from JSON
session1=$(echo "$result1" | jq -r .session)
session2=$(echo "$result2" | jq -r .session)

# Monitor — poll attention flags
while true; do
  info1=$(jmux ctl session info --target "$session1")
  info2=$(jmux ctl session info --target "$session2")
  attn1=$(echo "$info1" | jq .attention)
  attn2=$(echo "$info2" | jq .attention)
  if [ "$attn1" = "true" ] && [ "$attn2" = "true" ]; then
    echo "Both agents finished"
    break
  fi
  sleep 10
done
```

### Pipeline: Chain agents sequentially

```bash
# Step 1: dispatch first agent
result=$(jmux ctl run-claude --name analyze --dir /repo --message "Analyze the auth module and write findings to /tmp/analysis.md")
session=$(echo "$result" | jq -r .session)
pane=$(echo "$result" | jq -r .pane)

# Step 2: wait for completion
while true; do
  info=$(jmux ctl session info --target "$session")
  if [ "$(echo "$info" | jq .attention)" = "true" ]; then break; fi
  sleep 10
done

# Step 3: read output, feed to next agent
output=$(jmux ctl pane capture --target "$pane" --lines 50)
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
{"sessions": [{"id": "$1", "name": "my-project", "windows": 3, "attached": true, "activity": 1712678400, "attention": false, "path": "/path/to/project"}]}
```

### session create / run-claude
```json
{"session": "fix-auth-bug", "pane": "%12", "claude_command": "claude", "command_dispatched": true}
```

### session info
```json
{"id": "$1", "name": "my-project", "windows": 2, "attached": true, "attention": true, "path": "/path", "windows_detail": [{"id": "@1", "index": 0, "name": "claude", "active": true, "zoomed": false, "bell": false}]}
```

### pane capture
```json
{"target": "%8", "content": "$ claude\n\nHello! How can I help?\n\n> "}
```

## Limitations

- No real-time streaming — use polling with `session info` and `pane capture`
- `session switch` only works from inside tmux (not from external processes)
- `pane capture` is a point-in-time snapshot, not live output
- `run-claude` confirms the command was dispatched, not that Claude actually started — use `pane capture` to verify
- The CLI does not manage tmux config, keybindings, or display settings
- Worktree creation is not supported via CLI — use `session create` with plain directories
