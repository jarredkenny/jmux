# Sidebar Context Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-session cost (`$48.35`) and last-tool (`Bash 0.1s`) figures in the sidebar's third row with the session's current context-window occupancy in tokens (e.g. `112k`), and remove cost/last-tool tracking from OTEL state and the snapshot.

**Architecture:** OTEL `api_request` events carry input-side token counts and a `query_source` attribute. We track each session's context occupancy as the total input-side tokens (`input + cache_read + cache_creation`) of the latest **main-loop** request (`query_source === "repl_main_thread"`), with a high-water fallback when `query_source` is absent and a reset on `compaction`. Row 3 of the sidebar renders this number (dim, no denominator) on the left and the agent state label on the right. Cost (`costUsd`) and last-tool (`lastTool`) are deleted from the runtime state, the view, and the snapshot schema.

**Tech Stack:** Bun 1.3.8+, TypeScript (strict), `bun test`, `bun run typecheck`. Pure unit tests over logic modules — no tmux is spawned.

**Important runtime note:** Bun executes TypeScript by stripping types, so `bun test` does **not** fail on type errors. Until every consumer of the removed fields is updated, `bun run typecheck` (tsc) will report errors in not-yet-touched files — that is expected. Per-task verification uses focused `bun test`; **full `bun run typecheck` is only guaranteed green at Task 5.**

**Spec:** `docs/superpowers/specs/2026-06-02-sidebar-context-tokens-design.md`

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/types.ts` | `SessionOtelState` shape + factory | Remove `costUsd`, `lastTool`, `LastTool`; add `contextTokens` |
| `src/snapshot/schema.ts` | Snapshot persistence contract + validator | `SnapshotOtel` drop `costUsd`/`lastTool`, add optional `contextTokens`; update `validateOtel` |
| `src/otel-receiver.ts` | Ingest OTLP logs → `SessionOtelState` | `api_request` tracks `contextTokens`; `compaction` resets it; `tool_result` fires resume hint only; snapshot get/set updated |
| `src/session-view.ts` | Build per-row view data + row-3 layout | `buildSessionRow3` renders context figure; drop cost/tool/idle helpers; drop `lastTool` timer candidate |
| `src/sidebar.ts` | Composite sidebar grid | Update stale row-3 comment only |
| `src/__tests__/otel-receiver.test.ts` | Receiver behavior | Context-tracking tests; resume-only `tool_result` |
| `src/__tests__/session-view.test.ts` | Row-3 layout | Context figure + state label |
| `src/__tests__/sidebar.test.ts` | Render plan | Row-3 content assertions |
| `src/__tests__/snapshot/schema.test.ts` | Validator | `contextTokens` fixtures |
| `src/__tests__/snapshot/restore-links-upsert.test.ts` | Restore plumbing | Fixture otel object |

---

## Task 1: Type & snapshot contracts

Establish the new data shape first: `contextTokens` in, `costUsd`/`lastTool` out. The snapshot validator and its tests are the verification surface.

**Files:**
- Modify: `src/types.ts:62-97`
- Modify: `src/snapshot/schema.ts:12-22` (interface) and `src/snapshot/schema.ts:138-169` (`validateOtel`)
- Test: `src/__tests__/snapshot/schema.test.ts:315-386`

- [ ] **Step 1: Update the snapshot validator tests**

In `src/__tests__/snapshot/schema.test.ts`, every otel literal currently includes `costUsd` and `lastTool`. Make these edits:

Replace the test at line 315 (`rejects otel with non-number costUsd`) with:

```ts
  test("validateSnapshot rejects otel with non-number contextTokens", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].otel = { contextTokens: "lots", cacheWasHit: null, lastRequestTime: null, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: [] };
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("contextTokens");
  });

  test("validateSnapshot accepts otel without contextTokens (back-compat)", () => {
    const variant = JSON.parse(JSON.stringify(good));
    variant.sessions[0].otel = { cacheWasHit: true, lastRequestTime: null, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: [] };
    const result = validateSnapshot(variant);
    expect(result.ok).toBe(true);
  });
```

In the remaining otel literals, delete the `costUsd: ...,` and `lastTool: ...,` keys:
- line 325 (`invalid cacheWasHit`): `bad.sessions[0].otel = { cacheWasHit: "yes", lastRequestTime: null, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: [] };`
- line 333 (`invalid nullable string field`): `bad.sessions[0].otel = { cacheWasHit: null, lastRequestTime: 42, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: [] };`
- line 341 (`non-array failedMcpServers`): `bad.sessions[0].otel = { cacheWasHit: null, lastRequestTime: null, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: "none" };`
- line 349 (`non-string failedMcpServers entry`): `bad.sessions[0].otel = { cacheWasHit: null, lastRequestTime: null, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: [42] };`
- lines 355-369 (`accepts full valid otel object`): replace the otel literal with:

```ts
    variant.sessions[0].otel = {
      contextTokens: 112000,
      cacheWasHit: true,
      lastRequestTime: "2026-05-12T18:00:00.000Z",
      lastCompactionTime: null,
      lastUserPromptTime: "2026-05-12T17:00:00.000Z",
      lastError: null,
      failedMcpServers: ["linear", "slack"],
    };
```

- lines 371-386 (`rejects otel with unknown lastError type string`): drop `costUsd` and `lastTool`:

```ts
    bad.sessions[0].otel = {
      cacheWasHit: null,
      lastRequestTime: null,
      lastCompactionTime: null,
      lastUserPromptTime: null,
      lastError: "some_unknown_error",
      failedMcpServers: [],
    };
```

- [ ] **Step 2: Run the schema tests to verify they fail**

Run: `bun test src/__tests__/snapshot/schema.test.ts`
Expected: FAIL — the new `contextTokens` rejection test fails (validator still has no `contextTokens` rule) and the back-compat test may pass coincidentally; the `non-number costUsd` test name is gone.

- [ ] **Step 3: Update `SessionOtelState` in `src/types.ts`**

Delete the `LastTool` interface (lines 63-68). In `SessionOtelState` (lines 70-83) remove `costUsd: number;` and `lastTool: LastTool | null;`, and add `contextTokens: number;`. The result:

```ts
export interface SessionOtelState {
  // Cache-timer fields (existing)
  lastRequestTime: number;
  cacheWasHit: boolean;

  // Current main-loop context occupancy in tokens (input + cache_read +
  // cache_creation of the latest main-thread api_request). Reset on compaction.
  contextTokens: number;
  lastError: ErrorState | null;
  failedMcpServers: Set<string>;
  permissionMode: PermissionMode;
  lastCompactionTime: number | null;
  lastUserPromptTime: number | null;
}
```

In `makeSessionOtelState()` (lines 85-97) remove `costUsd: 0,` and `lastTool: null,`, add `contextTokens: 0,`:

```ts
export function makeSessionOtelState(): SessionOtelState {
  return {
    lastRequestTime: 0,
    cacheWasHit: false,
    contextTokens: 0,
    lastError: null,
    failedMcpServers: new Set(),
    permissionMode: "default",
    lastCompactionTime: null,
    lastUserPromptTime: null,
  };
}
```

- [ ] **Step 4: Update `SnapshotOtel` and `validateOtel` in `src/snapshot/schema.ts`**

Replace the `SnapshotOtel` interface (lines 12-22):

```ts
export interface SnapshotOtel {
  // Optional & defaulted for back-compat with snapshots written before context
  // tracking existed. Absent ⇒ treated as 0 on restore.
  contextTokens?: number;
  cacheWasHit: boolean | null;
  lastRequestTime: string | null;
  lastCompactionTime: string | null;
  lastUserPromptTime: string | null;
  // null or one of the known ErrorState types from src/types.ts
  lastError: "api_error" | "api_retries_exhausted" | null;
  failedMcpServers: string[];
}
```

In `validateOtel` (lines 138-169): remove the `costUsd` check (line 141), remove `"lastTool"` from the `nullableStrings` array (line 148), and add a `contextTokens` check. The body becomes:

```ts
function validateOtel(v: unknown, path: string): string | null {
  if (v === null) return null;
  if (!isRecord(v)) return `${path}: not an object or null`;
  if (v.contextTokens !== undefined && !isFiniteNumber(v.contextTokens)) {
    return `${path}.contextTokens: not a number`;
  }
  if (v.cacheWasHit !== null && !isBoolean(v.cacheWasHit)) {
    return `${path}.cacheWasHit: not boolean or null`;
  }
  const nullableStrings = [
    "lastRequestTime",
    "lastCompactionTime",
    "lastUserPromptTime",
  ] as const;
  for (const k of nullableStrings) {
    if (v[k] !== null && !isString(v[k])) {
      return `${path}.${k}: not string or null`;
    }
  }
  // lastError must be null or one of the known error type strings (see src/types.ts ErrorState).
  if (v.lastError !== null && !isKnownLastErrorType(v.lastError)) {
    return `${path}.lastError: not null or a known error type`;
  }
  if (!Array.isArray(v.failedMcpServers)) {
    return `${path}.failedMcpServers: not an array`;
  }
  for (let i = 0; i < v.failedMcpServers.length; i++) {
    if (!isString(v.failedMcpServers[i])) {
      return `${path}.failedMcpServers[${i}]: not a string`;
    }
  }
  return null;
}
```

- [ ] **Step 5: Run the schema tests to verify they pass**

Run: `bun test src/__tests__/snapshot/schema.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/snapshot/schema.ts src/__tests__/snapshot/schema.test.ts
git commit -m "refactor(otel): replace costUsd/lastTool with contextTokens in state + snapshot contracts"
```

---

## Task 2: OTEL receiver behavior

Make the receiver compute `contextTokens` from `api_request`, reset on `compaction`, and reduce `tool_result` to a resume-hint trigger that no longer mutates state.

**Files:**
- Modify: `src/otel-receiver.ts:41-54` (`getSessionSnapshot`), `:61-83` (`setSessionSnapshot`), `:169-184` (`api_request`), `:207-214` (`compaction`), `:249-267` (`tool_result`)
- Test: `src/__tests__/otel-receiver.test.ts`

- [ ] **Step 1: Update the test helper and replace cost/lastTool tests**

In `src/__tests__/otel-receiver.test.ts`, extend `makeOtlpPayload` (lines 8-57) to support input tokens and `query_source`. Change the options type and destructuring to add `inputTokens?: number;` and `querySource?: string;`, and push the attributes:

```ts
function makeOtlpPayload(opts: {
  sessionName?: string;
  eventName?: string;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  inputTokens?: number;
  querySource?: string;
  costUsd?: number;
  attributes?: Array<{ key: string; value: any }>;
}): object {
  const {
    sessionName = "main",
    eventName = "api_request",
    cacheReadTokens = 100,
    cacheCreationTokens = 0,
    inputTokens,
    querySource,
    costUsd,
    attributes,
  } = opts;

  const baseAttrs: any[] = [
    { key: "event.name", value: { stringValue: eventName } },
    { key: "cache_read_tokens", value: { stringValue: String(cacheReadTokens) } },
    { key: "cache_creation_tokens", value: { stringValue: String(cacheCreationTokens) } },
  ];
  if (inputTokens !== undefined) {
    baseAttrs.push({ key: "input_tokens", value: { stringValue: String(inputTokens) } });
  }
  if (querySource !== undefined) {
    baseAttrs.push({ key: "query_source", value: { stringValue: querySource } });
  }
  if (costUsd !== undefined) {
    baseAttrs.push({ key: "cost_usd", value: { doubleValue: costUsd } });
  }
  if (attributes) baseAttrs.push(...attributes);
```

(The `costUsd` option is retained only so existing untouched call sites still type-check at runtime; it is now an inert attribute.)

Delete these now-obsolete tests entirely:
- `accumulates cost across api_request events` (lines 251-268)
- `api_request without cost_usd leaves cost unchanged` (lines 270-285)
- `tool_result sets lastTool` (lines 331-354)
- `getSessionSnapshot lastTool is the tool name string or null` (lines 662-684)

Replace `tool_result without tool_name is ignored` (lines 380-397) with the resume-only regression:

```ts
  test("tool_result fires resume hint and does not create OTEL state", async () => {
    const seen: string[] = [];
    const recv = new OtelReceiver({ onAgentResumeHint: (name) => seen.push(name) });
    const port = await recv.start();
    try {
      // Without tool_name
      await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        body: JSON.stringify(makeOtlpPayload({ sessionName: "$tn", eventName: "tool_result" })),
      });
      // With tool_name
      await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        body: JSON.stringify(makeOtlpPayload({
          sessionName: "$tn",
          eventName: "tool_result",
          attributes: [{ key: "tool_name", value: { stringValue: "Edit" } }],
        })),
      });
      // Resume hint fired both times; no OTEL state was created.
      expect(seen).toEqual(["$tn", "$tn"]);
      expect(recv.getSessionState("$tn")).toBeNull();
    } finally {
      recv.stop();
    }
  });

  test("tool_result leaves an existing session's state untouched", async () => {
    const port = await receiver.start();
    // Seed real state via a main-thread api_request.
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$te", inputTokens: 1000, cacheReadTokens: 4000, cacheCreationTokens: 0, querySource: "repl_main_thread" })),
    });
    const before = receiver.getSessionState("$te")!;
    const beforeContext = before.contextTokens;
    const beforeRequest = before.lastRequestTime;
    // tool_result must not change any field.
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({
        sessionName: "$te",
        eventName: "tool_result",
        attributes: [{ key: "tool_name", value: { stringValue: "Bash" } }],
      })),
    });
    const after = receiver.getSessionState("$te")!;
    expect(after.contextTokens).toBe(beforeContext);
    expect(after.lastRequestTime).toBe(beforeRequest);
  });
```

Update `getSessionSnapshot returns a SnapshotOtel-shaped object` (lines 613-628) — replace the `costUsd` assertions with `contextTokens`:

```ts
  test("getSessionSnapshot returns a SnapshotOtel-shaped object", async () => {
    const port = await receiver.start();

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "snap1", inputTokens: 2000, cacheReadTokens: 8000, querySource: "repl_main_thread" })),
    });

    const snap = receiver.getSessionSnapshot("snap1");
    expect(snap).not.toBeNull();
    expect(typeof snap!.contextTokens).toBe("number");
    expect(snap!.contextTokens).toBe(10000);
    expect(typeof snap!.cacheWasHit).toBe("boolean");
    expect(Array.isArray(snap!.failedMcpServers)).toBe(true);
  });
```

In the `fires on tool_result with the session name` test (lines 755-780), the payload still works as-is (extra `duration_ms`/`success` attributes are harmless), so leave it — it confirms the resume hint still fires.

- [ ] **Step 2: Add the context-tracking tests**

Insert these tests inside the top-level `describe("OtelReceiver", ...)` block (e.g. right after the `successful api_request clears lastError` test at line 329):

```ts
  test("main-thread api_request sets contextTokens to the input-side total", async () => {
    const port = await receiver.start();
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$ctx", inputTokens: 5000, cacheReadTokens: 100000, cacheCreationTokens: 2000, querySource: "repl_main_thread" })),
    });
    expect(receiver.getSessionState("$ctx")!.contextTokens).toBe(107000);
  });

  test("a smaller later main-thread request lowers contextTokens (latest wins)", async () => {
    const port = await receiver.start();
    const post = (input: number, read: number) =>
      fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        body: JSON.stringify(makeOtlpPayload({ sessionName: "$lw", inputTokens: input, cacheReadTokens: read, cacheCreationTokens: 0, querySource: "repl_main_thread" })),
      });
    await post(1000, 150000); // 151k
    await post(500, 40000);   // 40.5k — after a compaction the context shrinks
    expect(receiver.getSessionState("$lw")!.contextTokens).toBe(40500);
  });

  test("subagent request does not change contextTokens", async () => {
    const port = await receiver.start();
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$sa", inputTokens: 1000, cacheReadTokens: 100000, querySource: "repl_main_thread" })),
    });
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$sa", inputTokens: 500, cacheReadTokens: 8000, querySource: "code-reviewer" })),
    });
    expect(receiver.getSessionState("$sa")!.contextTokens).toBe(101000);
  });

  test("compact request does not change contextTokens", async () => {
    const port = await receiver.start();
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$cq", inputTokens: 1000, cacheReadTokens: 100000, querySource: "repl_main_thread" })),
    });
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$cq", inputTokens: 9000, cacheReadTokens: 1000, querySource: "compact" })),
    });
    expect(receiver.getSessionState("$cq")!.contextTokens).toBe(101000);
  });

  test("absent query_source uses high-water max (legacy fallback)", async () => {
    const port = await receiver.start();
    const post = (input: number, read: number) =>
      fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        body: JSON.stringify(makeOtlpPayload({ sessionName: "$hw", inputTokens: input, cacheReadTokens: read, cacheCreationTokens: 0 })),
      });
    await post(1000, 150000); // 151k
    await post(500, 8000);    // 8.5k subagent-ish — must NOT lower the figure
    expect(receiver.getSessionState("$hw")!.contextTokens).toBe(151000);
  });

  test("compaction resets contextTokens to 0", async () => {
    const port = await receiver.start();
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$rc", inputTokens: 1000, cacheReadTokens: 150000, querySource: "repl_main_thread" })),
    });
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$rc", eventName: "compaction" })),
    });
    expect(receiver.getSessionState("$rc")!.contextTokens).toBe(0);
  });

  test("subagent/compact requests still update request bookkeeping", async () => {
    const port = await receiver.start();
    // Seed an error so we can confirm a non-main request clears it.
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$bk", eventName: "api_error" })),
    });
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$bk", inputTokens: 100, cacheReadTokens: 4000, querySource: "compact" })),
    });
    const state = receiver.getSessionState("$bk")!;
    expect(state.contextTokens).toBe(0);          // occupancy untouched by compact
    expect(state.lastRequestTime).toBeGreaterThan(0); // bookkeeping advanced
    expect(state.lastError).toBeNull();            // error cleared
  });
```

- [ ] **Step 3: Run the receiver tests to verify they fail**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: FAIL — the new context tests fail (`contextTokens` is always 0, receiver doesn't read `query_source`/`input_tokens`); `getSessionState("$tn")` is non-null because `tool_result` still creates state.

- [ ] **Step 4: Update the `api_request` handler**

Replace the `api_request` block in `src/otel-receiver.ts` (lines 169-184):

```ts
    if (eventName === "api_request") {
      const cacheReadTokens = this.findAttrNumber(attrs, "cache_read_tokens");

      const existing = this.state.get(sessionName) ?? makeSessionOtelState();
      existing.lastRequestTime = Date.now();
      existing.cacheWasHit = cacheReadTokens > 0;
      existing.lastError = null;

      // Context occupancy: a main-loop request sends the entire conversation, so
      // its input-side total IS the current context size. query_source isolates
      // the main REPL thread from compaction/subagent requests (which are smaller
      // and would otherwise corrupt the figure). Latest main-thread total wins, so
      // the number also drops after a /compact or /clear. When query_source is
      // absent (older Claude Code) fall back to a high-water max to dodge subagents.
      const querySource = this.findAttrString(attrs, "query_source");
      const inputTokens = this.findAttrNumber(attrs, "input_tokens");
      const cacheCreationTokens = this.findAttrNumber(attrs, "cache_creation_tokens");
      const total = inputTokens + cacheReadTokens + cacheCreationTokens;
      if (querySource === "repl_main_thread") {
        existing.contextTokens = total;
      } else if (querySource === null) {
        existing.contextTokens = Math.max(existing.contextTokens, total);
      }
      // else: "compact" / subagent — leave contextTokens unchanged.

      this.state.set(sessionName, existing);

      this.onUpdate?.(sessionName);
      this.emitSessionUpdate(sessionName);
      this.onAgentResumeHint(sessionName);
      return;
    }
```

- [ ] **Step 5: Reset on compaction**

In the `compaction` handler (lines 207-214), add the reset line:

```ts
    if (eventName === "compaction") {
      const existing = this.state.get(sessionName) ?? makeSessionOtelState();
      existing.lastCompactionTime = Date.now();
      existing.contextTokens = 0;
      this.state.set(sessionName, existing);
      this.onUpdate?.(sessionName);
      this.emitSessionUpdate(sessionName);
      return;
    }
```

- [ ] **Step 6: Reduce `tool_result` to a resume-hint trigger**

Replace the `tool_result` block (lines 249-267):

```ts
    if (eventName === "tool_result") {
      // tool_result no longer mutates OTEL state (lastTool was removed). It only
      // nudges the agent state machine to close the WAITING→RUNNING gap when
      // Claude resumes after a permission grant. Deliberately do NOT touch
      // this.state or emit onUpdate/emitSessionUpdate — that would persist a
      // blank OTEL state for a session that has produced no real OTEL data.
      this.onAgentResumeHint(sessionName);
      return;
    }
```

- [ ] **Step 7: Update the snapshot get/set methods**

Replace the return object in `getSessionSnapshot` (lines 44-53):

```ts
    return {
      contextTokens: s.contextTokens,
      cacheWasHit: s.lastRequestTime > 0 ? s.cacheWasHit : null,
      lastRequestTime: toIso(s.lastRequestTime),
      lastCompactionTime: toIso(s.lastCompactionTime),
      lastUserPromptTime: toIso(s.lastUserPromptTime),
      lastError: s.lastError?.type ?? null,
      failedMcpServers: Array.from(s.failedMcpServers),
    };
```

In `setSessionSnapshot` (lines 68-81), remove the `costUsd` and `lastTool` lines and add `contextTokens`:

```ts
    const existing = this.state.get(name) ?? makeSessionOtelState();
    existing.contextTokens = snap.contextTokens ?? 0;
    existing.cacheWasHit = snap.cacheWasHit ?? false;
    existing.lastRequestTime = fromIso(snap.lastRequestTime);
    existing.lastCompactionTime = snap.lastCompactionTime ? fromIso(snap.lastCompactionTime) : null;
    existing.lastUserPromptTime = snap.lastUserPromptTime ? fromIso(snap.lastUserPromptTime) : null;
    existing.lastError = snap.lastError
      ? { type: snap.lastError as ErrorState["type"], timestamp: 0 }
      : null;
    existing.failedMcpServers = new Set(snap.failedMcpServers);
    this.state.set(name, existing);
    this.emitSessionUpdate(name);
```

- [ ] **Step 8: Run the receiver tests to verify they pass**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: PASS (all tests).

- [ ] **Step 9: Commit**

```bash
git add src/otel-receiver.ts src/__tests__/otel-receiver.test.ts
git commit -m "feat(otel): track context occupancy from main-thread requests; tool_result is resume-only"
```

---

## Task 3: Row-3 view & rendering

Rewrite `buildSessionRow3` to render the context figure + state label, and drop the now-dead cost/tool/idle helpers and the `lastTool` timer candidate.

**Files:**
- Modify: `src/session-view.ts:108-121` (timer candidates), `:165-178` (helpers), `:194-287` (`buildSessionRow3`)
- Modify: `src/sidebar.ts:780` (comment only)
- Test: `src/__tests__/session-view.test.ts:162-241`, `:333-405`
- Test: `src/__tests__/sidebar.test.ts:774-794`, `:860-881`

- [ ] **Step 1: Replace the `buildSessionRow3` unit tests**

In `src/__tests__/session-view.test.ts`, replace the entire `describe("buildSessionRow3", ...)` block (lines 162-241) with context-figure tests:

```ts
describe("buildSessionRow3", () => {
  const baseState = () => makeSessionOtelState();

  test("formats context tokens as 112k", () => {
    const state = baseState();
    state.contextTokens = 112000;
    expect(buildSessionRow3(state, 26, null).text).toContain("112k");
  });

  test("rounds context tokens to the nearest k", () => {
    const state = baseState();
    state.contextTokens = 8400;
    expect(buildSessionRow3(state, 26, null).text).toContain("8k");
  });

  test("formats a million-plus context as 1.2M", () => {
    const state = baseState();
    state.contextTokens = 1_200_000;
    expect(buildSessionRow3(state, 26, null).text).toContain("1.2M");
  });

  test("non-promoted with no context → empty string", () => {
    expect(buildSessionRow3(baseState(), 26, null).text).toBe("");
    expect(buildSessionRow3(baseState(), 26, null).labelCol).toBe(-1);
  });

  test("never renders a dollar amount or tool name", () => {
    const state = baseState();
    state.contextTokens = 112000;
    const out = buildSessionRow3(state, 26, null).text;
    expect(out).not.toContain("$");
    expect(out).not.toContain("Edit");
    expect(out).not.toContain("idle");
  });
});
```

- [ ] **Step 2: Replace the promoted/non-promoted row-3 tests**

In the same file, replace the `rowWithState` helper (lines 333-343) and the two `describe` blocks that follow (lines 345-405) with:

```ts
function rowWithState(
  state: AgentState,
  width: number,
  otelOverrides: Partial<SessionOtelState> = {},
): string {
  const otel = makeSessionOtelState();
  otel.contextTokens = 112000;
  Object.assign(otel, otelOverrides);
  return buildSessionRow3(otel, width, state).text;
}

describe("buildSessionRow3 — promoted session with state label", () => {
  test("wide width (26) — context + state, state on right", () => {
    const text = rowWithState("running", 26);
    expect(text).toContain("112k");
    expect(text.trimEnd().endsWith("RUNNING")).toBe(true);
  });

  test("narrow width — drop context, keep state on right", () => {
    const text = rowWithState("waiting", 9);
    expect(text).not.toContain("112k");
    expect(text.trimEnd().endsWith("WAITING")).toBe(true);
  });

  test("zero width — degrades gracefully (state truncated, no throw)", () => {
    expect(() => rowWithState("running", 0)).not.toThrow();
  });

  test("labelCol points at the state label position", () => {
    const otel = makeSessionOtelState();
    otel.contextTokens = 112000;
    const result = buildSessionRow3(otel, 26, "running");
    expect(result.labelCol).toBeGreaterThanOrEqual(0);
    expect(result.text.slice(result.labelCol)).toBe("RUNNING");
  });
});

describe("buildSessionRow3 — non-promoted session", () => {
  test("null state with context → context only, labelCol -1", () => {
    const otel = makeSessionOtelState();
    otel.contextTokens = 38000;
    const result = buildSessionRow3(otel, 26, null);
    expect(result.text).toContain("38k");
    expect(result.labelCol).toBe(-1);
  });

  test("null state with no data → empty string", () => {
    const result = buildSessionRow3(makeSessionOtelState(), 26, null);
    expect(result.text).toBe("");
    expect(result.labelCol).toBe(-1);
  });
});
```

- [ ] **Step 3: Run the view tests to verify they fail**

Run: `bun test src/__tests__/session-view.test.ts`
Expected: FAIL — `buildSessionRow3` still renders cost/tool/idle and reads `state.costUsd`/`state.lastTool`, so context assertions fail.

- [ ] **Step 4: Rewrite `buildSessionRow3` and drop dead helpers**

In `src/session-view.ts`, delete `formatToolDuration` (lines 165-174) and `formatIdle` (lines 176-178). Replace the entire `buildSessionRow3` function (lines 194-287) with:

```ts
function formatContext(tokens: number): string {
  if (tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

export function buildSessionRow3(
  state: SessionOtelState,
  width: number,
  agentState: AgentState | null,
): SessionRow3Result {
  const contextText = formatContext(state.contextTokens);
  const usable = Math.max(0, width);

  // Promoted session: the state label is the right-anchored sentinel and always
  // stays. The context figure is dropped first if it doesn't fit.
  if (agentState !== null) {
    const stateText = STATE_LABEL[agentState];
    const candidates: Array<Array<{ text: string; align: "left" | "right" }>> = [];
    if (contextText) {
      candidates.push([
        { text: contextText, align: "left" },
        { text: stateText, align: "right" },
      ]);
    }
    candidates.push([{ text: stateText, align: "right" }]);

    for (const fields of candidates) {
      const totalLen = fields.reduce((s, f) => s + f.text.length, 0)
        + Math.max(0, fields.length - 1) * ROW3_GAP.length;
      if (totalLen <= usable) {
        const text = layoutRow3(fields, usable);
        const labelCol = text.length >= stateText.length
          ? text.length - stateText.length
          : 0;
        return { text, labelCol };
      }
    }
    const text = stateText.slice(0, usable);
    return { text, labelCol: 0 };
  }

  // Non-promoted session: context figure only, left-aligned. No state label.
  if (contextText.length > 0 && contextText.length <= usable) {
    return { text: contextText, labelCol: -1 };
  }
  if (contextText.length > 0) {
    return { text: contextText.slice(0, usable), labelCol: -1 };
  }
  return { text: "", labelCol: -1 };
}
```

(Keep `STATE_LABEL`, `ROW3_GAP`, `SessionRow3Result`, and `layoutRow3` as-is.)

- [ ] **Step 5: Drop the `lastTool` candidate from the timer fallback**

In `buildSessionView` (`src/session-view.ts:108-121`), remove the `lastTool` entry from the elapsed-time candidate list:

```ts
  if (timerText === null) {
    if (agentStateRecord) {
      timerText = formatElapsed(now - agentStateRecord.since);
    } else if (timerState) {
      const candidates = [
        timerState.lastRequestTime,
        timerState.lastUserPromptTime ?? 0,
      ].filter((t) => t > 0);
      if (candidates.length > 0) {
        timerText = formatElapsed(now - Math.max(...candidates));
      }
    }
  }
```

- [ ] **Step 6: Run the view tests to verify they pass**

Run: `bun test src/__tests__/session-view.test.ts`
Expected: PASS (all tests).

- [ ] **Step 7: Update the sidebar row-3 tests**

In `src/__tests__/sidebar.test.ts`:

In `updateSessions prunes otelStates ...` (lines 774-794), replace the two `costUsd` overrides and the trailing cost assertion with `contextTokens`:

```ts
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      contextTokens: 100000,
    });
    sidebar.setSessionOtelState("$1", {
      ...makeBlankOtelState(),
      contextTokens: 200000,
    });
    expect(sidebar._otelStateCount()).toBe(2);
    // Now drop beta. Its state should be evicted.
    sidebar.updateSessions(makeSessions([{ name: "alpha" }]));
    expect(sidebar._otelStateCount()).toBe(1);
    // Sanity check: alpha's render shouldn't surface beta's context figure.
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[4][i].char).join("");
    expect(text).not.toContain("200k");
```

Replace `session shows cost / tool / idle on row 3` (lines 860-881) with:

```ts
  test("session shows context tokens on row 3", () => {
    const width = 30;
    const sidebar = new Sidebar(width, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setActiveSession("$0");
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      contextTokens: 112000,
    });
    const grid = sidebar.getGrid();
    // Name row 2, detail row 3, row 3 is row 4
    const text = Array.from({ length: width }, (_, i) => grid.cells[4][i].char).join("");
    expect(text).toContain("112k");
    expect(text).not.toContain("$");
  });
```

- [ ] **Step 8: Update the stale comment in `src/sidebar.ts`**

At `src/sidebar.ts:780`, replace the comment:

```ts
    // Row 3: context tokens (left) / agent state label (right). Non-promoted
    // sessions show the context figure alone.
```

- [ ] **Step 9: Run the sidebar tests to verify they pass**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: PASS (all tests).

- [ ] **Step 10: Commit**

```bash
git add src/session-view.ts src/sidebar.ts src/__tests__/session-view.test.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): render context tokens on session row 3"
```

---

## Task 4: Cleanup remaining references & fixtures

Sweep the runtime + test sources for any surviving `costUsd`/`lastTool` references and fix the last fixture.

**Files:**
- Modify: `src/__tests__/snapshot/restore-links-upsert.test.ts:57-66`

- [ ] **Step 1: Fix the restore test fixture**

In `src/__tests__/snapshot/restore-links-upsert.test.ts`, replace the `otel` object (lines 57-66) — drop `costUsd`/`lastTool`, add `contextTokens`:

```ts
      otel: {
        contextTokens: 112000,
        cacheWasHit: true,
        lastRequestTime: "2026-05-12T00:00:00.000Z",
        lastCompactionTime: null,
        lastUserPromptTime: null,
        lastError: null,
        failedMcpServers: [],
      },
```

- [ ] **Step 2: Sweep the source tree for stragglers**

Run: `rg -n "costUsd|lastTool|LastTool|formatToolDuration|formatIdle" src`
Expected: **no output.** (Historical files under `docs/superpowers/specs` and `docs/superpowers/plans` legitimately mention the old names while describing the change — they are out of scope and must not be edited.) If `rg` reports any `src/...` hit, fix that reference (it will be a missed consumer) before continuing.

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: PASS — all suites green.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/snapshot/restore-links-upsert.test.ts
git commit -m "test(snapshot): drop costUsd/lastTool from restore fixture"
```

---

## Task 5: Full validation

Confirm strict typecheck and the whole suite are green together — this is the gate that proves no consumer of the removed fields was missed.

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: PASS with no errors. (If tsc reports `costUsd`/`lastTool` does not exist on a type, that file is a missed consumer — fix it, re-run, and fold the fix into the relevant earlier commit or a new `fix:` commit.)

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: PASS — all suites.

- [ ] **Step 3: Final straggler sweep (belt-and-suspenders)**

Run: `rg -n "costUsd|lastTool" src`
Expected: no output.

- [ ] **Step 4: Commit any typecheck fixups**

If Step 1 required changes:

```bash
git add -A
git commit -m "fix: resolve typecheck stragglers after cost/lastTool removal"
```

If no fixups were needed, there is nothing to commit — the feature is complete.

---

## Self-Review notes (for the implementer)

- **`labelCol` semantics unchanged:** the sidebar (`src/sidebar.ts:800-809`) repaints the state label using `result.labelCol`; the rewritten `buildSessionRow3` keeps `labelCol` as the offset of the state label within `text` (and `-1` when there is no label), so the sidebar needs no change beyond the comment.
- **`EMPTY_OTEL_STATE` path retained:** `src/sidebar.ts:785` still feeds a blank OTEL state to `buildSessionRow3` for a promoted-but-no-OTEL session so its state label renders. `makeSessionOtelState()` now yields `contextTokens: 0`, which `formatContext` maps to `""` — so such a session shows only its state label. Correct.
- **Bun vs tsc:** intermediate tasks may leave `tsc` red; only Task 5 guarantees a clean typecheck. Do not "fix" a red tsc mid-task by editing files a later task owns — follow the task order.
