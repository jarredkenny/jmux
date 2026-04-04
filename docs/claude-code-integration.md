# Claude Code Integration

jmux supports attention flags that any tool can set on a tmux session. When a session has an attention flag, jmux shows an orange `!` indicator in the sidebar. This is designed for agentic workflows where you have multiple Claude Code instances running across sessions and need to know when one needs your input.

## The Attention Flag

Set the `@jmux-attention` option on any tmux session:

```bash
tmux set-option -t my-session @jmux-attention 1
```

jmux picks this up in real time via a tmux subscription. The orange `!` appears immediately in the sidebar next to that session.

When you switch to the session, jmux automatically clears the flag — no manual cleanup needed.

## Claude Code Hooks

Claude Code supports hooks that run shell commands in response to events. You can use these to set the attention flag when Claude needs your attention.

### Notify When a Task Completes

Add this to your Claude Code settings (`.claude/settings.json` or project-level):

```json
{
  "hooks": {
    "stop": [
      {
        "command": "tmux set-option @jmux-attention 1",
        "description": "Flag session in jmux when Claude stops"
      }
    ]
  }
}
```

The `stop` hook fires whenever Claude finishes responding. If you're in a different session, you'll see the `!` appear and know Claude is done.

### Notify on Specific Events

You can be more selective about when to set the flag:

```json
{
  "hooks": {
    "stop": [
      {
        "command": "tmux set-option @jmux-attention 1",
        "description": "Flag session when Claude stops"
      }
    ]
  }
}
```

Or trigger it from a script that checks whether the stop reason indicates the task is complete vs. needs input.

## Multi-Session Workflow

The typical workflow with jmux and Claude Code:

1. **Start jmux** with a separate server for your AI work:
   ```bash
   bun run bin/jmux -L work
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

## Setting Flags from Scripts

The attention flag is a standard tmux user option. Set it from anywhere:

```bash
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

If you're running jmux with `-L` for an isolated server, your hooks and scripts need to target the same socket:

```bash
# Set attention on the jmux server specifically
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
