# Claude Code Integration

jmux supports attention flags that any tool can set on a tmux session. When a session has an attention flag, jmux shows an orange `!` indicator in the sidebar. This is designed for agentic workflows where you have multiple Claude Code instances running across sessions and need to know when one needs your input.

## Quick Setup

```bash
jmux --install-agent-hooks
```

This adds a hook to `~/.claude/settings.json` that sets the attention flag whenever Claude Code finishes a response. Done — the orange `!` will appear in your sidebar when Claude needs your attention.

## The Attention Flag

Set the `@jmux-attention` option on any tmux session:

```bash
tmux set-option -t my-session @jmux-attention 1
```

jmux picks this up in real time via a tmux subscription. The orange `!` appears immediately in the sidebar next to that session.

When you switch to the session, jmux automatically clears the flag — no manual cleanup needed.

## How the Hook Works

The `--install-agent-hooks` command adds a `Stop` hook to your Claude Code settings:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tmux set-option @jmux-attention 1 2>/dev/null || true",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The `Stop` event fires whenever Claude finishes responding. The command sets the attention flag on the current session. The `2>/dev/null || true` ensures it's silent when run outside tmux.

## Multi-Session Workflow

The typical workflow with jmux and Claude Code:

1. **Start jmux:**
   ```bash
   jmux
   ```

2. **Create sessions** for each project (`Ctrl-a n`):
   - `api` — backend service
   - `frontend` — React app
   - `infra` — terraform configs

3. **Run Claude Code** in each session on different tasks

4. **Work in one session** while others run in the background. When Claude finishes in another session, the `!` flag appears in the sidebar.

5. **Switch instantly** with `Ctrl-Shift-Down` or click the flagged session.

6. **Review Claude's work**, then move to the next flagged session.

The sidebar gives you a dashboard of all your running agents. Green dots show sessions with new output. Orange flags show sessions that explicitly need attention.

## Agent Control CLI

For programmatic workflows, `jmux ctl` provides a JSON API that agents can use to manage sessions, dispatch other agents, and monitor progress. This is the recommended way for agents to interact with jmux — it handles context resolution, session name sanitization, and safety guards automatically.

```bash
# Dispatch a Claude Code instance in a new session
jmux ctl run-claude --name fix-auth --dir /repo --message "Fix the auth bug"

# Check if an agent finished
jmux ctl session info --target fix-auth | jq .attention

# Set/clear attention programmatically
jmux ctl session set-attention --target my-session
jmux ctl session set-attention --target my-session --clear
```

jmux ships a [Claude Code skill](../skills/jmux-control.md) that agents auto-discover when `$JMUX=1` is set. The skill documents the full `jmux ctl` API including multi-agent patterns like fan-out and pipeline orchestration.

See `jmux ctl --help` for the full command reference.

## Setting Flags from Scripts

The attention flag is a standard tmux user option. Set it from anywhere — via `jmux ctl` or raw tmux commands:

```bash
# Via jmux ctl (recommended inside jmux)
jmux ctl session set-attention --target deploy

# Via raw tmux (works from anywhere)
tmux set-option -t deploy @jmux-attention 1

# From a CI callback
ssh devbox "tmux set-option -t deploy @jmux-attention 1"

# From a file watcher
fswatch -o ./build | while read; do
  tmux set-option -t build @jmux-attention 1
done

# From a test runner
bun test && tmux set-option @jmux-attention 1
```

## Using with a Separate Socket

If you're running jmux with `-L` for an isolated server, your scripts need to target the same socket:

```bash
tmux -L work set-option -t my-session @jmux-attention 1
```

Claude Code hooks run inside the tmux session, so `tmux set-option @jmux-attention 1` (without `-L`) targets the current server automatically. This works correctly whether you use `-L` or not.

## Activity Indicators vs. Attention Flags

jmux shows two types of indicators:

| Indicator | Meaning | How it's triggered |
|-----------|---------|-------------------|
| Green `●` | Activity — new output since you last viewed | Automatic (tmux session_activity timestamp) |
| Orange `!` | Attention — something explicitly needs you | Manual (`@jmux-attention` option) |

Activity dots appear automatically when any session produces output while you're in a different session. They clear when you switch to that session.

Attention flags only appear when something sets `@jmux-attention`. They take visual priority over activity dots — if both are set, you see the `!`.
