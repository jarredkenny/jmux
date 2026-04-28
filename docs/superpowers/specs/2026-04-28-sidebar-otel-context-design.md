# Sidebar OTEL Context

Surface richer per-session context in the sidebar by consuming more of the OpenTelemetry signal stream Claude Code already emits.

## Background

`OtelReceiver` currently only inspects `event.name === "api_request"` log records and extracts a single boolean (`cacheWasHit`) plus a timestamp, used to drive the cache-timer color in the sidebar's row 2. Everything else Claude Code emits — errors, tool results, prompts, mode changes, MCP connection events, compaction, cost — is dropped on the floor.

This design extends the receiver and the sidebar render path so that:

1. **Every session card** picks up small **alert** and **mode** indicators (categories A and D from the brainstorm).
2. **The active or hovered session** expands by one extra row carrying running cost, last tool, and idle time (category B).

We are intentionally not building out `infoPanelWidth` as a separate detail panel in this iteration. All new information lives on the existing card.

## Scope

In-scope:

- Extend `OtelReceiver` to process `api_error`, `api_retries_exhausted`, `tool_result`, `user_prompt`, `compaction`, `permission_mode_changed`, `mcp_server_connection` event types in addition to `api_request`.
- Track richer per-session state, accumulating cost across `api_request` events.
- Extend the sidebar's col-1 indicator priority to include an error glyph and an MCP-down glyph.
- Render a single mode badge on row 1 between the session name and the Linear ID.
- Conditionally expand the active *or* hovered session's card from 2 rows to 3 rows. The third row shows cost, last tool with duration, and idle time.

Out-of-scope:

- The `infoPanelWidth` detail panel.
- Mode-shifting row 2 to display error messages or compaction text (rejected during brainstorming).
- Token-count display, lines-of-code counters, active-time totals, MCP-server-name detail (subsumed by simpler signals or low-yield).
- Persisting OTEL state across jmux restarts. The state lives in memory and starts fresh on every launch, same as today.

## Architecture

### Data model

Replace the existing `CacheTimerState` with a richer `SessionOtelState`. The cache-timer fields stay; new fields are added alongside.

```ts
type ErrorState = {
  type: "api_error" | "api_retries_exhausted";
  timestamp: number;        // ms
};

type PermissionMode = "default" | "plan" | "accept-edits";

type LastTool = {
  name: string;             // e.g. "Edit", "Bash"
  durationMs: number;
  success: boolean;
  timestamp: number;
};

type SessionOtelState = {
  // Existing — kept for cache-timer compatibility
  lastRequestTime: number;
  cacheWasHit: boolean;

  // New
  costUsd: number;                        // cumulative across session lifetime
  lastError: ErrorState | null;           // cleared on next successful api_request
  failedMcpServers: Set<string>;          // server names currently in failed state
  permissionMode: PermissionMode;         // default unless changed
  lastCompactionTime: number | null;      // ms; drives transient ⊕ marker
  lastTool: LastTool | null;
  lastUserPromptTime: number | null;      // ms
};
```

`CacheTimerState` is renamed to `SessionOtelState` in `src/types.ts`. Existing call sites that read `lastRequestTime` and `cacheWasHit` continue to work unchanged.

### OtelReceiver changes

`src/otel-receiver.ts` grows from a one-event handler into a small dispatcher. The state map type becomes `Map<string, SessionOtelState>`. New per-event handlers update the relevant slice and call `onUpdate`.

| Event | Action |
|---|---|
| `api_request` | Update `lastRequestTime`, `cacheWasHit`. Add `cost_usd` attribute to `costUsd`. Clear `lastError` if set (the next successful request implicitly acks the prior error). |
| `api_error` | Set `lastError = { type: "api_error", timestamp }`. |
| `api_retries_exhausted` | Set `lastError = { type: "api_retries_exhausted", timestamp }`. |
| `tool_result` | Set `lastTool` with the tool-name attribute, `duration_ms`, `success`. |
| `user_prompt` | Set `lastUserPromptTime` to record timestamp. |
| `compaction` | Set `lastCompactionTime`. |
| `permission_mode_changed` | Set `permissionMode` from the `mode` attribute. Map unknown modes to `"default"`. |
| `mcp_server_connection` | Read the server-name attribute. If state is `"connected"`, remove the name from `failedMcpServers`. If `"failed"` or `"disconnected"`, add it. Events without a server name are ignored. |

State initialization uses safe defaults: `costUsd: 0`, `permissionMode: "default"`, all nullable fields `null`, `failedMcpServers: new Set()`. The state map entry is created lazily on first event for a given `tmux_session_name`.

The OTLP attribute extraction helpers (`findAttrString`, `findAttrNumber`) gain a `findAttrDouble` for `cost_usd`. Attribute keys follow the names documented in Claude Code's monitoring guide; if a key is absent, the field stays at its current value (no overwrite with zero).

The receiver remains stateless across restarts. There is no persistence layer.

### Sidebar render plan

`src/sidebar.ts` learns about variable-height session items. Today `itemHeight` returns `2` for every session. It will return `3` when that session is "expanded" and `2` otherwise.

Expansion rule:

```
expandedSessionId = hoveredSessionId ?? activeSessionId
```

`hoveredSessionId` is the session resolved from `hoveredRow` via `rowToSessionIndex` — hovering a group header, spacer, or empty row counts as no hover. If a session row is being hovered, that session expands. Otherwise the active session expands. At most one session is expanded at any moment.

`buildRenderPlan` gains an `expandedSessionId: string | null` argument and stores `expanded: boolean` on each `RenderItem` of type `"session"`. The plan is rebuilt whenever:

- `setActiveSession` is called (new — currently it just stores the id).
- `setHoveredRow` resolves to a different session than before (new — currently hover only affects rendering, not layout). Hover changes that resolve to the same session, or to no session, do not trigger a rebuild.
- `updateSessions` / `toggleGroup` / `setPinnedSessions` is called (existing).

`itemHeight` reads `item.expanded` for sessions. Scroll math (`viewportHeight`, `clampScroll`, `scrollToActive`) works unchanged because it already sums `itemHeight` across items.

### Rendering

`renderSession` is extended to draw a third row when `item.expanded` is true. The third row is rendered immediately below `detailRow`, with the same active/hover background fill and active marker bar.

**Col-1 indicator priority** (top-down, highest wins, mutually exclusive):

1. `⨯` red bold — `lastError` is set
2. `⊘` dim red — `failedMcpServers.size > 0`
3. `!` orange bold — `session.attention` (existing Stop hook)
4. `●` green — activity (existing)
5. nothing

Rendered on row 1 col 1, the same slot used today. Color attributes are added to the existing constant table in `sidebar.ts`.

**Mode badge** sits on row 1 between the truncated session name and the Linear ID. It's a single character with a 1-cell pad on either side:

| Mode | Glyph | Color |
|---|---|---|
| `plan` | `P` | cyan (palette 6) |
| `accept-edits` | `A` | yellow (palette 3) |
| `default` | (none) | — |

Plus a transient compaction marker that sits in the same slot when neither plan nor accept-edits applies and `Date.now() - lastCompactionTime < 30_000`:

- `⊕` dim — recent compaction

Compaction takes the slot only when the mode is `default`; otherwise the mode badge wins. The 30 s window is a constant (`COMPACTION_FLASH_MS`) at the top of `sidebar.ts`.

The badge sits two columns to the left of `linearIdCol` (1 col for the badge glyph + 1 col of pad). The existing `linearIdCol` math is unchanged. When the badge is present without a Linear ID, the badge anchors at `width - 2`. The session-name truncation `nameMaxLen` shrinks by 2 when a badge is present so the name never collides with the badge column.

**Row 3** content (active/hovered session only) is drawn through a new `buildSessionRow3` helper added to `src/session-view.ts`, mirroring the existing `buildSessionView` pattern. The view returns three pre-formatted strings:

```
costText   = "$1.23"   // omitted when costUsd === 0
toolText   = "Edit 1.2s"   // omitted when lastTool is null
idleText   = "3m idle" // omitted when lastUserPromptTime is null
```

Layout, left to right, separated by two-space gaps:

```
 $1.23  Edit 1.2s        3m idle
```

Cost is left-aligned at col 3 (matching row 2's branch start). Idle is right-aligned at the right edge. Last-tool floats in the middle gap. The drop rule applies only across fields that would otherwise render (omitted-because-empty fields are not in the contention set): if the remaining fields don't fit, drop idle first, then last-tool. Cost is never dropped — if cost is the only field left and still doesn't fit, truncate it.

Tool duration is formatted as `Ns` for sub-minute, `NmNs` over a minute. Idle time uses the same humanization as elsewhere in the sidebar (the `formatRelative` helper in `session-view.ts`, already extended for cache-timer text).

### Wire-up in main.ts

`main.ts` already calls `otelReceiver.onUpdate = (sessionName) => sidebar.setCacheTimer(...)`. That single call site grows to push the full `SessionOtelState`:

```ts
otelReceiver.onUpdate = (sessionName) => {
  const state = otelReceiver.getSessionState(sessionName);
  if (state) sidebar.setSessionOtelState(sessionName, state);
  scheduleRender();
};
```

`Sidebar.setCacheTimer` is renamed to `setSessionOtelState` and stores the full struct. `buildSessionView` (already invoked per-session in `renderSession`) reads from this struct to derive both the existing cache-timer fields and the new col-1 indicator selection / mode badge selection.

Pruning: `pruneExcept` already removes state for tmux sessions that no longer exist. No change needed — the same call covers the new fields.

## Data flow

```
Claude Code (per tmux session)
  ↓ OTLP /v1/logs POST
OtelReceiver.processRecord
  ↓ dispatch by event.name
SessionOtelState (map keyed by tmux_session_name)
  ↓ onUpdate(sessionName)
main.ts → Sidebar.setSessionOtelState
  ↓
buildSessionView (existing) + buildSessionRow3 (new)
  ↓
Sidebar.renderSession → CellGrid → Renderer → terminal
```

The session-name → tmux-session-id resolution in main.ts is unchanged; sessions are matched by tmux session *name* on the OTEL side and by *id* in the sidebar's `activitySet`. The existing matching logic in main.ts that maps OTEL updates to session ids is reused as-is.

## Error handling

- **Malformed OTLP body** — already swallowed silently in `handleRequest`. No change.
- **Unknown event names** — silently ignored (existing behavior). Adding new handlers does not change this.
- **Missing attributes** — handlers do not overwrite fields when their source attribute is absent. A `tool_result` without `tool_name` is dropped. A `permission_mode_changed` without `mode` does nothing. This avoids erasing good state with partial events.
- **Unknown permission modes** — coerced to `"default"`. If Claude Code introduces a new mode, jmux degrades to "no badge" rather than crashing.
- **Duplicate MCP events** — tracking by server-name set is idempotent, so duplicate `failed`/`connected` events for the same server do not double-count.
- **Cost overflow** — none expected in practice; `number` is fine for thousands of USD.
- **Render-path errors** — none beyond what already exists. The mode badge and row-3 helpers degrade to empty strings on missing data.

## Testing

All tests are pure unit tests under `src/__tests__/`, matching the existing pattern. No tests spawn tmux or hit the OTLP port for real.

### `otel-receiver.test.ts` (new)

For each event type, build a synthetic OTLP body and assert the resulting `SessionOtelState` shape:

- `api_request` updates `lastRequestTime`, `cacheWasHit`, accumulates `costUsd`, clears `lastError` when previously set.
- `api_error` sets `lastError` with type `"api_error"` and a timestamp.
- `api_retries_exhausted` sets `lastError` with type `"api_retries_exhausted"`.
- `tool_result` sets `lastTool` with the right name, duration, success.
- `user_prompt` sets `lastUserPromptTime`.
- `compaction` sets `lastCompactionTime`.
- `permission_mode_changed` sets `permissionMode`; unknown modes coerce to `"default"`.
- `mcp_server_connection` adds the server name to `failedMcpServers` on `failed`/`disconnected`, removes it on `connected`. Duplicate events are idempotent.
- Pruning still removes state for sessions not in the active list.

### `sidebar.test.ts` (extend)

- `expandedSessionId` resolves to hovered when both hover and active are set, falls back to active when no hover.
- A session item's height is 3 when expanded, 2 otherwise. Total layout height changes accordingly.
- Scrolling math respects expanded heights — `scrollToActive` brings a 3-row session fully into view.
- Col-1 indicator priority order: error glyph wins over MCP-down, MCP-down wins over Stop-hook attention, attention wins over activity dot.
- Mode badge renders `P` for plan, `A` for accept-edits, nothing for default.
- Compaction marker renders `⊕` only when mode is default and `Date.now() - lastCompactionTime < 30_000`.
- Linear-ID column shifts left by one when a mode badge is present.
- Row 3 renders cost, last tool, idle when all three fit. Idle drops first, then last-tool, on overflow.
- Row 3 omits cost when `costUsd === 0`, omits last-tool when `lastTool === null`, omits idle when `lastUserPromptTime === null`.

### `session-view.test.ts` (extend)

- `buildSessionRow3` formats cost (`$1.23`), tool duration (`Edit 1.2s`, `Bash 1m20s`), idle (`3m idle`).
- Drop ordering on overflow.

## Migration / compatibility

- `CacheTimerState` rename is internal — exported type is renamed in `src/types.ts`. Tests and the small number of import sites are updated in the same change.
- Existing settings (`cacheTimersEnabled` on the sidebar) keep working as before; cache timer is one projection of `SessionOtelState`.
- No config file changes. No persisted state. Restarting jmux clears OTEL state, same as today.
- **No feature flag.** The new indicators, mode badge, and row-3 expansion are always on. None of them disrupt the existing baseline (col-1 indicator stays empty when nothing is wrong; mode badge stays empty in default mode; row 3 only appears for the focused session). If feedback shows a particular signal is noisy, gate that signal specifically rather than the whole feature.

## Open questions resolved during brainstorming

- **Permission-prompt-pending alert**: dropped. Claude Code emits `tool_decision` only after the user decides; there is no "waiting" signal in OTEL.
- **Cost reset semantics**: cost accumulates across the lifetime of the in-memory session entry. A jmux restart, or `pruneExcept` removing a session that's been killed, resets the counter. This matches the cache-timer state lifecycle.
- **Expansion trigger**: hover takes precedence over active. At most one session expands at a time.
