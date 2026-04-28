# Sidebar OTEL Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface richer per-session telemetry (errors, MCP failures, mode badges, cost/tool/idle on focus) in the sidebar by consuming the full Claude Code OTLP log stream.

**Architecture:** Extend `OtelReceiver` from a single-event handler into a dispatcher that updates a per-session `SessionOtelState` struct (renamed from `CacheTimerState`). Sidebar uses that struct to drive new col-1 indicator priorities, a row-1 mode badge, and a conditional row-3 expansion for the focused session. No new modules — all changes land in five existing files plus three test files.

**Tech Stack:** Bun 1.3.8+, TypeScript (strict), `bun:test`. Pure unit tests under `src/__tests__/` — no tmux spawn, no real OTLP server (most tests POST to a localhost server the receiver itself binds, but no Claude Code dependency).

**Spec:** `docs/superpowers/specs/2026-04-28-sidebar-otel-context-design.md`

---

## File Map

| File | Change |
|---|---|
| `src/types.ts` | Rename `CacheTimerState` → `SessionOtelState`; add new fields. |
| `src/otel-receiver.ts` | Dispatch on `event.name`; new event handlers; new `getSessionState` getter; `findAttrDouble` helper. |
| `src/session-view.ts` | Extend `SessionView` with mode/error/MCP fields; add `buildSessionRow3` helper. |
| `src/sidebar.ts` | Variable item heights; `expandedSessionId` resolution; new col-1 glyph priorities; mode badge + compaction marker; row 3 rendering; `setCacheTimer` → `setSessionOtelState`. |
| `src/main.ts` | Update `otelReceiver.onUpdate` wire-up to push full state. |
| `src/__tests__/otel-receiver.test.ts` | Tests for each new event handler + cost accumulation + error clear. |
| `src/__tests__/sidebar.test.ts` | Tests for expansion, new glyph priorities, mode badge, row 3 layout. |
| `src/__tests__/session-view.test.ts` | Tests for `buildSessionRow3` formatting and drop ordering. |

---

## Task 1: Rename `CacheTimerState` → `SessionOtelState` and add new fields

**Files:**
- Modify: `src/types.ts:57-60`
- Modify: `src/otel-receiver.ts:1` (import), `src/otel-receiver.ts:5` (state map type), `src/otel-receiver.ts:22` (return type)
- Modify: `src/session-view.ts:1` (import), `src/session-view.ts:43` (parameter type)
- Modify: `src/sidebar.ts:1` (import), `src/sidebar.ts:266` (private field type), `src/sidebar.ts:319` (parameter type)
- Modify: `src/__tests__/session-view.test.ts:3` (import), tests at line 118 and 125 (variable types)

This is a pure refactor. No behavior change. Existing tests must keep passing.

- [ ] **Step 1: Update the type declaration**

Replace the `CacheTimerState` interface in `src/types.ts:57-60` with:

```ts
export type ErrorState = {
  type: "api_error" | "api_retries_exhausted";
  timestamp: number;
};

export type PermissionMode = "default" | "plan" | "accept-edits";

export interface LastTool {
  name: string;
  durationMs: number;
  success: boolean;
  timestamp: number;
}

export interface SessionOtelState {
  // Cache-timer fields (existing)
  lastRequestTime: number;
  cacheWasHit: boolean;

  // New
  costUsd: number;
  lastError: ErrorState | null;
  failedMcpServers: Set<string>;
  permissionMode: PermissionMode;
  lastCompactionTime: number | null;
  lastTool: LastTool | null;
  lastUserPromptTime: number | null;
}

export function makeSessionOtelState(): SessionOtelState {
  return {
    lastRequestTime: 0,
    cacheWasHit: false,
    costUsd: 0,
    lastError: null,
    failedMcpServers: new Set(),
    permissionMode: "default",
    lastCompactionTime: null,
    lastTool: null,
    lastUserPromptTime: null,
  };
}
```

- [ ] **Step 2: Update every import + usage from `CacheTimerState` → `SessionOtelState`**

Run a global search-and-replace, then verify each site:

```bash
grep -rln "CacheTimerState" src
```

Update each file's import and any explicit annotations. In `src/otel-receiver.ts`, also rename the private field `state` and the public method `getTimerState`:

```ts
// src/otel-receiver.ts
import type { SessionOtelState } from "./types";
import { makeSessionOtelState } from "./types";

export class OtelReceiver {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private state = new Map<string, SessionOtelState>();
  onUpdate: ((sessionName: string) => void) | null = null;

  // ... existing methods ...

  getSessionState(key: string): SessionOtelState | null {
    return this.state.get(key) ?? null;
  }

  /** @deprecated alias kept for one task — removed in Task 9 */
  getTimerState(key: string): SessionOtelState | null {
    return this.getSessionState(key);
  }
```

Inside `processRecord`, when creating an entry, use the factory:

```ts
private processRecord(record: any, sessionName: string): void {
  const attrs = record?.attributes;
  if (!Array.isArray(attrs)) return;

  const eventName = this.findAttrString(attrs, "event.name");
  if (eventName !== "api_request") return;

  const cacheReadTokens = this.findAttrNumber(attrs, "cache_read_tokens");
  const cacheWasHit = cacheReadTokens > 0;

  const existing = this.state.get(sessionName) ?? makeSessionOtelState();
  existing.lastRequestTime = Date.now();
  existing.cacheWasHit = cacheWasHit;
  this.state.set(sessionName, existing);

  this.onUpdate?.(sessionName);
}
```

In `src/sidebar.ts`, rename the private field:

```ts
private otelStates = new Map<string, SessionOtelState>();
```

Keep `setCacheTimer`'s public signature unchanged for now (existing tests rely on it accepting only the cache fields). Internally, merge the cache fields onto a full record:

```ts
setCacheTimer(
  sessionId: string,
  state: { lastRequestTime: number; cacheWasHit: boolean } | null,
): void {
  if (state === null) {
    this.otelStates.delete(sessionId);
    return;
  }
  const existing = this.otelStates.get(sessionId) ?? makeSessionOtelState();
  existing.lastRequestTime = state.lastRequestTime;
  existing.cacheWasHit = state.cacheWasHit;
  this.otelStates.set(sessionId, existing);
}
```

Update `renderSession` to read from `otelStates` (the existing `cacheTimers.get(...)` becomes `otelStates.get(...)`). When projecting onto the view, pass `state` to `buildSessionView` as before — it reads only `lastRequestTime` / `cacheWasHit`. The `cacheTimersEnabled` flag is still consulted in `renderSession` exactly as before.

Add the import: `import { makeSessionOtelState } from "./types";`

In `src/session-view.ts:43`, update the parameter type to `SessionOtelState | undefined`. The existing fields (`lastRequestTime`, `cacheWasHit`) are already a subset.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

Run: `bun run typecheck && bun test`
Expected: PASS — same number of tests as before this task. The rename is internal; no observable behavior changes.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/otel-receiver.ts src/session-view.ts src/sidebar.ts src/__tests__/session-view.test.ts
git commit -m "$(cat <<'EOF'
refactor: rename CacheTimerState to SessionOtelState and add new fields

Cache-timer fields are kept; new fields (costUsd, lastError,
failedMcpServers, permissionMode, lastCompactionTime, lastTool,
lastUserPromptTime) are populated by later changes.
EOF
)"
```

---

## Task 2: Accumulate cost from `api_request` events

**Files:**
- Modify: `src/otel-receiver.ts` (add `findAttrDouble`; update `api_request` handler)
- Modify: `src/__tests__/otel-receiver.test.ts` (add cost accumulation tests; extend `makeOtlpPayload` to accept cost)

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/otel-receiver.test.ts`. First, extend the helper to accept a `costUsd` field:

```ts
function makeOtlpPayload(opts: {
  sessionName?: string;
  eventName?: string;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  attributes?: Array<{ key: string; value: any }>;
}): object {
  const {
    sessionName = "main",
    eventName = "api_request",
    cacheReadTokens = 100,
    cacheCreationTokens = 0,
    costUsd,
    attributes,
  } = opts;

  const baseAttrs: any[] = [
    { key: "event.name", value: { stringValue: eventName } },
    { key: "cache_read_tokens", value: { stringValue: String(cacheReadTokens) } },
    { key: "cache_creation_tokens", value: { stringValue: String(cacheCreationTokens) } },
  ];
  if (costUsd !== undefined) {
    baseAttrs.push({ key: "cost_usd", value: { doubleValue: costUsd } });
  }
  if (attributes) baseAttrs.push(...attributes);

  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "tmux_session_name", value: { stringValue: sessionName } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                body: { stringValue: `claude_code.${eventName}` },
                attributes: baseAttrs,
              },
            ],
          },
        ],
      },
    ],
  };
}
```

Then add the test:

```ts
test("accumulates cost across api_request events", async () => {
  const port = await receiver.start();

  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeOtlpPayload({ sessionName: "$c", costUsd: 0.42 })),
  });
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeOtlpPayload({ sessionName: "$c", costUsd: 1.08 })),
  });

  const state = receiver.getSessionState("$c");
  expect(state).not.toBeNull();
  expect(state!.costUsd).toBeCloseTo(1.50, 5);
});

test("api_request without cost_usd leaves cost unchanged", async () => {
  const port = await receiver.start();

  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeOtlpPayload({ sessionName: "$d", costUsd: 0.5 })),
  });
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeOtlpPayload({ sessionName: "$d" })),
  });

  expect(receiver.getSessionState("$d")!.costUsd).toBeCloseTo(0.5, 5);
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/otel-receiver.test.ts -t "cost"`
Expected: FAIL — `costUsd` is 0 because nothing reads `cost_usd` yet.

- [ ] **Step 3: Add `findAttrDouble` and update the `api_request` handler**

Add to `src/otel-receiver.ts`, at the end of the class:

```ts
private findAttrDouble(attrs: any[], key: string): number | null {
  for (const attr of attrs) {
    if (attr?.key === key) {
      const v = attr?.value;
      if (!v) return null;
      if (v.doubleValue !== undefined) {
        return typeof v.doubleValue === "number" ? v.doubleValue : parseFloat(v.doubleValue);
      }
      if (v.intValue !== undefined) {
        return typeof v.intValue === "number" ? v.intValue : parseFloat(v.intValue);
      }
      if (v.stringValue !== undefined) {
        const parsed = parseFloat(v.stringValue);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    }
  }
  return null;
}
```

Update the `api_request` block in `processRecord`:

```ts
if (eventName === "api_request") {
  const cacheReadTokens = this.findAttrNumber(attrs, "cache_read_tokens");
  const cost = this.findAttrDouble(attrs, "cost_usd");

  const existing = this.state.get(sessionName) ?? makeSessionOtelState();
  existing.lastRequestTime = Date.now();
  existing.cacheWasHit = cacheReadTokens > 0;
  if (cost !== null) existing.costUsd += cost;
  this.state.set(sessionName, existing);

  this.onUpdate?.(sessionName);
  return;
}
```

(Restructure `processRecord` so each event-name branch is a clear `if (eventName === "X") { ...; return; }` — this is the dispatcher pattern later tasks extend.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: PASS — both new tests green; all existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/otel-receiver.ts src/__tests__/otel-receiver.test.ts
git commit -m "feat(otel): accumulate session cost from api_request events"
```

---

## Task 3: Track `api_error` and `api_retries_exhausted`

**Files:**
- Modify: `src/otel-receiver.ts` (extend dispatcher)
- Modify: `src/__tests__/otel-receiver.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("api_error sets lastError", async () => {
  const port = await receiver.start();
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeOtlpPayload({ sessionName: "$e", eventName: "api_error" })),
  });

  const state = receiver.getSessionState("$e");
  expect(state).not.toBeNull();
  expect(state!.lastError).not.toBeNull();
  expect(state!.lastError!.type).toBe("api_error");
  expect(state!.lastError!.timestamp).toBeGreaterThan(0);
});

test("api_retries_exhausted sets lastError with that type", async () => {
  const port = await receiver.start();
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeOtlpPayload({ sessionName: "$r", eventName: "api_retries_exhausted" })),
  });

  expect(receiver.getSessionState("$r")!.lastError!.type).toBe("api_retries_exhausted");
});

test("successful api_request clears lastError", async () => {
  const port = await receiver.start();

  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeOtlpPayload({ sessionName: "$x", eventName: "api_error" })),
  });
  expect(receiver.getSessionState("$x")!.lastError).not.toBeNull();

  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeOtlpPayload({ sessionName: "$x", eventName: "api_request" })),
  });
  expect(receiver.getSessionState("$x")!.lastError).toBeNull();
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/otel-receiver.test.ts -t "api_error|retries|clears lastError"`
Expected: FAIL — `lastError` stays null because nothing handles those events.

- [ ] **Step 3: Add the handlers**

In `src/otel-receiver.ts`, extend `processRecord`. After the `api_request` branch, add:

```ts
if (eventName === "api_error" || eventName === "api_retries_exhausted") {
  const existing = this.state.get(sessionName) ?? makeSessionOtelState();
  existing.lastError = {
    type: eventName,
    timestamp: Date.now(),
  };
  this.state.set(sessionName, existing);
  this.onUpdate?.(sessionName);
  return;
}
```

And in the `api_request` branch, after `existing.cacheWasHit = ...`, add:

```ts
existing.lastError = null;
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/otel-receiver.ts src/__tests__/otel-receiver.test.ts
git commit -m "feat(otel): track api_error and api_retries_exhausted; clear on next success"
```

---

## Task 4: Track `tool_result` events

**Files:**
- Modify: `src/otel-receiver.ts`
- Modify: `src/__tests__/otel-receiver.test.ts`

The Claude Code monitoring docs name the tool attribute `tool_name` and the duration attribute `duration_ms`. Success is encoded as a `success` boolean attribute (we treat any non-`false` value as success since absence shouldn't downgrade to "failed").

- [ ] **Step 1: Write the failing test**

```ts
test("tool_result sets lastTool", async () => {
  const port = await receiver.start();
  const payload = makeOtlpPayload({
    sessionName: "$t",
    eventName: "tool_result",
    attributes: [
      { key: "tool_name", value: { stringValue: "Edit" } },
      { key: "duration_ms", value: { intValue: "1234" } },
      { key: "success", value: { boolValue: true } },
    ],
  });
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const state = receiver.getSessionState("$t");
  expect(state!.lastTool).not.toBeNull();
  expect(state!.lastTool!.name).toBe("Edit");
  expect(state!.lastTool!.durationMs).toBe(1234);
  expect(state!.lastTool!.success).toBe(true);
  expect(state!.lastTool!.timestamp).toBeGreaterThan(0);
});

test("tool_result without tool_name is ignored", async () => {
  const port = await receiver.start();
  const payload = makeOtlpPayload({
    sessionName: "$tn",
    eventName: "tool_result",
    attributes: [
      { key: "duration_ms", value: { intValue: "100" } },
    ],
  });
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // State entry not created when there's nothing to record
  expect(receiver.getSessionState("$tn")).toBeNull();
});
```

You will also need a `findAttrBool` helper. Add it under `findAttrDouble`:

```ts
private findAttrBool(attrs: any[], key: string): boolean | null {
  for (const attr of attrs) {
    if (attr?.key === key) {
      const v = attr?.value;
      if (!v) return null;
      if (v.boolValue !== undefined) return Boolean(v.boolValue);
      if (v.stringValue !== undefined) return v.stringValue === "true";
      return null;
    }
  }
  return null;
}
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/otel-receiver.test.ts -t "tool_result"`
Expected: FAIL.

- [ ] **Step 3: Add the handler**

In `processRecord`, add a branch:

```ts
if (eventName === "tool_result") {
  const toolName = this.findAttrString(attrs, "tool_name");
  if (!toolName) return;
  const durationMs = this.findAttrNumber(attrs, "duration_ms");
  const success = this.findAttrBool(attrs, "success");

  const existing = this.state.get(sessionName) ?? makeSessionOtelState();
  existing.lastTool = {
    name: toolName,
    durationMs,
    success: success !== false,
    timestamp: Date.now(),
  };
  this.state.set(sessionName, existing);
  this.onUpdate?.(sessionName);
  return;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/otel-receiver.ts src/__tests__/otel-receiver.test.ts
git commit -m "feat(otel): track tool_result events"
```

---

## Task 5: Track `user_prompt` events

**Files:**
- Modify: `src/otel-receiver.ts`
- Modify: `src/__tests__/otel-receiver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("user_prompt sets lastUserPromptTime", async () => {
  const port = await receiver.start();
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeOtlpPayload({ sessionName: "$u", eventName: "user_prompt" })),
  });

  const state = receiver.getSessionState("$u");
  expect(state!.lastUserPromptTime).not.toBeNull();
  expect(state!.lastUserPromptTime!).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the failing test**

Run: `bun test src/__tests__/otel-receiver.test.ts -t "user_prompt"`
Expected: FAIL.

- [ ] **Step 3: Add the handler**

In `processRecord`:

```ts
if (eventName === "user_prompt") {
  const existing = this.state.get(sessionName) ?? makeSessionOtelState();
  existing.lastUserPromptTime = Date.now();
  this.state.set(sessionName, existing);
  this.onUpdate?.(sessionName);
  return;
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/otel-receiver.ts src/__tests__/otel-receiver.test.ts
git commit -m "feat(otel): track user_prompt timestamps"
```

---

## Task 6: Track `compaction` events

**Files:**
- Modify: `src/otel-receiver.ts`
- Modify: `src/__tests__/otel-receiver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("compaction sets lastCompactionTime", async () => {
  const port = await receiver.start();
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeOtlpPayload({ sessionName: "$cp", eventName: "compaction" })),
  });

  expect(receiver.getSessionState("$cp")!.lastCompactionTime).not.toBeNull();
});
```

- [ ] **Step 2: Run the failing test**

Run: `bun test src/__tests__/otel-receiver.test.ts -t "compaction"`
Expected: FAIL.

- [ ] **Step 3: Add the handler**

```ts
if (eventName === "compaction") {
  const existing = this.state.get(sessionName) ?? makeSessionOtelState();
  existing.lastCompactionTime = Date.now();
  this.state.set(sessionName, existing);
  this.onUpdate?.(sessionName);
  return;
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/otel-receiver.ts src/__tests__/otel-receiver.test.ts
git commit -m "feat(otel): track compaction events"
```

---

## Task 7: Track `permission_mode_changed` events

**Files:**
- Modify: `src/otel-receiver.ts`
- Modify: `src/__tests__/otel-receiver.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("permission_mode_changed sets permissionMode", async () => {
  const port = await receiver.start();
  const payload = makeOtlpPayload({
    sessionName: "$pm",
    eventName: "permission_mode_changed",
    attributes: [{ key: "mode", value: { stringValue: "plan" } }],
  });
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  expect(receiver.getSessionState("$pm")!.permissionMode).toBe("plan");
});

test("permission_mode_changed coerces unknown modes to default", async () => {
  const port = await receiver.start();
  const payload = makeOtlpPayload({
    sessionName: "$pmu",
    eventName: "permission_mode_changed",
    attributes: [{ key: "mode", value: { stringValue: "future-mode" } }],
  });
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  expect(receiver.getSessionState("$pmu")!.permissionMode).toBe("default");
});

test("permission_mode_changed without mode is ignored", async () => {
  const port = await receiver.start();
  const payload = makeOtlpPayload({
    sessionName: "$pmn",
    eventName: "permission_mode_changed",
    attributes: [],
  });
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  expect(receiver.getSessionState("$pmn")).toBeNull();
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/otel-receiver.test.ts -t "permission_mode_changed"`
Expected: FAIL.

- [ ] **Step 3: Add the handler**

```ts
if (eventName === "permission_mode_changed") {
  const mode = this.findAttrString(attrs, "mode");
  if (mode === null) return;
  const normalized: PermissionMode =
    mode === "plan" || mode === "accept-edits" ? mode : "default";

  const existing = this.state.get(sessionName) ?? makeSessionOtelState();
  existing.permissionMode = normalized;
  this.state.set(sessionName, existing);
  this.onUpdate?.(sessionName);
  return;
}
```

Add the `PermissionMode` import at the top:

```ts
import type { SessionOtelState, PermissionMode } from "./types";
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/otel-receiver.ts src/__tests__/otel-receiver.test.ts
git commit -m "feat(otel): track permission_mode_changed events"
```

---

## Task 8: Track `mcp_server_connection` events

**Files:**
- Modify: `src/otel-receiver.ts`
- Modify: `src/__tests__/otel-receiver.test.ts`

The state attribute is `state` per the Claude Code docs; the server identifier is `server_name`.

- [ ] **Step 1: Write the failing tests**

```ts
test("mcp_server_connection failed adds server to failedMcpServers", async () => {
  const port = await receiver.start();
  const payload = makeOtlpPayload({
    sessionName: "$m",
    eventName: "mcp_server_connection",
    attributes: [
      { key: "server_name", value: { stringValue: "linear" } },
      { key: "state", value: { stringValue: "failed" } },
    ],
  });
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  expect(receiver.getSessionState("$m")!.failedMcpServers.has("linear")).toBe(true);
});

test("mcp_server_connection connected removes server from failed set", async () => {
  const port = await receiver.start();
  for (const state of ["failed", "connected"]) {
    const payload = makeOtlpPayload({
      sessionName: "$m2",
      eventName: "mcp_server_connection",
      attributes: [
        { key: "server_name", value: { stringValue: "linear" } },
        { key: "state", value: { stringValue: state } },
      ],
    });
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  expect(receiver.getSessionState("$m2")!.failedMcpServers.size).toBe(0);
});

test("mcp_server_connection is idempotent across duplicate events", async () => {
  const port = await receiver.start();
  for (let i = 0; i < 3; i++) {
    const payload = makeOtlpPayload({
      sessionName: "$m3",
      eventName: "mcp_server_connection",
      attributes: [
        { key: "server_name", value: { stringValue: "linear" } },
        { key: "state", value: { stringValue: "failed" } },
      ],
    });
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  expect(receiver.getSessionState("$m3")!.failedMcpServers.size).toBe(1);
});

test("mcp_server_connection without server_name is ignored", async () => {
  const port = await receiver.start();
  const payload = makeOtlpPayload({
    sessionName: "$m4",
    eventName: "mcp_server_connection",
    attributes: [{ key: "state", value: { stringValue: "failed" } }],
  });
  await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  expect(receiver.getSessionState("$m4")).toBeNull();
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/otel-receiver.test.ts -t "mcp_server"`
Expected: FAIL.

- [ ] **Step 3: Add the handler**

```ts
if (eventName === "mcp_server_connection") {
  const serverName = this.findAttrString(attrs, "server_name");
  if (!serverName) return;
  const connState = this.findAttrString(attrs, "state");

  const existing = this.state.get(sessionName) ?? makeSessionOtelState();
  if (connState === "connected") {
    existing.failedMcpServers.delete(serverName);
  } else if (connState === "failed" || connState === "disconnected") {
    existing.failedMcpServers.add(serverName);
  } else {
    return;
  }
  this.state.set(sessionName, existing);
  this.onUpdate?.(sessionName);
  return;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/otel-receiver.ts src/__tests__/otel-receiver.test.ts
git commit -m "feat(otel): track mcp_server_connection events"
```

---

## Task 9: Drop the deprecated `getTimerState` alias

**Files:**
- Modify: `src/otel-receiver.ts:22-24` (remove the alias added in Task 1)
- Modify: `src/main.ts:504` (call `getSessionState` instead)
- Modify: `src/__tests__/otel-receiver.test.ts` (any remaining `getTimerState` references)

- [ ] **Step 1: Replace the call sites**

```bash
grep -rn "getTimerState" src
```

Update `src/main.ts:504`:

```ts
const state = otelReceiver.getSessionState(sessionName);
```

Update any remaining references in `src/__tests__/otel-receiver.test.ts` (the existing tests still use `getTimerState`).

- [ ] **Step 2: Remove the alias from `OtelReceiver`**

Delete the `getTimerState` method.

- [ ] **Step 3: Run typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: PASS — no remaining references to the alias.

- [ ] **Step 4: Commit**

```bash
git add src/otel-receiver.ts src/main.ts src/__tests__/otel-receiver.test.ts
git commit -m "refactor(otel): remove deprecated getTimerState alias"
```

---

## Task 10: Variable item heights and `expandedSessionId` in the render plan

**Files:**
- Modify: `src/sidebar.ts` (`RenderItem`, `buildRenderPlan`, `itemHeight`, internal `rebuildPlan` helper)
- Modify: `src/__tests__/sidebar.test.ts`

This task only changes the *layout* — the third row will be empty in the grid. Row content lands in Task 16.

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/sidebar.test.ts`:

```ts
// Row layout reminder for ungrouped sessions:
// row 0: jmux header
// row 1: separator
// row 2: first session name (item starts here; spacer follows each session)
//
// So two ungrouped sessions α, β with α expanded (h=3):
//   α: rows 2,3,4
//   spacer: row 5
//   β: rows 6,7
// With α not expanded (h=2):
//   α: rows 2,3
//   spacer: row 4
//   β: rows 5,6

test("active session expands to 3 rows", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([
    { name: "alpha" },
    { name: "beta" },
  ]));
  sidebar.setActiveSession("$0");
  const grid = sidebar.getGrid();

  // alpha at rows 2,3,4 (expanded); spacer at 5; beta at rows 6,7
  const row6Text = Array.from(
    { length: SIDEBAR_WIDTH },
    (_, i) => grid.cells[6][i].char,
  ).join("");
  expect(row6Text).toContain("beta");
});

test("inactive sessions stay at 2 rows", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([
    { name: "alpha" },
    { name: "beta" },
    { name: "gamma" },
  ]));
  sidebar.setActiveSession("$0");
  const grid = sidebar.getGrid();

  // alpha (rows 2,3,4) — expanded
  // spacer at 5
  // beta (rows 6,7) — not expanded
  // spacer at 8
  // gamma name at row 9
  const row9Text = Array.from(
    { length: SIDEBAR_WIDTH },
    (_, i) => grid.cells[9][i].char,
  ).join("");
  expect(row9Text).toContain("gamma");
});

test("hover overrides active for expansion", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([
    { name: "alpha" },
    { name: "beta" },
  ]));
  sidebar.setActiveSession("$0");
  // First render: alpha expanded at 2,3,4; spacer 5; beta name at row 6.
  sidebar.getGrid(); // populate rowToSessionIndex
  sidebar.setHoveredRow(6); // hover beta's name row
  const grid = sidebar.getGrid();

  // Now beta is the expanded session: alpha collapses to 2 rows (2,3),
  // spacer at 4, beta expanded at 5,6,7.
  const row5Text = Array.from(
    { length: SIDEBAR_WIDTH },
    (_, i) => grid.cells[5][i].char,
  ).join("");
  expect(row5Text).toContain("beta");
});

test("hovering a group header does not trigger expansion", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([
    { name: "a", project: "proj1" },
    { name: "b", project: "proj1" },
  ]));
  sidebar.setActiveSession("$0");
  // Layout with group + active 'a' (expanded):
  //   row 2: group header
  //   row 3: spacer
  //   rows 4,5,6: 'a' (expanded)
  //   row 7: spacer
  //   rows 8,9: 'b'
  sidebar.getGrid(); // populate rowToSessionIndex with group header at 2
  sidebar.setHoveredRow(2); // hovering group header — should be a no-op for expansion
  const grid = sidebar.getGrid();

  // 'a' should remain expanded. 'b' name still at row 8.
  const row8 = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[8][i].char).join("");
  expect(row8).toContain("b");
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/sidebar.test.ts -t "expand|hover overrides"`
Expected: FAIL.

- [ ] **Step 3: Update the render plan model**

In `src/sidebar.ts`, change `RenderItem` so `session` items carry an `expanded` flag, and `buildRenderPlan` accepts an `expandedSessionId`:

```ts
type RenderItem =
  | { type: "group-header"; label: string; collapsed: boolean; sessionCount: number }
  | { type: "session"; sessionIndex: number; grouped: boolean; groupLabel?: string; expanded: boolean }
  | { type: "spacer" };

function buildRenderPlan(
  sessions: SessionInfo[],
  collapsedGroups: Set<string>,
  pinnedNames: Set<string>,
  expandedSessionId: string | null,
): { items: RenderItem[]; displayOrder: number[] } {
  // ... existing body ...
  // Wherever a session item is pushed, set:
  //   expanded: sessions[idx].id === expandedSessionId
}
```

Update both `pinnedIndices` and the per-group/ungrouped pushes. Example:

```ts
items.push({
  type: "session",
  sessionIndex: idx,
  grouped: true,
  groupLabel: PINNED_GROUP_LABEL,
  expanded: sessions[idx].id === expandedSessionId,
});
```

Update `itemHeight`:

```ts
function itemHeight(item: RenderItem): number {
  if (item.type === "session") return item.expanded ? 3 : 2;
  return 1;
}
```

Add a private `rebuildPlan()` method on `Sidebar`:

```ts
private rebuildPlan(): void {
  const { items, displayOrder } = buildRenderPlan(
    this.sessions,
    this.collapsedGroups,
    this.pinnedSessions,
    this.computeExpandedSessionId(),
  );
  this.items = items;
  this.displayOrder = displayOrder;
  this.clampScroll();
}

private computeExpandedSessionId(): string | null {
  // Hover wins, but only when it resolves to a session row.
  const hoveredId = this.hoveredRow !== null
    ? this.sessions[this.rowToSessionIndex.get(this.hoveredRow) ?? -1]?.id ?? null
    : null;
  return hoveredId ?? this.activeSessionId;
}
```

Replace every existing call to `buildRenderPlan(...)` inside `Sidebar` (in `updateSessions`, `toggleGroup`, `setPinnedSessions`) with `this.rebuildPlan()`.

Update `setActiveSession`:

```ts
setActiveSession(id: string): void {
  if (this.activeSessionId === id) return;
  this.activeSessionId = id;
  this.rebuildPlan();
}
```

Update `setHoveredRow`:

```ts
setHoveredRow(row: number | null): void {
  if (this.hoveredRow === row) return;
  const prev = this.computeExpandedSessionId();
  this.hoveredRow = row;
  const next = this.computeExpandedSessionId();
  if (prev !== next) this.rebuildPlan();
}
```

The `rowToSessionIndex` map is populated during `getGrid` rendering, so `computeExpandedSessionId` reads stale state for the *very first* render. That's fine — first render uses `activeSessionId` only, and any hover comes from a mouse event that fires after the first render.

Render row 3: in `renderSession`, after `detailRow` rendering, if `item.expanded && detailRow + 1 < this.height`, fill the third row with the active/hover background and active marker bar (no content yet — that's Task 16). Add this at the end of `renderSession`:

```ts
if (item.expanded) {
  const row3 = nameRow + 2;
  if (row3 < this.height) {
    if (isActive || isHovered) {
      const bg = isActive ? ACTIVE_BG : HOVER_BG;
      writeString(grid, row3, 0, " ".repeat(this.width), { bg, bgMode: ColorMode.RGB });
    }
    if (isActive) {
      writeString(grid, row3, 0, "▎", ACTIVE_MARKER_ATTRS);
    }
    this.rowToSessionIndex.set(row3, sessionIdx);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: PASS — both new and existing tests green.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): expand active or hovered session to 3 rows"
```

---

## Task 11: Col-1 indicator — error glyph (red `⨯`)

**Files:**
- Modify: `src/sidebar.ts` (extend col-1 priority logic in `renderSession`)
- Modify: `src/session-view.ts` (extend `SessionView` to surface the alert kind)
- Modify: `src/__tests__/sidebar.test.ts`

The view layer decides which glyph to draw; the renderer just consults the view.

- [ ] **Step 1: Write the failing test**

```ts
test("renders red error glyph when lastError is set, overriding attention/activity", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([{ name: "main", attention: true }]));
  sidebar.setActivity("$0", true);
  sidebar.setSessionOtelState("$0", {
    ...makeBlankOtelState(),
    lastError: { type: "api_error", timestamp: Date.now() },
  });
  const grid = sidebar.getGrid();

  expect(grid.cells[2][1].char).toBe("⨯"); // ⨯
  expect(grid.cells[2][1].fg).toBe(1); // palette red
  expect(grid.cells[2][1].bold).toBe(true);
});
```

Add a `makeBlankOtelState` test helper near the top of `sidebar.test.ts`:

```ts
import { makeSessionOtelState } from "../types";
const makeBlankOtelState = makeSessionOtelState;
```

The test uses `setSessionOtelState`, which doesn't exist yet — that's intentional. We rename `setCacheTimer` in this task.

- [ ] **Step 2: Run the failing test**

Run: `bun test src/__tests__/sidebar.test.ts -t "error glyph"`
Expected: FAIL.

- [ ] **Step 3: Rename setCacheTimer to setSessionOtelState; extend the view; render the glyph**

In `src/sidebar.ts`, replace the `setCacheTimer` method (added in Task 1) with `setSessionOtelState` that accepts the full state:

```ts
setSessionOtelState(sessionId: string, state: SessionOtelState | null): void {
  if (state === null) {
    this.otelStates.delete(sessionId);
  } else {
    this.otelStates.set(sessionId, state);
  }
}
```

Update every existing `setCacheTimer(...)` call site so the second argument is a full `SessionOtelState`. Run:

```bash
grep -rn "setCacheTimer" src
```

For each call (in `src/__tests__/sidebar.test.ts` lines 467, 482, 510, 530, 550, 570, 595, 719), rewrite as:

```ts
sidebar.setSessionOtelState("$0", {
  ...makeSessionOtelState(),
  lastRequestTime: Date.now() - 60_000,
  cacheWasHit: true,
});
```

The test file should already import `makeSessionOtelState` (added with `makeBlankOtelState` in Step 1).

In `src/session-view.ts`, extend `SessionView`:

```ts
export type AlertKind = "error" | "mcp-down" | "attention" | "activity" | null;

export interface SessionView {
  // ... existing fields ...
  alertKind: AlertKind;
}
```

In `buildSessionView`, derive `alertKind`:

```ts
let alertKind: AlertKind = null;
if (timerState?.lastError) alertKind = "error";
else if (session.attention) alertKind = "attention";
else if (activitySet.has(session.id)) alertKind = "activity";

// ... return:
return { /* ... */, alertKind };
```

Update the existing `hasActivity` and `hasAttention` callers in `renderSession` — they still work, but the col-1 indicator selection now uses `alertKind`:

```ts
const ERROR_ATTRS: CellAttrs = { fg: 1, fgMode: ColorMode.Palette, bold: true };

// In renderSession, replace the existing "if (view.hasAttention) { ... } else if (view.hasActivity) { ... }" block:
switch (view.alertKind) {
  case "error":
    writeString(grid, nameRow, 1, "⨯", ERROR_ATTRS);
    break;
  case "attention":
    writeString(grid, nameRow, 1, "!", ATTENTION_ATTRS);
    break;
  case "activity":
    writeString(grid, nameRow, 1, "●", ACTIVITY_ATTRS);
    break;
}
```

(`mcp-down` arrives in Task 12.)

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts src/session-view.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): show red error glyph when api_error or retries_exhausted"
```

---

## Task 12: Col-1 indicator — MCP-down glyph (`⊘`)

**Files:**
- Modify: `src/session-view.ts` (extend alert priority)
- Modify: `src/sidebar.ts` (handle `mcp-down` in the switch)
- Modify: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("renders MCP-down glyph when failedMcpServers is non-empty", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([{ name: "main", attention: true }]));
  sidebar.setSessionOtelState("$0", {
    ...makeBlankOtelState(),
    failedMcpServers: new Set(["linear"]),
  });
  const grid = sidebar.getGrid();

  expect(grid.cells[2][1].char).toBe("⊘"); // ⊘
  expect(grid.cells[2][1].fg).toBe(1);
  expect(grid.cells[2][1].dim).toBe(true);
});

test("error glyph wins over MCP-down", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([{ name: "main" }]));
  sidebar.setSessionOtelState("$0", {
    ...makeBlankOtelState(),
    lastError: { type: "api_error", timestamp: Date.now() },
    failedMcpServers: new Set(["linear"]),
  });
  const grid = sidebar.getGrid();

  expect(grid.cells[2][1].char).toBe("⨯"); // ⨯
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/sidebar.test.ts -t "MCP-down|wins over MCP"`
Expected: FAIL.

- [ ] **Step 3: Extend the alert derivation and rendering**

In `src/session-view.ts`:

```ts
let alertKind: AlertKind = null;
if (timerState?.lastError) alertKind = "error";
else if ((timerState?.failedMcpServers.size ?? 0) > 0) alertKind = "mcp-down";
else if (session.attention) alertKind = "attention";
else if (activitySet.has(session.id)) alertKind = "activity";
```

In `src/sidebar.ts`, add the constant + case:

```ts
const MCP_DOWN_ATTRS: CellAttrs = { fg: 1, fgMode: ColorMode.Palette, dim: true };

// In renderSession switch:
case "mcp-down":
  writeString(grid, nameRow, 1, "⊘", MCP_DOWN_ATTRS);
  break;
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts src/session-view.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): show dim red MCP-down glyph when an MCP server has failed"
```

---

## Task 13: Mode badge on row 1 (`P` plan, `A` accept-edits)

**Files:**
- Modify: `src/session-view.ts` (extend with `modeBadge` field)
- Modify: `src/sidebar.ts` (render the badge; adjust name truncation and Linear ID position)
- Modify: `src/__tests__/sidebar.test.ts`

The badge sits 2 columns to the left of the existing `linearIdCol` (or at `width - 2` when no Linear ID is present).

- [ ] **Step 1: Write the failing tests**

```ts
test("renders P badge in cyan when permissionMode is plan", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([{ name: "main" }]));
  sidebar.setSessionOtelState("$0", {
    ...makeBlankOtelState(),
    permissionMode: "plan",
  });
  const grid = sidebar.getGrid();

  // No Linear ID, badge anchors at width - 2
  const badgeCell = grid.cells[2][SIDEBAR_WIDTH - 2];
  expect(badgeCell.char).toBe("P");
  expect(badgeCell.fg).toBe(6); // palette cyan
});

test("renders A badge in yellow when permissionMode is accept-edits", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([{ name: "main" }]));
  sidebar.setSessionOtelState("$0", {
    ...makeBlankOtelState(),
    permissionMode: "accept-edits",
  });
  const grid = sidebar.getGrid();

  const badgeCell = grid.cells[2][SIDEBAR_WIDTH - 2];
  expect(badgeCell.char).toBe("A");
  expect(badgeCell.fg).toBe(3);
});

test("default mode renders no badge", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([{ name: "main" }]));
  sidebar.setSessionOtelState("$0", makeBlankOtelState());
  const grid = sidebar.getGrid();

  expect(grid.cells[2][SIDEBAR_WIDTH - 2].char).toBe(" ");
});

test("session name truncates 2 columns earlier when a mode badge is present", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  // 26-col sidebar, col 3 starts the name. With no badge, name has 22 cols.
  // With badge, name has 20 cols.
  const longName = "a".repeat(40);
  sidebar.updateSessions(makeSessions([{ name: longName }]));
  sidebar.setSessionOtelState("$0", {
    ...makeBlankOtelState(),
    permissionMode: "plan",
  });
  const grid = sidebar.getGrid();

  const row = grid.cells[2];
  // Find last 'a' col
  let lastA = -1;
  for (let c = 0; c < SIDEBAR_WIDTH; c++) if (row[c].char === "a") lastA = c;
  // Last char before the badge gap should be the ellipsis
  const ellipsisCol = lastA + 1;
  expect(row[ellipsisCol].char).toBe("…");
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/sidebar.test.ts -t "badge"`
Expected: FAIL.

- [ ] **Step 3: Add `modeBadge` to the view and render it**

In `src/session-view.ts`:

```ts
export type ModeBadge = "P" | "A" | null;

export interface SessionView {
  // ... existing fields ...
  modeBadge: ModeBadge;
}

// In buildSessionView:
const modeBadge: ModeBadge =
  timerState?.permissionMode === "plan" ? "P" :
  timerState?.permissionMode === "accept-edits" ? "A" : null;
```

In `src/sidebar.ts`, add:

```ts
const MODE_PLAN_ATTRS: CellAttrs = { fg: 6, fgMode: ColorMode.Palette };
const MODE_ACCEPT_EDITS_ATTRS: CellAttrs = { fg: 3, fgMode: ColorMode.Palette };
```

In `renderSession`, *before* the linear ID rendering block, compute the badge column:

```ts
const linearIdStr = view.linearId ?? "";
const linearIdCol = linearIdStr ? this.width - linearIdStr.length - 1 : this.width;

const badgeCol = view.modeBadge !== null
  ? (linearIdStr ? linearIdCol - 2 : this.width - 2)
  : -1;

// nameMaxLen shrinks by 2 if a badge is present
const reserveRight = (linearIdStr ? linearIdCol - 1 : this.width - 1)
  - (view.modeBadge !== null ? 2 : 0);
const nameMaxLen = reserveRight - nameStart;
```

After the existing name rendering, draw the badge:

```ts
if (view.modeBadge !== null && badgeCol >= 0) {
  const attrs = view.modeBadge === "P" ? MODE_PLAN_ATTRS : MODE_ACCEPT_EDITS_ATTRS;
  writeString(grid, nameRow, badgeCol, view.modeBadge, { ...attrs, ...bgAttrs });
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts src/session-view.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): show mode badge (P/A) on row 1"
```

---

## Task 14: Compaction marker (`⊕`) for 30 s after compaction

**Files:**
- Modify: `src/session-view.ts` (extend `modeBadge` to include compaction)
- Modify: `src/sidebar.ts` (render `⊕`)
- Modify: `src/__tests__/sidebar.test.ts`

`⊕` only appears when the mode is `default` (the P/A badge wins). The 30-second window is enforced in `buildSessionView` so the renderer stays time-agnostic.

- [ ] **Step 1: Write the failing tests**

```ts
test("renders compaction marker for 30s when no mode badge", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([{ name: "main" }]));
  sidebar.setSessionOtelState("$0", {
    ...makeBlankOtelState(),
    lastCompactionTime: Date.now() - 5_000,
  });
  const grid = sidebar.getGrid();

  expect(grid.cells[2][SIDEBAR_WIDTH - 2].char).toBe("⊕"); // ⊕
  expect(grid.cells[2][SIDEBAR_WIDTH - 2].dim).toBe(true);
});

test("compaction marker disappears after 30s", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([{ name: "main" }]));
  sidebar.setSessionOtelState("$0", {
    ...makeBlankOtelState(),
    lastCompactionTime: Date.now() - 31_000,
  });
  const grid = sidebar.getGrid();

  expect(grid.cells[2][SIDEBAR_WIDTH - 2].char).toBe(" ");
});

test("plan mode wins over compaction marker", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([{ name: "main" }]));
  sidebar.setSessionOtelState("$0", {
    ...makeBlankOtelState(),
    permissionMode: "plan",
    lastCompactionTime: Date.now() - 5_000,
  });
  const grid = sidebar.getGrid();

  expect(grid.cells[2][SIDEBAR_WIDTH - 2].char).toBe("P");
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/sidebar.test.ts -t "compaction"`
Expected: FAIL.

- [ ] **Step 3: Extend the view and renderer**

In `src/session-view.ts`:

```ts
export type ModeBadge = "P" | "A" | "compaction" | null;

const COMPACTION_FLASH_MS = 30_000;

// In buildSessionView, replace the existing modeBadge derivation:
let modeBadge: ModeBadge = null;
if (timerState?.permissionMode === "plan") modeBadge = "P";
else if (timerState?.permissionMode === "accept-edits") modeBadge = "A";
else if (
  timerState?.lastCompactionTime !== null &&
  timerState?.lastCompactionTime !== undefined &&
  Date.now() - timerState.lastCompactionTime < COMPACTION_FLASH_MS
) {
  modeBadge = "compaction";
}
```

In `src/sidebar.ts`:

```ts
const MODE_COMPACTION_ATTRS: CellAttrs = { dim: true };

// In renderSession badge block:
if (view.modeBadge !== null && badgeCol >= 0) {
  let glyph: string;
  let attrs: CellAttrs;
  if (view.modeBadge === "P") { glyph = "P"; attrs = MODE_PLAN_ATTRS; }
  else if (view.modeBadge === "A") { glyph = "A"; attrs = MODE_ACCEPT_EDITS_ATTRS; }
  else { glyph = "⊕"; attrs = MODE_COMPACTION_ATTRS; }
  writeString(grid, nameRow, badgeCol, glyph, { ...attrs, ...bgAttrs });
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts src/session-view.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): show transient compaction marker for 30s"
```

---

## Task 15: `buildSessionRow3` helper in `session-view.ts`

**Files:**
- Modify: `src/session-view.ts` (new helper)
- Modify: `src/__tests__/session-view.test.ts`

This task adds the formatting/dropping logic only. Task 16 wires it into the renderer.

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/session-view.test.ts`:

```ts
import { buildSessionRow3 } from "../session-view";
import { makeSessionOtelState } from "../types";

describe("buildSessionRow3", () => {
  const baseState = () => makeSessionOtelState();

  test("formats cost as $1.23", () => {
    const state = baseState();
    state.costUsd = 1.234;
    const out = buildSessionRow3(state, 26);
    expect(out).toContain("$1.23");
  });

  test("formats tool with seconds duration", () => {
    const state = baseState();
    state.lastTool = { name: "Edit", durationMs: 1234, success: true, timestamp: Date.now() };
    const out = buildSessionRow3(state, 26);
    expect(out).toContain("Edit 1.2s");
  });

  test("formats tool with minute+second duration", () => {
    const state = baseState();
    state.lastTool = { name: "Bash", durationMs: 80_000, success: true, timestamp: Date.now() };
    const out = buildSessionRow3(state, 26);
    expect(out).toContain("Bash 1m20s");
  });

  test("formats idle as 3m idle", () => {
    const state = baseState();
    state.lastUserPromptTime = Date.now() - 3 * 60 * 1000;
    const out = buildSessionRow3(state, 26);
    expect(out).toContain("3m idle");
  });

  test("omits cost when zero", () => {
    const state = baseState();
    state.lastTool = { name: "Edit", durationMs: 100, success: true, timestamp: Date.now() };
    const out = buildSessionRow3(state, 26);
    expect(out).not.toContain("$");
  });

  test("omits last tool when null", () => {
    const state = baseState();
    state.costUsd = 1.0;
    const out = buildSessionRow3(state, 26);
    expect(out).not.toContain("Edit");
    expect(out).not.toContain("Bash");
  });

  test("omits idle when no user_prompt seen", () => {
    const state = baseState();
    state.costUsd = 1.0;
    const out = buildSessionRow3(state, 26);
    expect(out).not.toContain("idle");
  });

  test("on overflow drops idle first", () => {
    // Width 16 — too tight for cost + tool + idle, plenty for cost + tool
    const state = baseState();
    state.costUsd = 1.0;
    state.lastTool = { name: "Edit", durationMs: 1000, success: true, timestamp: Date.now() };
    state.lastUserPromptTime = Date.now() - 60_000;
    const out = buildSessionRow3(state, 16);
    expect(out).toContain("$1.00");
    expect(out).toContain("Edit");
    expect(out).not.toContain("idle");
  });

  test("on tighter overflow drops tool next, keeps cost", () => {
    const state = baseState();
    state.costUsd = 1.0;
    state.lastTool = { name: "Edit", durationMs: 1000, success: true, timestamp: Date.now() };
    state.lastUserPromptTime = Date.now() - 60_000;
    const out = buildSessionRow3(state, 8);
    expect(out).toContain("$1.00");
    expect(out).not.toContain("Edit");
    expect(out).not.toContain("idle");
  });

  test("returns empty string when no fields apply", () => {
    expect(buildSessionRow3(baseState(), 26)).toBe("");
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/session-view.test.ts -t "buildSessionRow3"`
Expected: FAIL — no such export.

- [ ] **Step 3: Implement `buildSessionRow3`**

Add to `src/session-view.ts`:

```ts
function formatToolDuration(ms: number): string {
  if (ms < 60_000) {
    const s = (ms / 1000).toFixed(1);
    return `${s}s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m${s}s`;
}

function formatIdle(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s idle`;
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return `${m}m idle`;
  const h = Math.floor(m / 60);
  return `${h}h idle`;
}

const ROW3_GAP = "  ";

export function buildSessionRow3(state: SessionOtelState, width: number): string {
  const costText = state.costUsd > 0 ? `$${state.costUsd.toFixed(2)}` : null;
  const toolText = state.lastTool
    ? `${state.lastTool.name} ${formatToolDuration(state.lastTool.durationMs)}`
    : null;
  const idleText = state.lastUserPromptTime !== null
    ? formatIdle(Date.now() - state.lastUserPromptTime)
    : null;

  // Reserve col 0-2 (active marker + 2-col gutter, matching row 2's branch start at col 3)
  const usable = Math.max(0, width - 3);

  // Drop priority: try (cost+tool+idle), then (cost+tool), then (cost), then "".
  const candidates: Array<Array<{ text: string; align: "left" | "right" } >> = [];
  if (costText && toolText && idleText) {
    candidates.push([
      { text: costText, align: "left" },
      { text: toolText, align: "left" },
      { text: idleText, align: "right" },
    ]);
  }
  if (costText && toolText) {
    candidates.push([
      { text: costText, align: "left" },
      { text: toolText, align: "left" },
    ]);
  }
  if (costText && idleText) {
    candidates.push([
      { text: costText, align: "left" },
      { text: idleText, align: "right" },
    ]);
  }
  if (toolText && idleText) {
    candidates.push([
      { text: toolText, align: "left" },
      { text: idleText, align: "right" },
    ]);
  }
  if (costText) candidates.push([{ text: costText, align: "left" }]);
  if (toolText) candidates.push([{ text: toolText, align: "left" }]);

  for (const fields of candidates) {
    const totalLen = fields.reduce((s, f) => s + f.text.length, 0)
      + Math.max(0, fields.length - 1) * ROW3_GAP.length;
    if (totalLen <= usable) {
      return layoutRow3(fields, usable);
    }
  }

  // Last resort: cost truncated
  if (costText) return costText.slice(0, usable);
  return "";
}

function layoutRow3(
  fields: Array<{ text: string; align: "left" | "right" }>,
  usable: number,
): string {
  if (fields.length === 0) return "";
  const lefts = fields.filter((f) => f.align === "left").map((f) => f.text);
  const rights = fields.filter((f) => f.align === "right").map((f) => f.text);
  const leftPart = lefts.join(ROW3_GAP);
  const rightPart = rights.join(ROW3_GAP);
  if (rightPart === "") return leftPart;
  if (leftPart === "") return " ".repeat(Math.max(0, usable - rightPart.length)) + rightPart;
  const padLen = Math.max(2, usable - leftPart.length - rightPart.length);
  return leftPart + " ".repeat(padLen) + rightPart;
}
```

The candidate list enforces the drop priority: idle drops before tool, tool drops before cost.

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/session-view.test.ts`
Expected: PASS — `buildSessionRow3` tests green and existing `buildSessionView` tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/session-view.ts src/__tests__/session-view.test.ts
git commit -m "feat(session-view): add buildSessionRow3 with cost/tool/idle and drop priority"
```

---

## Task 16: Render row 3 content for the expanded session

**Files:**
- Modify: `src/sidebar.ts` (call `buildSessionRow3`; write into the third row)
- Modify: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("expanded session shows cost / tool / idle on row 3", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([{ name: "main" }]));
  sidebar.setActiveSession("$0");
  sidebar.setSessionOtelState("$0", {
    ...makeBlankOtelState(),
    costUsd: 1.23,
    lastTool: { name: "Edit", durationMs: 1234, success: true, timestamp: Date.now() },
    lastUserPromptTime: Date.now() - 3 * 60 * 1000,
  });
  const grid = sidebar.getGrid();

  // Active session — name row 2, detail row 3, row 3 is row 4
  const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[4][i].char).join("");
  expect(text).toContain("$1.23");
  expect(text).toContain("Edit");
  expect(text).toContain("3m idle");
});

test("non-expanded session has no row 3 content", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(makeSessions([
    { name: "alpha" },
    { name: "beta" },
  ]));
  sidebar.setActiveSession("$0");
  sidebar.setSessionOtelState("$1", {
    ...makeBlankOtelState(),
    costUsd: 99.99,
  });
  const grid = sidebar.getGrid();

  // Layout: alpha (expanded) at rows 2,3,4; spacer at 5; beta (h=2) at 6,7;
  // spacer at 8. If beta were wrongly expanded, $99.99 would appear at row 8.
  const row8Text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[8][i].char).join("");
  expect(row8Text).not.toContain("$99.99");
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test src/__tests__/sidebar.test.ts -t "row 3"`
Expected: FAIL.

- [ ] **Step 3: Render row 3 content**

In `src/sidebar.ts`, import `buildSessionRow3` from `./session-view` (alongside the existing `buildSessionView` import).

Inside `renderSession`, replace the placeholder row-3 block from Task 10 with:

```ts
if (item.expanded) {
  const row3 = nameRow + 2;
  if (row3 < this.height) {
    if (isActive || isHovered) {
      const bg = isActive ? ACTIVE_BG : HOVER_BG;
      writeString(grid, row3, 0, " ".repeat(this.width), { bg, bgMode: ColorMode.RGB });
    }
    if (isActive) {
      writeString(grid, row3, 0, "▎", ACTIVE_MARKER_ATTRS);
    }
    this.rowToSessionIndex.set(row3, sessionIdx);

    const otel = this.otelStates.get(session.id);
    if (otel) {
      const text = buildSessionRow3(otel, this.width);
      if (text.length > 0) {
        const row3Attrs: CellAttrs = isActive
          ? ACTIVE_DETAIL_ATTRS
          : isHovered
            ? HOVER_DETAIL_ATTRS
            : DIM_ATTRS;
        writeString(grid, row3, 3, text, row3Attrs);
      }
    }
  }
}
```

The row 3 text starts at col 3, matching the row 2 branch start, and uses the same dim-with-bg attribute set as the existing detail row.

- [ ] **Step 4: Run the tests**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): render cost/tool/idle on row 3 of the focused session"
```

---

## Task 17: Wire `main.ts` to push the full state

**Files:**
- Modify: `src/main.ts:500-508`

- [ ] **Step 1: Replace the wire-up**

```ts
otelReceiver.onUpdate = (sessionName) => {
  const session = currentSessions.find((s) => s.name === sessionName);
  if (!session) return;
  const state = otelReceiver.getSessionState(sessionName);
  sidebar.setSessionOtelState(session.id, state);
  startCacheTimerTick();
  scheduleRender();
};
```

The `startCacheTimerTick` call is preserved — it drives the per-second tick that advances the cache timer countdown. Since row 3's idle text is also time-sensitive, the same tick covers it.

- [ ] **Step 2: Typecheck and run all tests**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 3: Manual smoke test**

Run: `bun run dev`

Inside a tmux session running Claude Code with OTEL exporter pointed at jmux's receiver port:

- Trigger an `api_error` (e.g., turn off network briefly during a request) → confirm `⨯` appears on the session in the sidebar.
- Toggle plan mode in Claude Code → confirm `P` badge appears.
- Toggle accept-edits mode → confirm `A` badge.
- Hover a non-active session in the sidebar → confirm it expands to 3 rows showing cost/tool/idle.
- Move hover off → confirm it collapses back.
- Wait until 30 s after a `compaction` event → confirm `⊕` disappears.

If a signal does not arrive, check that `OTEL_LOG_USER_PROMPTS=1` and the relevant exporter envs are set in your Claude Code launch.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): push full SessionOtelState to sidebar on OTEL updates"
```

---

## Self-review

After Task 17 is complete:

- [ ] **Bun build sanity**: `bun run typecheck && bun test && bun run docker`
- [ ] **Spec coverage**: every spec section is implemented:
  - `SessionOtelState` shape — Task 1
  - Each new event handler — Tasks 2–8
  - Variable item heights, expansion rule — Task 10
  - Col-1 indicator priority (error, MCP, attention, activity) — Tasks 11–12
  - Mode badge + compaction marker — Tasks 13–14
  - Row 3 layout/drop priority — Task 15
  - Row 3 rendering — Task 16
  - main.ts wire-up — Task 17
- [ ] **Visual sanity**: capture a screenshot of the sidebar with at least one session showing each new signal and append it to the design doc.
