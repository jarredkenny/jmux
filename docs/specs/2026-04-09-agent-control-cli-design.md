# jmux Agent Control CLI

**Date:** 2026-04-09
**Status:** Draft

## Problem

A Claude Code instance running inside a jmux-managed tmux session has no programmatic way to orchestrate sibling sessions. It can't create new sessions, dispatch other Claude Code instances, monitor their progress, or send them input. All jmux operations are locked behind the interactive TUI.

Agents need a CLI surface to fan out work across sessions, monitor dispatched agents, and interact with them — without understanding jmux's internal conventions (session name sanitization, OTEL env injection, socket detection, shell wrapping).

## Goals

- Let an agent inside a jmux session create, monitor, and interact with sibling sessions, windows, and panes via CLI subcommands
- Dispatch new Claude Code instances with initial prompts
- Expose session/agent status (attention flags, pane contents) for monitoring
- Encapsulate all jmux conventions so agents never need raw tmux commands
- Support outside-in orchestration (external process controlling jmux) as a secondary use case

## Non-Goals

- Replacing the interactive TUI — the CLI is for programmatic use, not human use
- Real-time streaming of pane output (polling via `pane capture` is sufficient)
- Managing tmux config, keybindings, or display settings
- Worktree creation — `run-claude` creates plain sessions; worktree workflows stay in the TUI

## Architecture

### Approach: Standalone CLI Processes

Each subcommand is a short-lived process that talks directly to the tmux server via the socket, performs its operation, prints JSON to stdout, and exits. No IPC to the running jmux TUI instance.

The running jmux TUI already subscribes to tmux control-mode events (`%sessions-changed`, `%window-renamed`, etc.) and will pick up CLI-initiated changes organically. No coordination signal needed.

### Code Organization

```
src/cli.ts              — entry point: parse subcommand, dispatch to handler
src/cli/context.ts      — resolve socket, current session, jmux detection
src/cli/session.ts      — session list/create/kill/rename/info/switch
src/cli/window.ts       — window list/create/select/kill
src/cli/pane.ts         — pane list/split/send-keys/capture/kill
src/cli/run-claude.ts   — high-level agent dispatch
src/cli/tmux.ts         — shared tmux command execution utility
```

Shared utilities already in the codebase (session name sanitization, OTEL env construction) are extracted and reused. The CLI modules never start the TUI, PTY, or control client.

### Routing

`main.ts` checks `argv` early. If the first positional argument matches a known subcommand (`session`, `window`, `pane`, `run-claude`), it delegates to `src/cli.ts` and never starts the TUI. Otherwise, existing behavior is preserved — `jmux`, `jmux my-session`, `jmux -L work` all work as before.

## Context Resolution

Every subcommand needs to know which tmux server to talk to and (usually) which session it's operating in.

### `resolveContext()` → `{ socket: string | null, session: string | null, insideJmux: boolean }`

- **Socket:** Extracted from `$TMUX` (format: `/path/to/socket,PID,INDEX`). Overridden by `--socket` / `-L` flag. Falls back to tmux default if neither is available.
- **Session:** Derived from `$TMUX_PANE` via `tmux display-message -t $TMUX_PANE -p '#{session_name}'`. Overridden by `--session` flag. Required for outside-in usage when `$TMUX_PANE` is unset.
- **jmux detection:** `$JMUX=1` (already injected by jmux into all sessions).

## Output Contract

All subcommands write JSON to stdout on success (exit 0) and JSON to stderr on failure (exit non-zero):

```json
{"error": "session 'foo' already exists"}
```

## CLI Reference

### Global Flags

| Flag | Description |
|------|-------------|
| `--session <name>` | Target session (default: current session from `$TMUX_PANE`) |
| `--socket <name>` / `-L <name>` | tmux server socket (default: from `$TMUX`) |

### `jmux session list`

List all sessions with metadata.

**Response:**
```json
{
  "sessions": [
    {
      "id": "$1",
      "name": "my-project",
      "windows": 3,
      "attached": true,
      "activity": 1712678400,
      "attention": false,
      "path": "/Users/jarred/Code/my-project"
    }
  ]
}
```

- `attention` reads the `@jmux-attention` tmux user option.
- `path` is the active pane's `pane_current_path`.

### `jmux session create --name <n> --dir <path> [--command <cmd>]`

Create a new detached session.

1. Sanitizes name via `sanitizeTmuxSessionName()` (`.` and `:` replaced with `_`)
2. Runs `tmux new-session -d` with OTEL env vars injected (`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=...`, plus the OTEL exporter config pointing at jmux's receiver if running)
3. If `--command` provided, passes as the session's initial command

**Response:**
```json
{"name": "sanitized-name", "id": "$3"}
```

The returned `name` is the sanitized name actually used — agents must use this, not their original input.

### `jmux session info --target <name>`

Detailed info about a session, including window list and attention state.

**Response:**
```json
{
  "name": "my-project",
  "id": "$1",
  "windows": 2,
  "attached": true,
  "attention": true,
  "path": "/Users/jarred/Code/my-project",
  "windows_detail": [
    {"id": "@1", "index": 0, "name": "claude", "active": true, "zoomed": false, "bell": false}
  ]
}
```

### `jmux session switch --target <name>`

Switch the current client (the one owning `$TMUX_PANE`) to the target session.

**Response:**
```json
{"switched": "my-project"}
```

### `jmux session kill --target <name> [--force]`

Terminate a session. Refuses to kill the agent's own session unless `--force` is passed. Refuses to kill the last remaining session unless `--force` is passed.

**Response:**
```json
{"killed": "my-project"}
```

### `jmux session rename --target <name> --name <new>`

Rename a session. New name is sanitized.

**Response:**
```json
{"renamed": "new-sanitized-name", "from": "old-name"}
```

### `jmux window list [--session <name>]`

List windows in the current or specified session.

**Response:**
```json
{
  "windows": [
    {"id": "@1", "index": 0, "name": "editor", "active": true, "zoomed": false, "bell": false}
  ]
}
```

### `jmux window create [--session <name>] [--dir <path>] [--name <n>]`

Create a new window.

**Response:**
```json
{"id": "@4", "index": 3, "name": "n"}
```

### `jmux window select --target <id>`

Activate a window by ID or index.

**Response:**
```json
{"selected": "@4"}
```

### `jmux window kill --target <id> [--force]`

Kill a window. Same safety rules as session kill — refuses to kill the agent's own window without `--force`.

**Response:**
```json
{"killed": "@4"}
```

### `jmux pane list [--window <id>] [--session <name>]`

List panes in a window.

**Response:**
```json
{
  "panes": [
    {"id": "%5", "window": "@1", "active": true, "width": 120, "height": 40, "command": "claude", "path": "/Users/jarred/Code/project"},
    {"id": "%6", "window": "@1", "active": false, "width": 120, "height": 40, "command": "zsh", "path": "/Users/jarred/Code/project"}
  ]
}
```

### `jmux pane split [--direction h|v] [--dir <path>] [--command <cmd>] [--session <name>]`

Split the active pane in the current or specified session. `h` for horizontal (side by side), `v` for vertical (top/bottom). Defaults to `v`.

**Response:**
```json
{"pane": "%8", "session": "my-project", "window": "@1"}
```

### `jmux pane send-keys --target <pane> [--enter] <text>`

Send text to a pane. `--enter` appends an Enter keypress.

**Response:**
```json
{"sent": true, "target": "%8"}
```

### `jmux pane capture --target <pane> [--lines <n>]`

Capture visible content from a pane. `--lines` includes scrollback history (max 1000). Default: visible area only.

**Response:**
```json
{"target": "%8", "content": "$ claude\n\nHello! How can I help?\n\n> "}
```

### `jmux pane kill --target <pane> [--force]`

Kill a pane. Refuses to kill the agent's own pane without `--force`.

**Response:**
```json
{"killed": "%8"}
```

### `jmux run-claude --name <n> --dir <path> [--message <text>] [--message-file <path>]`

High-level command: create a new session and launch Claude Code in it.

1. Creates session with sanitized name, OTEL env vars, working directory
2. Launches claude wrapped in a shell so exiting claude drops to a live shell:
   - With message: `$SHELL -c 'claude -p "..."; exec $SHELL'`
   - Without message: `$SHELL -c 'claude; exec $SHELL'`
3. Uses `claudeCommand` from `~/.config/jmux/config.json` (default: `claude`)
4. `--message-file` reads the file contents and passes via `-p`

**Response:**
```json
{
  "session": "fix-auth-bug",
  "pane": "%12",
  "claude_command": "claude",
  "prompt_sent": true
}
```

## Error Handling

- **Session name collision:** Error, don't silently rename. Agent retries with a different name.
- **Target not found:** Error with the name/ID that was looked up.
- **Not inside tmux:** Error if `$TMUX` unset and no `--socket` provided.
- **tmux server not running:** Error.
- **Self-destruction guards:** `session kill`, `window kill`, `pane kill` refuse to kill the agent's own resource without `--force`.
- **Name sanitization:** Returned JSON always shows the actual name used. Agents must capture and use the returned name, not their original input.
- **Shell escaping for `--message`:** The CLI handles escaping internally. Agents pass the raw message string; the CLI constructs the shell command safely.
- **Large `pane capture`:** `--lines` capped at 1000 to avoid dumping excessive content into agent context.
- **Concurrent creation race:** tmux rejects duplicate session names. CLI surfaces the error; agent retries.

## The Agent Skill

A skill document ships with jmux (e.g., `skills/jmux-control.md`) that teaches agents how to use the CLI.

### Skill Structure

1. **Detection** — check `$JMUX=1` to confirm you're inside jmux
2. **Command reference** — concise table of every subcommand, flags, and return shapes
3. **Patterns:**
   - **Fan-out:** spawn N Claude instances for independent tasks, poll `session info` for attention flags
   - **Pipeline:** spawn agent A, wait for completion, `pane capture` the output, spawn agent B with that context
   - **Monitor:** periodically check `session info` attention flag, `pane capture` for detailed state
   - **Interact:** `pane send-keys` to send follow-up instructions to a running agent
4. **Conventions:**
   - Always use the returned session name (post-sanitization), not the requested name
   - Don't kill sessions you didn't create
   - Prefer `session info` attention flag over tight `pane capture` polling loops
   - Parse JSON output, don't regex it
5. **Limitations** — what the CLI can't do, so agents don't attempt impossible operations

### Installation

The skill file ships in the jmux repo. Installation into an agent's skill system is an agent-platform concern (Claude Code skills, etc.) — documented but not automated by jmux.

## Shared Code Extraction

The following logic currently lives in `main.ts` and needs to be extracted into importable modules for CLI use:

- `sanitizeTmuxSessionName()` — session name sanitization
- OTEL environment variable construction (the `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_*` env vars)
- Claude command resolution from jmux config (`~/.config/jmux/config.json`)
- tmux format strings for list-sessions, list-windows, list-clients

These extractions are pure refactors — no behavior change to the TUI.
