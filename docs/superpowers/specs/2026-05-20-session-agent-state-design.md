# Session Agent State (RUNNING / WAITING / COMPLETE)

**Status:** design approved, ready for implementation plan
**Author:** jarred
**Date:** 2026-05-20

## Summary

jmux today shows an orange `!` indicator when a Claude Code session's `Stop`
hook fires, then clears it on view. That single flag conflates two distinct
situations: an agent that has *finished its turn* and an agent that is
*paused mid-turn awaiting user input* (e.g. a permission prompt). A user
juggling parallel agents cannot tell, from the sidebar, which sessions are
actively working, which are blocked on them, and which are done — they all
look the same until you tab in.

This design introduces an explicit per-session **agent state**:

- `running` — the agent is actively working
- `waiting` — the agent is paused awaiting user input (permission prompt or
  notification)
- `complete` — the agent's turn has ended

State is detected by a small set of Claude Code hooks, stored on the tmux
session as user options, surfaced in the existing col-1 indicator (now
color-coded by state) and as a text label on the existing row 2 of the
sidebar. The legacy `@jmux-attention` flag and its `!` indicator are
retired.

## Goals

- A user can see, at a glance from the sidebar, which Claude Code sessions
  are `running`, `waiting`, or `complete`.
- State is driven by reliable, synchronous signals (Claude Code hooks),
  not heuristic OTEL timing.
- Existing functional sidebar information (mode badge, MR id, pipeline
  glyph, cost, last tool) is preserved — the session row count stays at 3.
- Sessions that have never emitted an agent signal are unchanged.
- State survives jmux restart (via tmux user options), and survives full
  tmux restart (via the existing snapshot system).

## Non-goals

- Tracking finer-grained substates (e.g. "running, doing api request" vs
  "running, executing tool"). The three states are sufficient signal.
- Tracking state for non-Claude-Code agents (Codex, etc.). The hook
  installer is Claude-Code-specific; other agents that want this would
  ship their own equivalent.
- Replacing the existing OTEL pipeline. OTEL continues to carry cost,
  tool, cache-timer, and permission-mode data.

## Decisions and rationale

### State source: hooks, not OTEL inference

OTEL events (`api_request`, `tool_result`, `user_prompt`) tell us what
happened but not what isn't happening. There is no OTEL event for "turn
ended" or "awaiting permission". Inferring `complete` from "no event for
N seconds" creates flapping; inferring `waiting` from idle gaps would
miss the actual permission-prompt case entirely.

Claude Code's hook system fires synchronously at the exact state
transitions we need: `UserPromptSubmit` (start of a turn), `Notification`
(permission/idle wait), `PreToolUse` (tool execution begins), `Stop`
(turn ends). Hooks are the right source.

### Storage: tmux user options, not in-process

State is persisted as two user options per session:

- `@jmux-agent-state` — `"running" | "waiting" | "complete"`
- `@jmux-agent-state-since` — Unix epoch seconds (as a string, since tmux
  options are strings)

This mirrors the existing `@jmux-attention` mechanism. Benefits:

- Survives jmux restart automatically (tmux server holds it).
- Hooks can write it from inside the Claude Code pane without knowing
  any jmux IPC — `tmux set-option @jmux-agent-state running` Just Works
  because tmux resolves the current session.
- jmux already subscribes to user-option changes via the control channel
  (`main.ts:3589–3593`); we extend that subscription rather than
  building new IPC.

### Resuming from WAITING

After a `Notification`-driven WAITING, the user answers the permission
prompt in the pane and Claude resumes — but no hook fires for that
transition (the user response is not a `UserPromptSubmit`). To detect
"back to RUNNING" we use two complementary signals:

1. **`PreToolUse` hook** — fires synchronously when Claude is about to
   run the *next* tool after the user grants permission. Sub-100ms,
   precise.
2. **OTEL `api_request` / `tool_result`** — `OtelReceiver`, on these
   events, checks the session's current state and if it's `waiting`,
   issues `tmux set-option @jmux-agent-state running` itself. Safety
   net for cases where the `PreToolUse` hook is somehow missed or
   delayed.

Both writers go through the same tmux option, so jmux sees one event on
the control channel either way — no in-process shortcut, no race.

### Display: keep 3 rows, retain existing info, replace "idle"

The original draft of this design considered adding a 4th row for state
text. After review, we kept 3 rows and folded state into the existing
layout:

- Row 0 col-1 indicator becomes color-coded by state.
- Row 1 timer is unified: cache countdown while active, otherwise
  elapsed since the most recent OTEL event. This absorbs the "X idle"
  text that today lives on row 2.
- Row 2 right side gains a state text label (`RUNNING` / `WAITING` /
  `COMPLETE`), replacing the now-redundant idle text.
- Everything else (mode badge, MR id, pipeline glyph, cost, last tool)
  stays.

The user can read the *state* from the col-1 glyph color and the state
label, and *how long it's been in that state* from the unified row-1
timer. No separate "elapsed in state" field is needed.

## State model

### Transition table

| Trigger | New state | Rewrites `since`? |
|---|---|---|
| `UserPromptSubmit` hook | `running` | yes |
| `Notification` hook | `waiting` | yes |
| `PreToolUse` hook | `running` (if not already) | only if state changed |
| `Stop` hook | `complete` | yes |
| OTEL `api_request` while `waiting` | `running` | yes |
| OTEL `tool_result` while `waiting` | `running` | yes |
| OTEL events while `running` or `complete` | (no state change) | no |

The "only if state changed" rule on `PreToolUse` is critical: every
single tool call fires `PreToolUse`, and if we rewrote `since` on each
one the row-1 elapsed timer would constantly reset and "stuck tool"
would be undetectable.

### Initial state

Absence of `@jmux-agent-state` ⇒ no agent signal seen yet ⇒ session
renders as today (no state color in col 1, no state label on row 2).
The first hook fire promotes the session into the state-tracked set;
promotion is sticky for the session's lifetime.

### Stale state coercion on restore

When the snapshot system restores `agentState` after a full tmux
restart, if the snapshot is older than **10 minutes** and the stored
state is `running` or `waiting`, coerce to `complete` on the way in.
An agent that was running 10+ minutes ago without any further hook
fire is dead. This prevents a stuck "RUNNING 4h" display.

## Detection pipeline

### Hook installer (`jmux --install-agent-hooks`)

Installs four hooks in `~/.claude/settings.json`. Each is a single
shell line that writes to tmux options, defaulting to the current
session (no `-t` needed because the hook runs inside the Claude Code
pane).

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "tmux set-option @jmux-agent-state running 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null || true",
        "timeout": 5
      }]
    }],
    "Notification": [{
      "hooks": [{
        "type": "command",
        "command": "tmux set-option @jmux-agent-state waiting 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null || true",
        "timeout": 5
      }]
    }],
    "PreToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "[ \"$(tmux show-option -qv @jmux-agent-state 2>/dev/null)\" = \"running\" ] || { tmux set-option @jmux-agent-state running 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null; } || true",
        "timeout": 5
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "tmux set-option @jmux-agent-state complete 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null || true",
        "timeout": 5
      }]
    }]
  }
}
```

Installer behavior:

1. If the legacy single-hook `@jmux-attention` Stop entry is present,
   replace it with the new four-hook block. Print a brief migration
   note to stdout.
2. If a current four-hook block is already present, exit
   `"already installed"`.
3. If nothing is installed, install the new block.

### Control-channel subscription

jmux extends its existing user-option subscription in `main.ts`
(currently around line 3589) to also subscribe to `@jmux-agent-state`
and `@jmux-agent-state-since`. Format string mirrors the existing one:

```
#{S:#{session_id}=#{@jmux-agent-state} }
#{S:#{session_id}=#{@jmux-agent-state-since} }
```

Each update event flows through a new `AgentStateTracker` module that
owns the per-session state map and emits a change event when state or
`since` actually changes.

### OTEL safety-net writes

`OtelReceiver` gains a `tmuxRunner` (the same one used elsewhere in
`main.ts`). On `api_request` and `tool_result` events, after applying
the existing OTEL-state updates, if it observes that the session's
current `@jmux-agent-state` is `waiting`, it issues:

```
tmux set-option -t <session_id> @jmux-agent-state running
tmux set-option -t <session_id> @jmux-agent-state-since <now_epoch>
```

The current state is read from `AgentStateTracker`, not directly from
tmux, to avoid a round-trip.

### Legacy `@jmux-attention` cleanup

On jmux startup, after listing sessions, fire a one-shot
`set-option -t <id> -u @jmux-attention` for every session. This unsets
any stale legacy flag from previous jmux versions. The
`clearSessionIndicators` codepath that today unsets `@jmux-attention`
on session view is removed.

The session listing format string in
`main.ts:858` and `cli/session.ts:57,98,189-192` is updated to drop
the `#{@jmux-attention}` field and gain `#{@jmux-agent-state}` and
`#{@jmux-agent-state-since}`.

## Rendering

### Sidebar row layout (26-col default)

```
Row 0: ▎ ⏵ session-name           A SCR-42
Row 1: ▎   feat/branch-name      4:55 !12 ✓
Row 2: ▎   $0.42  Edit 2.1s     RUNNING
```

### Col-1 indicator (row 0)

Priority order: `error > mcp-down > agent-state > activity`.

| Source | Glyph | Color |
|---|---|---|
| api_error / api_retries_exhausted | `⨯` | red bold |
| mcp-down | `⊘` | red dim |
| agent-state = running | `⏵` | palette green (fg 2) |
| agent-state = waiting | `!` | palette orange (fg 3) bold |
| agent-state = complete | `✓` | palette blue (fg 4) dim |
| terminal activity (no agent-state) | `●` | palette green |

### Row 1 unified timer

```
if (cacheTimersEnabled and cacheTimerRemaining > 0):
    show "M:SS" cache countdown with existing color ramp
        green > 3min, orange ≤ 3min, red ≤ 30s
else if (any OTEL event has been seen for this session):
    elapsed = now - max(lastRequestTime, lastUserPromptTime,
                        lastTool.timestamp)
    show "Xs" / "Xm" / "Xh", dim
else:
    blank
```

This replaces both the cache-timer-only behavior and the row-2 "X idle"
text.

### Row 2 layout

Composes:

- left part (left-aligned, in order): `cost` `lastTool + duration`
- right part (right-aligned): state label

Drop priority when the row is too narrow (state always wins):

1. drop `lastTool + duration`
2. drop `cost`
3. state label stays

State label attrs:

| State | Text | Attrs |
|---|---|---|
| running | `RUNNING` | fg 2 (green) |
| waiting | `WAITING` | fg 3 (orange) bold |
| complete | `COMPLETE` | fg 4 (blue) dim |

Sessions with no `@jmux-agent-state` fall back to today's row-2 layout
(no state label).

### Re-render cadence

The unified row-1 timer ticks every second. The existing `setInterval`
in `main.ts` already drives a 1Hz re-render for the cache timer; we
reuse it. No new timer machinery.

## Module structure

New files:

- `src/agent-state.ts` — `AgentStateTracker` class. Pure state machine.
  Owns the per-session map. Receives transitions from the control
  channel (hook writes) and from `OtelReceiver`. Emits change events.
- `src/__tests__/agent-state.test.ts` — unit tests for the state
  machine.
- `src/__tests__/hook-installer.test.ts` — unit tests for the install
  / migrate / noop paths.

Modified files:

- `src/types.ts` — add `AgentState` union, extend `SessionView` with
  `agentState`, `agentStateSince` fields.
- `src/main.ts` —
  - Extend the existing user-option subscription to include
    `@jmux-agent-state` and `@jmux-agent-state-since`.
  - Add startup pass to unset legacy `@jmux-attention`.
  - Remove `clearSessionIndicators`'s `@jmux-attention` unset call.
  - Update `list-sessions` format strings.
  - Hook up `AgentStateTracker` to the renderer.
  - Update the `--install-agent-hooks` subcommand to install the new
    four-hook block and migrate the legacy entry.
- `src/otel-receiver.ts` — add `tmuxRunner` injection; on
  `api_request` / `tool_result` while session state is `waiting`,
  write the tmux options.
- `src/session-view.ts` — `buildSessionView` populates `agentState`
  and `agentStateSince`. `buildSessionRow3` (renamed conceptually
  to "row 2 builder") includes state in the right-side slot with the
  new drop-priority.
- `src/sidebar.ts` — col-1 glyph selection consults agent state; row 2
  renderer places state label on the right.
- `src/snapshot/schema.ts` — add per-session `agentState` field
  (`{ state, since } | null`).
- `src/snapshot/` writer & restore — write current state on shutdown;
  restore on boot with the 10-minute stale-state coercion rule.
- `src/cli/session.ts` — update `list-sessions` format strings and any
  consumers that surface attention.

## Testing strategy

### Unit tests

**`agent-state.test.ts` (new):**

- Each hook event produces the right transition from each prior state.
- `since` updates on actual state change.
- `since` does *not* update when `PreToolUse` fires while already
  `running` (de-dup).
- OTEL `api_request` / `tool_result` during `waiting` flips to
  `running`.
- OTEL events during `running` or `complete` do not change state.
- Initial-state behavior: first hook fire promotes the session.
- Stale-state coercion at boot: a 10-minute-old `running` snapshot
  loads as `complete`.

**`sidebar.test.ts` (extend):**

- Promoted sessions render col-1 glyph in the right color per state.
- State label appears on row 2 right.
- Drop-priority: row 2 in 26 / 22 / 18 cols, with various combinations
  of cost / tool / state, drops in the right order.
- Indicator priority still works: `error > mcp-down > agent-state >
  activity`.

**`session-view.test.ts` (extend):**

- Unified row-1 timer: cache-countdown while active, then elapsed when
  expired, then blank if no OTEL data.
- `agentState` and `agentStateSince` populated correctly.

**`hook-installer.test.ts` (new):**

- Golden-file the four-hook JSON.
- Round-trip: legacy → new (migration), new → noop, none → install.

### Coverage gate

The existing 95% line-coverage CI rule on `src/snapshot/**` is
extended to `src/agent-state.ts`. The PR includes a `bun test
--coverage` step at the same threshold.

### Manual smoke test

`bun run docker` produces a clean-env tmux + Claude Code container.
The PR description lists a manual walkthrough:

1. `--install-agent-hooks` into a fresh `~/.claude/settings.json`.
2. Open a session, prompt Claude — sidebar shows `RUNNING`.
3. Wait for a permission prompt — sidebar flips to `WAITING`.
4. Answer the prompt — sidebar flips back to `RUNNING`.
5. Wait for the response to finish — sidebar shows `COMPLETE`.

No automated integration test against real Claude Code is added — the
hooks are tiny shell one-liners with deterministic behavior, fully
covered by the installer golden file.

## Rollout

This is a behavior-change release for users who already have
`@jmux-attention` hooks installed. The migration is:

1. Ship the new version.
2. On first run, jmux still works — old hooks keep writing
   `@jmux-attention=1`, but jmux ignores it. The user sees no `!`
   indicator anymore, and no state colors yet.
3. The user runs `jmux --install-agent-hooks`. Installer detects the
   legacy hook, replaces it with the new four-hook block, and prints:
   *"Migrated jmux Stop hook to the new agent-state hooks
   (UserPromptSubmit, Notification, PreToolUse, Stop). Restart Claude
   Code in any open session to pick them up."*
4. State indicators start working in any Claude Code session opened
   after the migration.

The startup `-u @jmux-attention` cleanup unsets stale flags so the
release doesn't leave a lingering `!` across sessions during the
transition window before the user runs the installer.
