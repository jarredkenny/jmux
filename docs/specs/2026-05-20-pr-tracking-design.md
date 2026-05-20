# PR / MR tracking and CI status per session

**Status:** Design draft
**Date:** 2026-05-20

## Summary

Track the most-recently-opened pull request or merge request per jmux session,
poll its CI state, and surface both in the sidebar with a hotkey to open the
URL. Detection is hook-driven and works for both Claude Code and Codex with no
agent cooperation required for the common path.

## Motivation

When working multiple parallel coding agents, the user loses track of which
sessions have shipped PRs and which of those PRs are passing CI. The current
sidebar shows agent state (running / waiting / complete) but says nothing
about merge-readiness. The goal is a low-cost, bullet-proof feedback loop:
agent opens a PR → jmux notices → sidebar shows a badge → CI state colors the
badge → `Ctrl-a o` opens it in the browser.

## Non-goals

- Tracking PR history. Only the most recent URL per session is retained.
- Tracking review state, mergeability, or merge events. CI state only.
- Posting to PRs, requesting reviews, or any write operation.
- Detection inside arbitrary commands. Only the standard `gh pr` / `glab mr`
  CLIs are recognised by the hook. API-based flows use the explicit
  `jmux ctl pr set` escape hatch.

## Architecture

```
Claude Code / Codex (in a tmux pane)
        │  runs `gh pr create` (or similar)
        ▼
PostToolUse hook fires with Bash matcher
        │  pipes hook JSON on stdin to:
        ▼
jmux ctl pr from-hook
        │  parses JSON → command gate → URL extraction → host classification
        ▼
tmux set-option -t <session> @jmux-last-pr <url>
        │  (and clears @jmux-last-pr-ci-state)
        ▼
jmux main process: PrTracker mirrors the option into a per-session record
        │
        ├── CiPoller: schedules `gh pr view` / `glab mr view` polls
        │            writes @jmux-last-pr-ci-state + @jmux-last-pr-ci-checked-at
        │
        └── Sidebar: renders a glyph + colored dot after the session name
                     (hotkey Ctrl-a o opens the focused session's URL;
                      mouse click on the badge opens that row's URL)
```

Three roles, three files:

| File | Responsibility |
|------|----------------|
| `src/cli/pr.ts` | The only place URL extraction and CLI commands live. Pure parser, testable. |
| `src/pr-tracker.ts` | Runtime mirror of `@jmux-last-pr*` options. Analog of `AgentStateTracker`. |
| `src/pr-ci-poller.ts` | Tick-driven poller; spawns `gh` / `glab`; writes CI state back into tmux options. |

Existing files touched:
- `src/hook-installer.ts` — generalised over two targets (Claude, Codex) and adds a `PostToolUse` event.
- `src/main.ts` — wires PrTracker and CiPoller into startup, subscribes to control-channel option changes.
- `src/sidebar.ts` — renders the badge in the session row.
- `src/input-router.ts` — `Ctrl-a o` soft-prefix intercept; badge click handler.
- `src/cli.ts` — registers the `pr` subcommand.

## Hook installer

### Targets

Today the installer writes to `~/.claude/settings.json` only. Generalise to a
list of targets:

```ts
interface HookTarget {
  label: "claude" | "codex";
  path: string; // e.g. ~/.claude/settings.json
}
```

`--install-agent-hooks` iterates targets in parallel. Per-target outcome is
one of `installed | migrated | noop | skipped` (skipped when the parent
directory does not exist — user does not have that agent installed).

### Events

Add `PostToolUse` as a fourth managed event alongside the existing three
(`UserPromptSubmit`, `PermissionRequest`, `PreToolUse`, `Stop`). The managed
PostToolUse entry is:

```jsonc
{
  "matcher": "Bash",
  "hooks": [
    { "type": "command",
      "command": "jmux ctl pr from-hook",
      "timeout": 5 }
  ]
}
```

Codex matches PostToolUse only for shell commands regardless of the
`matcher` field, which is the behaviour we want. The same JSON works on both
targets without conditional logic.

### Detection & migration

`detectInstalledKind` already keys off the string `@jmux-agent-state` in the
managed event commands. Extend the detection to also recognise the substring
`jmux ctl pr from-hook`. Migration semantics are unchanged: strip any prior
jmux-owned entries for managed events and prepend the canonical block.

## `jmux ctl pr` subcommand

New file `src/cli/pr.ts`. All subcommands emit JSON to stdout on success
(matching the rest of `jmux ctl`).

### `jmux ctl pr from-hook`

Hook entry point. Reads JSON from stdin to EOF, capped at 256 KiB; anything
larger is discarded and the command exits 0 (the hook must never raise an
error or it will spam every Bash invocation).

Algorithm:

1. Parse stdin as JSON. On any failure, exit 0.
2. Defensively read `command` from `tool_input.command` (Claude shape) or
   the Codex-equivalent path. Read `stdout` from `tool_response.stdout` (or
   Codex equivalent). Both fields must be strings.
3. **Command gate**: the command must match one of these regexes (anchored
   loosely to survive sudo, env-var prefixes, etc.):
   - `\bgh\s+pr\s+(create|view|checkout|merge|comment)\b`
   - `\bglab\s+mr\s+(create|view|show|checkout|merge|comment)\b`
   Otherwise exit 0. This gate prevents harvesting URLs from unrelated
   commands.
4. **URL extraction**: scan stdout with this regex and take the *last*
   match (PR-create CLIs print the URL on the final line):
   ```
   https://(github\.com|gitlab\.com|[a-z0-9.-]+)/[\w./-]+/(pull|-/merge_requests)/\d+
   ```
   Host classification: literal `github.com` → `github`; literal
   `gitlab.com` or path containing `/-/merge_requests/` → `gitlab`; else
   `other`. (`other` skips CI polling — we know we can open the URL but
   not how to query its CI.)
5. Resolve current tmux socket + session via `src/cli/context.ts`.
6. Read the current `@jmux-last-pr` for the session. If it equals the
   extracted URL, exit 0 (nothing to do — re-polling will happen on its
   own cadence). Otherwise `tmux set-option -t <session> @jmux-last-pr
   <url>` and clear `@jmux-last-pr-ci-state` / `@jmux-last-pr-ci-checked-at`
   so the poller re-polls immediately for the new URL. The
   read-compare-write avoids resetting CI state every time the agent runs
   `gh pr view` for the same PR.
7. Exit 0.

### Other `pr` subcommands

| Command | Behaviour |
|---------|-----------|
| `jmux ctl pr set <url>` | Manual escape hatch for API-based flows. Validates the URL via the same regex; writes the same three options. |
| `jmux ctl pr get [--session <name>]` | Prints `{url, host, ciState, ciCheckedAt}` JSON, or `{url: null}` if untracked. |
| `jmux ctl pr clear [--session <name>]` | `set-option -u` for all three options. |
| `jmux ctl pr open [--session <name>]` | Spawns `open` (macOS) or `xdg-open` (Linux) with the URL. Exits non-zero with an error message if no URL is tracked. |

## `PrTracker` (runtime mirror)

`src/pr-tracker.ts`. Direct analog of `AgentStateTracker`. Three tmux user
options drive it; the tracker is the single source of truth in-process.

```ts
type CiState = "pending" | "success" | "failure" | "unknown";

interface PrRecord {
  url: string;
  host: "github" | "gitlab" | "other";
  ciState: CiState;
  ciCheckedAt: number; // ms epoch, 0 when never polled
}

class PrTracker {
  apply(sessionId, rawUrl, rawCiState, rawCheckedAt): void;
  get(sessionId): PrRecord | null;
  pruneExcept(activeIds): void;
  onChange(fn: (sessionId: string) => void): void;
}
```

Wiring matches the existing agent-state pattern:
- `list-sessions -F` includes the three options in the periodic snapshot.
- Control-channel `%session-options-changed` events feed incremental updates
  through `apply()`.
- `apply()` validates strictly: unknown `ciState` strings are ignored, a
  blank URL clears the record, a URL that does not match the regex is
  ignored.
- Idempotent re-apply does not emit changes.

## CI poller

`src/pr-ci-poller.ts`. Single timer in the main process; one poll job per
session at a time; concurrency cap of 4 in-flight polls process-wide.

### State machine

```
unknown ── first poll ──▶ pending ── CI completes ──▶ success | failure
   ▲                         │                            │
   │                     30s tick                     300s tick
   └──── 30 min with no state change ──▶ idle (no further polls)
```

`nextDueMs(record, now)` is a pure function:
- `state ∈ {unknown, pending}` → due 30 s after last check
- `state ∈ {success, failure}` → due 300 s after last check
- `now - ciCheckedAt > 30 min` and state has not changed → `null` (don't
  schedule). A new URL via the hook resets `ciCheckedAt` to 0 so polling
  resumes.

### Tick loop

Every 5 s the poller walks the tracker, computes `nextDueMs` for each
record, and enqueues any whose due time has passed. The work queue respects
the global cap of 4 concurrent polls.

### Poll job

Per record, spawn the appropriate CLI with a 10 s timeout:

- `host === "github"`:
  `gh pr view <url> --json statusCheckRollup -q '[.statusCheckRollup[].conclusion // .statusCheckRollup[].status]'`
- `host === "gitlab"`:
  `glab mr view <url> --output json` then parse `head_pipeline.status`
- `host === "other"`: skip — never polled.

Map CLI output to a single CiState with pure parser functions
(`parseGhStatusOutput`, `parseGlabPipelineOutput`):
- Any `FAILURE` / `failed` / `canceled` → `failure`
- All `SUCCESS` / `success` → `success`
- Anything else (running, pending, queued, in-progress) → `pending`
- Empty array (no checks configured) → `success` (vacuously green)

Write the result back through `tmux set-option`. PrTracker picks it up on
the next options-changed event — the poller never mutates the tracker
directly.

### Backoff and failure handling

On exit ≠ 0 or timeout:
- Do **not** change `ciState` (treat the poll as "no observation").
- Push back the next poll: 30 s → 60 s → 120 s → cap at 300 s.
- After 5 consecutive failures for a given session, drop the cadence to
  the steady-state interval (300 s) and log once.

On detected `gh: command not found` or auth failure: log once globally and
stop scheduling github polls until jmux is restarted. Same for `glab`.
This prevents the poller from spamming the user when CLIs aren't set up.

## Sidebar badge

Render in `src/sidebar.ts` immediately after the session name. Layout:

```
 ● my-session ⇧·
 ▲             ▲▲
 │             │└ status dot (1 cell, color = CI state)
 │             └ "PR tracked" glyph (1 cell, dim)
 └ existing agent state dot
```

Two cells total, fixed width when present, omitted when no PR. Colors:

| CiState | Dot color |
|---------|-----------|
| `unknown` | dim grey |
| `pending` | yellow |
| `success` | green |
| `failure` | red |

Truncation rule: the badge wins. If session-name length + badge would
overflow `sidebarCols`, drop trailing characters from the session name
first. The badge is the same width regardless of state, so existing column
math doesn't need to change beyond reserving 2 cells when `PrTracker.get()`
returns non-null.

Mouse: clicking either of the two cells routes to `pr open` for that
session via the existing sidebar click dispatcher.

## Hotkey

Extend the soft-prefix intercept in `src/input-router.ts`. After `Ctrl-a`,
if the next byte within the intercept window is `o`, swallow it (don't
forward to tmux) and call `pr open` for the focused session.

If no PR is tracked, surface a transient status — investigate during
implementation whether existing modal-status infrastructure can hold a 2 s
toast. Worst case, fall back to a tmux `display-message` call.

## Persistence

Tmux user options only. Three options per session:
- `@jmux-last-pr` (string URL)
- `@jmux-last-pr-ci-state` (`pending|success|failure|unknown`)
- `@jmux-last-pr-ci-checked-at` (epoch seconds)

Survives jmux restart while the tmux server is alive. Lost on tmux server
death — acceptable: the next `gh pr create` re-establishes state, and CI
state is cheap to re-poll. No snapshot schema changes for v1.

## Testing

Unit tests live in `src/__tests__/`. No integration tests against real
`gh` / `glab` / tmux.

| Module | Test surface |
|--------|--------------|
| `src/cli/pr.ts` | `extractPrUrl({command, stdout})` covering: gh pr create happy, glab mr create happy, `gh pr view --json url`, enterprise github host, multiple URLs in output (last wins), unrelated command containing a PR URL (ignored), malformed JSON stdin (returns null), command-gate rejections. |
| `src/hook-installer.ts` | Add cases for: PostToolUse entry installed for Claude, PostToolUse entry installed for Codex, target skipped when parent dir missing, migration from "current minus PostToolUse" to "current including PostToolUse", PostToolUse strip-and-prepend on re-install. |
| `src/pr-tracker.ts` | Mirror existing AgentStateTracker test patterns: apply / unknown-state ignored / blank clears / idempotent no-emit / pruneExcept. |
| `src/pr-ci-poller.ts` | `nextDueMs(record, now)` pure function across all states and the 30-min idle cutoff. `parseGhStatusOutput(stdout)` and `parseGlabPipelineOutput(stdout)` for all five output shapes. Poller orchestration with a fake clock + fake spawn for: concurrency cap, backoff schedule, CLI-missing handling. |
| `src/sidebar.ts` | Render plan test: badge renders when tracker has a record, omitted when not, truncation favours badge over name. |

## Edge cases and open questions

- **Multiple PRs in one stdout** (e.g. `gh pr list` output) — gated out
  because the command must be a `pr create|view|...` invocation, not
  `pr list`. List output never reaches the URL extractor.
- **`gh` / `glab` print URLs to stderr in some versions** — defensive:
  scan both `stdout` and `stderr` (concatenated) when looking for the URL.
- **PR gets merged / closed** — badge stays until the agent opens another
  PR or the user calls `jmux ctl pr clear`. CI state may continue to
  reflect the last seen value. Acceptable for v1.
- **Session renamed** — tmux user options are keyed by session id, not
  name, so rename is transparent.
- **Worktree sessions across multiple jmux instances** — out of scope; the
  hook resolves session via `TMUX` env which the calling agent inherited
  from its pane. No cross-instance coordination needed.
