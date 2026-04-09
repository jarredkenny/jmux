# Cache Expiry Countdown Timer

Display a per-session countdown timer in the jmux sidebar showing time remaining before Claude's prompt cache expires. Driven by real telemetry from Claude Code's OpenTelemetry integration.

## Context

Claude's API caches prompt prefixes with a 5-minute TTL that resets on each request. Cache reads cost 90% less than uncached input tokens. Knowing whether a session's cache is warm or cold helps users decide which session to interact with next — sending a prompt to a warm session saves significant cost.

jmux already tracks per-session activity and attention state via tmux options. This feature adds cache-awareness by consuming Claude Code's native OTel telemetry, which includes actual cache hit/miss data on every API request.

## Architecture

Six components, each small and focused:

```
Claude Code (in tmux pane)
    │  OTel log export (HTTP/JSON, every ~5s)
    ▼
OTLP Receiver (src/otel-receiver.ts)
    │  Extracts api_request events, maps to tmux session via resource attribute
    ▼
Cache Timer State (Map<sessionId, CacheTimerState>)
    │  Tracks last request time + whether cache was hit
    ▼
Sidebar (src/sidebar.ts)
    │  Renders color-coded countdown on detail row
    ▼
Render loop (1s tick while any timer is active)

Settings toggle (config.json + command palette)
```

### 1. OTLP Receiver — `src/otel-receiver.ts`

A minimal HTTP server using `Bun.serve()`:

- Binds to `127.0.0.1:0` (OS-assigned port to avoid collisions with multiple jmux instances)
- Handles `POST /v1/logs` — the only OTLP endpoint we need
- Returns 200 OK for all other routes (Claude Code may probe `/v1/metrics` or `/v1/traces`)
- Parses OTLP JSON: walks `resourceLogs[].scopeLogs[].logRecords[]`
- Filters for records where the event body/attributes indicate `api_request`
- Extracts from each matching record:
  - `cache_read_tokens` (number) — tokens read from cache (> 0 means cache was hit)
  - `cache_creation_tokens` (number) — tokens written to cache
  - Timestamp of the event
- Reads `tmux_session_id` from `resourceLogs[].resource.attributes[]` to identify the source tmux session

Exported interface:

```typescript
interface CacheTimerState {
  lastRequestTime: number;  // Date.now() when the api_request event was received
  cacheWasHit: boolean;     // cache_read_tokens > 0 on the last request
}

class OtelReceiver {
  start(): Promise<number>;                              // Returns bound port
  stop(): void;
  getTimerState(sessionId: string): CacheTimerState | null;
  getActiveSessionIds(): string[];                       // Sessions with timer state
  pruneExcept(activeSessionIds: string[]): void;         // Remove stale entries
  onUpdate: ((sessionId: string) => void) | null;        // Callback when state changes
}
```

### 2. Environment Injection

During startup, after the existing `set-environment -g JMUX 1` (main.ts ~line 1462), inject OTel configuration as tmux global environment variables:

```
set-environment -g CLAUDE_CODE_ENABLE_TELEMETRY 1
set-environment -g OTEL_LOGS_EXPORTER otlp
set-environment -g OTEL_EXPORTER_OTLP_PROTOCOL http/json
set-environment -g OTEL_EXPORTER_OTLP_ENDPOINT http://127.0.0.1:<port>
```

The `<port>` is the dynamically assigned port from the OTLP receiver, which must start before these commands run.

`OTEL_RESOURCE_ATTRIBUTES` must be set per-session (not global) because it contains the tmux session ID:

- At startup: loop over all existing sessions, run `set-environment -t <session> OTEL_RESOURCE_ATTRIBUTES tmux_session_id=<session_id>` for each
- In the new-session handler: set the same env var on the newly created session immediately after `new-session -d`
- The tmux `session_id` (e.g., `$0`, `$1`) is stable for the lifetime of a session

### 3. Cache Timer State

The `OtelReceiver` maintains a `Map<string, CacheTimerState>` keyed by tmux session ID.

On each incoming `api_request` event:
1. Look up `tmux_session_id` from the resource attributes
2. Update the map entry with `lastRequestTime = Date.now()` and `cacheWasHit = cache_read_tokens > 0`
3. Fire the `onUpdate` callback so jmux can trigger a render

The `Sidebar` queries this state during rendering. Time remaining is computed as:

```
remaining = max(0, 300 - floor((Date.now() - lastRequestTime) / 1000))
```

### 4. Sidebar Rendering

The countdown renders on the detail row (second row of each session item), right-aligned.

**Format**: `m:ss` — e.g., `4:32`, `1:05`, `0:00`. Maximum 4 characters wide plus 1 column padding from the right edge.

**Color thresholds** (all using palette colors for terminal compatibility):

| Remaining     | Color              | Attrs                          |
|---------------|--------------------|--------------------------------|
| > 180s        | Green (palette 2)  | `{ fg: 2, fgMode: Palette }`  |
| 30s – 180s    | Yellow (palette 3) | `{ fg: 3, fgMode: Palette }`  |
| 1s – 29s      | Red (palette 1)    | `{ fg: 1, fgMode: Palette }`  |
| 0s (expired)  | Dim                | `{ dim: true }`               |

**Layout rules:**

- When a timer is present, it takes the right-aligned position on the detail row
- Grouped sessions: branch left-aligned, timer right-aligned
- Ungrouped sessions: directory left-aligned, timer right-aligned (branch is dropped when space is tight — the timer is more actionable)
- Branch/directory text truncates with `…` if it would collide with the timer, following the existing truncation pattern
- When no timer state exists for a session, the detail row renders exactly as it does today
- Timer inherits the row's background color (active/hover/default) like other detail row content

**Sidebar API addition:**

```typescript
setCacheTimer(sessionId: string, state: CacheTimerState | null): void
```

**Render tick:**

The countdown needs to visually tick every second. A single `setInterval(scheduleRender, 1000)` starts when the first timer becomes active and clears when no timers remain (or on cleanup). This avoids burning cycles when no Claude Code sessions are running.

### 5. Settings Toggle

The cache timer is **on by default** and can be toggled via the command palette or settings palette.

**Config key**: `cacheTimers` (boolean) in `~/.config/jmux/config.json`. Defaults to `true` when absent.

**Palette entry** (in `buildPaletteCommands`, category `"setting"`):

```typescript
{
  id: "setting-cache-timers",
  label: `Cache timers: ${settings.cacheTimers !== false ? "on" : "off"}`,
  category: "setting",
}
```

Follows the same pattern as the `setting-wtm` toggle: reads current value from config, toggles it via `applySetting("cacheTimers", !current, "boolean")`.

**Behavior when toggled off:**

- The OTLP receiver continues running (keeps the env vars valid so Claude Code doesn't log errors about a refused connection)
- The sidebar stops rendering countdown timers — `renderSession` skips the timer display
- The 1-second render tick stops (no timers to animate)
- Timer state continues accumulating silently so toggling back on shows current data immediately

**Behavior when toggled on:**

- The 1-second render tick resumes if any timer state exists
- Sidebar renders timers with current state — no delay or warm-up needed

The config file watcher (line ~1213) hot-applies this setting without restart, same as sidebar width.

### 6. Cleanup

- `OtelReceiver.stop()` is called in the existing `cleanup()` function — shuts down the HTTP server
- The 1-second render interval clears when the last timer expires or on cleanup
- OTel env vars are tmux environment variables — they die with the tmux server
- Stale timer entries (for killed sessions) are pruned via `pruneExcept()` on each `fetchSessions` cycle: any session ID not in the current session list gets removed from the map

## Files Changed

| File | Change |
|------|--------|
| `src/otel-receiver.ts` | **New.** OTLP HTTP receiver + CacheTimerState map |
| `src/sidebar.ts` | Add `setCacheTimer()`, render countdown on detail row |
| `src/types.ts` | Export `CacheTimerState` interface |
| `src/main.ts` | Start/stop receiver, inject env vars, wire update callback, manage render tick, prune stale state, add `setting-cache-timers` to palette and handler |

## Testing

- `src/__tests__/otel-receiver.test.ts` — OTLP JSON parsing: valid payloads, missing attributes, non-api_request events, malformed JSON. Timer state management: updates, pruning, callback firing.
- `src/__tests__/sidebar.test.ts` — Extend existing tests: timer rendering at each color threshold, timer + branch truncation, timer at `0:00`, no timer when state is null, timer with active/hover backgrounds.

No integration tests — consistent with the existing test strategy.

## Not in Scope

- Surfacing token counts, cost data, or model info in the sidebar (future possibility enabled by this architecture)
- Configurable TTL (hardcoded to 300s; the 1-hour TTL option could be added later)
- Any changes to the `--install-agent-hooks` flow — this feature is fully automatic via env vars
