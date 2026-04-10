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
src/cli/session.ts      — session list/create/kill/rename/info/switch/set-attention
src/cli/window.ts       — window list/create/select/kill
src/cli/pane.ts         — pane list/split/send-keys/capture/kill
src/cli/run-claude.ts   — high-level agent dispatch
src/cli/tmux.ts         — shared tmux command execution utility
```

Shared utilities already in the codebase (session name sanitization, OTEL env construction) are extracted and reused. The CLI modules never start the TUI, PTY, or control client.

### Routing

All CLI subcommands live under the `ctl` prefix: `jmux ctl session list`, `jmux ctl run-claude`, etc. This avoids a routing collision with the existing behavior where the first positional argument is a tmux session name (`jmux my-session`). Without the prefix, a session named "session" or "window" would be ambiguous.

`main.ts` checks whether `argv[0] === "ctl"` early. If so, it delegates to `src/cli.ts` and never starts the TUI. All existing behavior is preserved — `jmux`, `jmux my-session`, `jmux -L work` work as before.

## Context Resolution

Every subcommand needs to know which tmux server to talk to and (usually) which session it's operating in.

### `resolveContext()` → `{ socket: string | null, session: string | null, insideJmux: boolean }`

- **Socket:** Extracted from `$TMUX` (format: `/path/to/socket,PID,INDEX`). Overridden by `--socket` / `-L` flag. Falls back to tmux default if neither is available.
- **Session:** Derived from `$TMUX_PANE` via `tmux display-message -t $TMUX_PANE -p '#{session_name}'`. Overridden by `--session` flag. Required for outside-in usage when `$TMUX_PANE` is unset.
- **jmux detection:** `$JMUX=1` (already injected by jmux into all sessions).

### Inside-jmux vs. Outside-in

Commands that depend on an implicit "current" context (current session, current window, active pane) require `$TMUX_PANE` to be set. When running outside tmux:

- `session list`, `session create`, `session info`, `session kill`, `session rename`, `session set-attention` — work fine (they don't depend on "current" context, or accept explicit `--target`)
- `session switch` — requires `--client` flag to identify which client to switch (no implicit resolution)
- `pane split` without `--target` — requires `--session` and `--window` to identify where to split
- `window list` without `--session` — errors, requires explicit `--session`
- `run-claude` — works fine (creates a detached session, no current-context dependency)

When `$TMUX_PANE` is unset and the command needs implicit context, the CLI errors with: `{"error": "not inside tmux — use explicit --session/--target flags or run from within a jmux session"}`.

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

### Target Resolution

All `--target` flags accept tmux IDs as returned by list commands:
- Sessions: by name (e.g., `my-project`)
- Windows: by tmux ID (e.g., `@4`) or index (e.g., `0`, `1`)
- Panes: by tmux ID (e.g., `%8`)

Agents should capture IDs from list/create responses and use those for subsequent commands. Do not construct target strings manually or use tmux's extended target syntax (`session:window.pane`).

### `jmux ctl session list`

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

### `jmux ctl session create --name <n> --dir <path> [--command <cmd>]`

Create a new detached session.

1. Sanitizes name via `sanitizeTmuxSessionName()` (`.` and `:` replaced with `_`)
2. Runs `tmux new-session -d` with per-session OTEL resource attributes injected (`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=...`). The global OTEL exporter config (`OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`) is already set on the tmux server by the running jmux TUI and inherited automatically by new sessions. The CLI does not attempt to discover or set the receiver endpoint itself.
3. If `--command` provided, passes as the session's initial command

**Response:**
```json
{"name": "sanitized-name", "id": "$3"}
```

The returned `name` is the sanitized name actually used — agents must use this, not their original input.

### `jmux ctl session info --target <name>`

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

### `jmux ctl session switch --target <name>`

Switch the current client to the target session. From inside jmux, this switches the view in the jmux TUI.

When running inside a jmux pane, `tmux switch-client -t <target>` resolves "current client" from the calling pane's owning client — which is the jmux PTY client. This is the correct client to switch. The control-mode client is a separate attach and is not affected.

**Implementation note:** During implementation, verify that `switch-client` from within a pane resolves to the PTY client and not the control client. If not, the CLI needs to do the same `list-clients` → match-by-PID resolution that `main.ts:resolveClientName()` does.

For outside-in usage (no `$TMUX_PANE`), this command errors unless a future `--client` flag is added.

**Response:**
```json
{"switched": "my-project"}
```

### `jmux ctl session kill --target <name> [--force]`

Terminate a session. Refuses to kill the agent's own session unless `--force` is passed. Refuses to kill the last remaining session unless `--force` is passed.

**Response:**
```json
{"killed": "my-project"}
```

### `jmux ctl session rename --target <name> --name <new>`

Rename a session. New name is sanitized.

**Response:**
```json
{"renamed": "new-sanitized-name", "from": "old-name"}
```

### `jmux ctl session set-attention --target <name> [--clear]`

Set or clear the `@jmux-attention` flag on a session. Without `--clear`, sets the flag (orange `!` indicator in sidebar). With `--clear`, removes it.

This lets an orchestrating agent mark a session as needing human attention, or clear a flag after processing.

**Response:**
```json
{"target": "my-project", "attention": true}
```

### `jmux ctl window list [--session <name>]`

List windows in the current or specified session.

**Response:**
```json
{
  "windows": [
    {"id": "@1", "index": 0, "name": "editor", "active": true, "zoomed": false, "bell": false}
  ]
}
```

### `jmux ctl window create [--session <name>] [--dir <path>] [--name <n>]`

Create a new window.

**Response:**
```json
{"id": "@4", "index": 3, "name": "n"}
```

### `jmux ctl window select --target <id>`

Activate a window by ID or index.

**Response:**
```json
{"selected": "@4"}
```

### `jmux ctl window kill --target <id> [--force]`

Kill a window. Same safety rules as session kill — refuses to kill the agent's own window without `--force`.

**Response:**
```json
{"killed": "@4"}
```

### `jmux ctl pane list [--window <id>] [--session <name>]`

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

### `jmux ctl pane split [--direction h|v] [--dir <path>] [--command <cmd>] [--session <name>]`

Split the active pane in the current or specified session. `h` for horizontal (side by side), `v` for vertical (top/bottom). Defaults to `v`.

When running outside tmux, `--session` is required (no implicit active pane to split).

**Response:**
```json
{"pane": "%8", "session": "my-project", "window": "@1"}
```

### `jmux ctl pane send-keys --target <pane> [--no-enter] [--file <path>] [--stdin] [text...]`

Send text to a pane. Enter is sent after the text by default; `--no-enter` suppresses it for building up partial input.

Text sources (mutually exclusive):
- **Positional args:** `jmux ctl pane send-keys --target %8 ls -la` — sends `ls -la` + Enter
- **`--file <path>`:** reads text from a file — for multiline input, prompts with quotes/special characters
- **`--stdin`:** reads text from stdin — for piping content in

**Response:**
```json
{"sent": true, "target": "%8"}
```

### `jmux ctl pane capture --target <pane> [--lines <n>] [--raw]`

Capture content from a pane. Output is ANSI-stripped plain text by default. `--raw` preserves escape sequences.

`--lines` controls how many scrollback lines above the visible area to include (max 1000). Default: visible area only (0 scrollback lines).

**Response:**
```json
{"target": "%8", "content": "$ claude\n\nHello! How can I help?\n\n> "}
```

### `jmux ctl pane kill --target <pane> [--force]`

Kill a pane. Refuses to kill the agent's own pane without `--force`.

**Response:**
```json
{"killed": "%8"}
```

### `jmux ctl run-claude --name <n> --dir <path> [--message <text>] [--message-file <path>]`

High-level command: create a new session and launch Claude Code in it.

1. Creates session with sanitized name, per-session OTEL resource attributes, working directory (global OTEL exporter config inherited from tmux server)
2. Launches claude wrapped in a shell so exiting claude drops to a live shell:
   - Without message: `$SHELL -c '<claude_cmd>; exec $SHELL'`
   - With message: `$SHELL -c '<claude_cmd> -p "$(cat /tmp/jmux-prompt-XXXX)"; rm /tmp/jmux-prompt-XXXX; exec $SHELL'`
3. Uses `claudeCommand` from `~/.config/jmux/config.json` (default: `claude`)

**Prompt handling:** Both `--message` and `--message-file` work through a temp file to eliminate shell escaping issues. `--message <text>` writes the text to a temp file first. The session's initial command reads the prompt from the temp file via `cat`, then cleans it up. This avoids embedding arbitrary user text through two layers of shell interpretation.

**Success semantics:** The response confirms the session was created and the launch command was dispatched. It does not guarantee Claude Code has started or accepted the prompt — the initial command runs in the new session's shell, and if `claude` is not on `$PATH` or fails to start, the session will exist but drop to a shell. Use `pane capture` to verify Claude actually started.

**Response:**
```json
{
  "session": "fix-auth-bug",
  "pane": "%12",
  "claude_command": "claude",
  "command_dispatched": true
}
```

## Error Handling

- **Session name collision:** Error, don't silently rename. Agent retries with a different name.
- **Target not found:** Error with the name/ID that was looked up.
- **Not inside tmux:** Error if `$TMUX` unset and no `--socket` provided, for commands that need server context. For commands that need implicit session/pane context, error if `$TMUX_PANE` is also unset.
- **tmux server not running:** Error.
- **Self-destruction guards:** `session kill`, `window kill`, `pane kill` refuse to kill the agent's own resource without `--force`.
- **Name sanitization:** Returned JSON always shows the actual name used. Agents must capture and use the returned name, not their original input.
- **Prompt text handling:** `--message` and `--message-file` both go through a temp file to avoid shell escaping. The CLI writes the temp file, constructs the shell command to `cat` it, and cleans up after use.
- **Large `pane capture`:** `--lines` capped at 1000 scrollback lines above the visible area.
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
   - Use tmux IDs from list/create responses for `--target`, don't construct target strings manually
5. **Limitations** — what the CLI can't do, so agents don't attempt impossible operations

### Installation

The skill file ships in the jmux repo. Installation into an agent's skill system is an agent-platform concern (Claude Code skills, etc.) — documented but not automated by jmux.

## Shared Code Extraction

The following logic currently lives in `main.ts` and needs to be extracted into importable modules for CLI use:

- `sanitizeTmuxSessionName()` — session name sanitization
- Per-session OTEL resource attribute construction (`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=...`). Note: the global OTEL exporter config (`OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`) is set on the tmux server by the TUI at startup and inherited by new sessions automatically. The CLI does not set or discover these.
- Claude command resolution from jmux config (`~/.config/jmux/config.json`)
- tmux format strings for list-sessions, list-windows, list-clients

These extractions are pure refactors — no behavior change to the TUI.
