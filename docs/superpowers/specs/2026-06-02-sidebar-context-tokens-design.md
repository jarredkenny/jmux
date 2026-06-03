# Sidebar rework: context tokens replace cost & last-tool

**Date:** 2026-06-02
**Status:** Approved, ready for planning

## Problem

The sidebar's third row per session currently shows the cumulative API cost
(`$48.35`) on the left and the last tool call (`Bash 0.1s`) in the middle, with
the agent state label (`RUNNING` / `WAITING` / `COMPLETE`) on the right.

Neither the dollar figure nor the last tool call is useful to the jmux operator:

- Cost was the *original* reason the OTEL integration was built, but it is no
  longer needed. The OTEL pipeline now drives many other signals.
- "Bash 0.1s" / "Edit 0.0s" carry no actionable meaning at the sidebar level.

We want row 3 to instead show something genuinely useful for running many
parallel agents: **how large each session's context has grown** — i.e. its
current context-window occupancy in tokens.

## Decisions (resolved during brainstorming)

1. **Metric = context occupancy**, not cumulative usage. The figure reflects the
   *current* size of the main conversation context, so it drops after a
   compaction.
2. **Numerator only — never a denominator.** OTEL cannot tell us the max context
   window (see "Why no denominator" below), so we show only the live size, e.g.
   `112k`. No `/200k`, no percentage, no fill bar.
3. **No fill coloring.** A green→yellow→red ramp needs a ratio, which needs a
   denominator we don't have. The number renders in the standard dim row-3
   detail style, consistent with the rest of the detail text.
4. **Bare format:** `112k` (`Math.round(tokens / 1000) + "k"`), `1.2M` past a
   million, empty string when zero. No unit suffix like `ctx`.
5. **Remove cost and last-tool wholesale**, including the `costUsd` and
   `lastTool` fields in OTEL state and the snapshot schema. There is no separate
   "show/hide cost" toggle in the code — cost was rendered unconditionally — so
   removal is purely deletion of the display + the backing fields. The
   `cacheTimers` config toggle (the green countdown timer on row 2) is a
   **separate** feature and is **kept**.

### Why no denominator (recorded for posterity)

OTEL definitively cannot supply the max context window per session:

- Claude Code strips the `[1m]` suffix from the model id before it leaves the
  process, so the `api_request` `model` attribute is always the bare id
  (`claude-opus-4-8`) regardless of whether the 1M context is active.
- 1M vs 200k is plan/platform-dependent (e.g. `claude-opus-4-8` is 1M on the
  Claude API/Bedrock/Vertex but 200k on Microsoft Foundry), so the model id
  alone cannot disambiguate even with a lookup table.
- No `max_tokens`, context-capacity, or platform attribute exists on any event,
  metric, or span.
- The auto-compaction threshold is undocumented and version-varying, so
  inferring the window from the context size at a `compaction` event is
  unreliable.

Rather than guess a window (a wrong denominator is worse than none), we show the
numerator alone.

## How context occupancy is measured

Each main-loop `api_request` sends the entire conversation as its prompt, so the
total prompt size for a main-loop request **is** the current context size at that
turn:

```
total = input_tokens + cache_read_tokens + cache_creation_tokens
```

The `api_request` event carries a `query_source` attribute that identifies the
origin of the request:

- `"repl_main_thread"` — the main loop (this is the one we want)
- `"compact"` — the compaction's own summarization request (ignore)
- a subagent / skill name — sidechain requests, always smaller (ignore)

### Tracking rule (per session)

On each `api_request`:

- If `query_source === "repl_main_thread"`: set `contextTokens = total`
  (**latest wins**). Because the latest main-loop total is the authoritative
  current occupancy, this naturally drops after both `/compact` **and** `/clear`,
  with no special-casing.
- Else if `query_source` is **absent** (older Claude Code that doesn't emit it):
  `contextTokens = max(contextTokens, total)` (**legacy high-water fallback**).
  Taking the max dodges the smaller subagent requests when we can't filter them
  by source.
- Else (`"compact"`, subagent, or any other named source): **ignore**.

On `compaction`: `contextTokens = 0`. This is a safety reset for the legacy
high-water path (so the figure drops when an old client compacts). It is
harmless in the modern path — the next main-loop request immediately
repopulates `contextTokens` with the post-compaction size.

This is more accurate than a pure high-water-mark approach and removes the
previously-flagged `/clear` limitation: in the modern path the figure always
reflects the most recent main-loop context size.

## Changes by file

### `src/types.ts`
- Remove `costUsd: number` from `SessionOtelState` and `makeSessionOtelState()`.
- Remove `lastTool: LastTool | null` from `SessionOtelState` and the `LastTool`
  interface entirely.
- Add `contextTokens: number` (default `0`).

### `src/otel-receiver.ts`
- `api_request` handler:
  - Read `query_source` (new `findAttrString` lookup) and the three input-side
    token counts: `input_tokens`, `cache_read_tokens` (already read for the
    cache-hit flag), and `cache_creation_tokens`. `output_tokens` is not needed.
  - Compute `total = input_tokens + cache_read_tokens + cache_creation_tokens`.
  - Apply the tracking rule above to set `contextTokens`.
  - Stop reading `cost_usd` and stop accumulating `costUsd`.
  - Keep `lastRequestTime`, `cacheWasHit`, and the `lastError = null` reset.
- `compaction` handler: additionally set `contextTokens = 0`.
- `tool_result` handler: keep the `onAgentResumeHint(sessionName)` call (it
  closes the WAITING→RUNNING gap), but remove the `lastTool` assignment. The
  `tool_name` lookup is no longer required; if the handler no longer needs to
  read any attribute, it still fires the resume hint and the session-update
  emit.
- `getSessionSnapshot`: replace `costUsd` / `lastTool` fields with
  `contextTokens`.
- `setSessionSnapshot`: restore `contextTokens` from the snapshot (default `0`
  when absent); remove `costUsd` and `lastTool` restoration.

### `src/session-view.ts`
- `buildSessionView`: the unified-timer fallback chain currently includes
  `timerState.lastTool?.timestamp` as a candidate "latest OTEL event" time.
  Remove that candidate (the remaining `lastRequestTime` and
  `lastUserPromptTime` candidates suffice).
- `buildSessionRow3`: rewrite.
  - Remove `costText`, `toolText`, `idleText`, `formatToolDuration`,
    `formatIdle`.
  - Add `formatContext(tokens: number): string` →
    `tokens <= 0 ? "" : tokens >= 1_000_000 ? (tokens/1e6).toFixed(1)+"M" :
    Math.round(tokens/1000)+"k"`.
  - **Promoted** (agentState !== null): layout `contextText` (left) +
    `STATE` (right), with the same drop/truncation discipline as today
    (state label is the right-anchored sentinel; drop the context figure first
    if it doesn't fit). `labelCol` is still returned for the sidebar's state
    repaint.
  - **Non-promoted** (agentState === null): `contextText` left-aligned only;
    `labelCol = -1`.
  - `SessionRow3Result` keeps its current shape `{ text, labelCol }`. No new
    color plumbing — the context figure is part of `text` and renders in the
    dim row-3 attributes.

### `src/sidebar.ts`
- Update the stale `// Row 3: cost / tool / state ...` comment near the row-3
  render block to describe the new content.
- No other changes — `buildSessionRow3` is still called the same way, the state
  label is still repainted via `LABEL_BY_STATE` using `result.labelCol`, and the
  `EMPTY_OTEL_STATE` path stays (a promoted-but-no-OTEL session still needs a
  blank OTEL state so its state label renders).

### `src/snapshot/schema.ts`
- `SnapshotOtel`: remove `costUsd` and `lastTool`; add `contextTokens?: number`
  (**optional**, default `0`, so snapshots written before this change still
  validate).
- `validateOtel`:
  - Remove the `costUsd` number check and remove `"lastTool"` from the
    `nullableStrings` list.
  - Add: if `v.contextTokens` is present, it must be a finite number
    (`if (v.contextTokens !== undefined && !isFiniteNumber(v.contextTokens))
    return ...`). Absent is allowed.

Snapshot **capture** (`capture.ts`) and **restore** (`restore.ts`, `model.ts`)
pass `SnapshotOtel` opaquely and need no changes.

## Testing

Pure unit tests, matching the existing test style (no tmux spawned).

### `src/__tests__/otel-receiver.test.ts`
- Remove the cost-accumulation tests ("accumulates cost across api_request
  events", "api_request without cost_usd leaves cost unchanged") and any
  `costUsd`/`lastTool` assertions in the snapshot round-trip tests.
- Extend the `makeOtlpPayload` helper to support `inputTokens`,
  `cacheCreationTokens` (already present), and `querySource`.
- Add tests:
  - main-thread request (`query_source = "repl_main_thread"`) sets
    `contextTokens = input + cache_read + cache_creation`.
  - a later, **smaller** main-thread request **lowers** `contextTokens`
    (latest-wins, proves it's not a high-water mark in the modern path).
  - a subagent request (`query_source = "some-agent"`) does **not** change
    `contextTokens`.
  - a `"compact"` request does not change `contextTokens`.
  - absent `query_source` uses the high-water max (a later smaller request does
    **not** lower it).
  - `compaction` resets `contextTokens` to 0.
  - snapshot get/set round-trips `contextTokens`; an old snapshot without
    `contextTokens` restores as `0`.

### `src/__tests__/session-view.test.ts`
- Replace cost/tool/idle row-3 expectations with context-figure expectations:
  - promoted: `contextText` left + `STATE` right; context dropped first when
    width is tight; `labelCol` points at the state label.
  - non-promoted: context-only, `labelCol = -1`.
  - `formatContext` boundaries: `0 → ""`, `8_400 → "8k"`, `112_000 → "112k"`,
    `1_200_000 → "1.2M"`.
  - the unified-timer fallback no longer consults `lastTool`.

### `src/__tests__/sidebar.test.ts`
- Update any render-plan assertions that referenced the old cost/tool row-3
  content.

### `src/__tests__/snapshot/schema.test.ts` and `restore-links-upsert.test.ts`
- Update fixtures: drop `costUsd`/`lastTool`, add `contextTokens` where
  relevant; add a case asserting an OTEL snapshot **without** `contextTokens`
  still validates.

## Out of scope / non-goals

- No new jmux config (no context-window map, no denominator setting).
- No change to the `cacheTimers` toggle or the row-2 cache countdown timer.
- No change to row 1 (name / mode badge / linear id) or row 2 (branch / timer /
  MR id / pipeline glyph).
- No absolute-threshold coloring of the context figure.

## Known limitation

If a session runs an **old Claude Code** that emits neither `query_source` nor a
`compaction` event, the legacy high-water `contextTokens` can read stale-high
after a `/clear`. Modern clients (which emit `query_source`) are unaffected — the
figure always tracks the latest main-loop context size.
