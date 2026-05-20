# Session Agent State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface explicit per-session agent state (RUNNING / WAITING / COMPLETE) in the jmux sidebar, driven by Claude Code hooks and stored on the tmux session itself.

**Architecture:** Four Claude Code hooks (UserPromptSubmit, PermissionRequest, PreToolUse, Stop) write `@jmux-agent-state` and `@jmux-agent-state-since` tmux user options. jmux subscribes to these options via its existing control channel and reflects them through a new `AgentStateTracker`. `OtelReceiver` emits a `onAgentResumeHint(sessionName)` callback on `api_request`/`tool_result`; `main.ts` owns the name→id resolution and tmux write that closes the WAITING→RUNNING gap. The sidebar shows state via a color-coded col-1 glyph, a state label on row 2, and a unified row-1 timer anchored on `agentStateSince` for promoted sessions. The legacy `@jmux-attention` flag and `!` indicator are retired.

**Tech Stack:** TypeScript, Bun 1.3.8+, bun:test, tmux 3.2+ user options, existing OTLP receiver, existing snapshot system (`src/snapshot/**`).

**Spec:** `docs/superpowers/specs/2026-05-20-session-agent-state-design.md`

---

## File Structure

**New files:**

- `src/types.ts` — gains `AgentState` union (extending existing file)
- `src/agent-state.ts` — `AgentStateTracker` class + `coerceStaleAgentState` pure helper
- `src/hook-installer.ts` — pure functions to build / merge / detect the four-hook block in a Claude Code `settings.json` object
- `src/__tests__/agent-state.test.ts` — tracker + coercion tests
- `src/__tests__/hook-installer.test.ts` — installer-merge tests with golden JSON

**Modified files:**

- `src/types.ts` — `SessionView` keeps existing shape; `AgentState` added
- `src/session-view.ts` — `buildSessionView` gains `agentState`/`agentStateSince` fields and the new row-1 timer fallback; `buildSessionRow3` is reworked to slot the state label on the right with new drop priority
- `src/sidebar.ts` — col-1 indicator priority updates; row 2 renders the state label
- `src/otel-receiver.ts` — constructor accepts `onAgentResumeHint`; receiver calls it on `api_request` / `tool_result`
- `src/snapshot/schema.ts` — additive nullable `agentState?: SnapshotAgentState | null` on `SnapshotSession`; validator accepts absent / null / well-formed object
- `src/snapshot/model.ts` — `setAgentState(name, state)` on `SnapshotModel`; `makeEmptySession` initialises field to `null`
- `src/snapshot/capture.ts` — `onAgentState(name, state)` on `Snapshotter` mirrors existing `onAttention`/`onOtel`
- `src/snapshot/restore.ts` — `agentStateSink?` option; calls it for each restored session, applying the 10-min stale coercion
- `src/main.ts` — wires `AgentStateTracker`, control-channel subscription for the two new options, OTEL resume callback, legacy cleanup, snapshot capture/restore sinks, and replaces the in-file `installAgentHooks` body with a call to `hook-installer.ts`
- `src/cli/session.ts` — `list-sessions` format strings drop `#{@jmux-attention}`, gain `#{@jmux-agent-state}` / `#{@jmux-agent-state-since}` (or — preferable — stop surfacing attention entirely from JSON output)
- `src/__tests__/session-view.test.ts` — extended with timer fallback and row-2 state-label cases
- `src/__tests__/sidebar.test.ts` — extended with indicator-priority and state-label render cases
- `src/__tests__/otel-receiver.test.ts` — extended with `onAgentResumeHint` callback assertions
- `src/__tests__/snapshot/schema.test.ts` — extended with agent-state acceptance / rejection cases
- `src/__tests__/snapshot/model.test.ts` — extended with `setAgentState` assertions

---

## Conventions used in this plan

- Commands use `bun` (the project targets Bun 1.3.8+; do not substitute `node`).
- All test files import from `bun:test`.
- Commit messages follow the existing style (see `git log --oneline`): `feat(scope): ...`, `refactor(scope): ...`, `test(scope): ...`. Co-author footers are never added to commits in this repo.
- Type names match the spec verbatim. Where the plan says `AgentState`, the type is `"running" | "waiting" | "complete"`.
- Every `agentStateSince` value is **epoch milliseconds** inside the TS code, but **epoch seconds** in the tmux user option (because hooks write `$(date +%s)`). The conversion lives in `AgentStateTracker.apply()`.

---

## Task 1: AgentState type and AgentStateTracker module

**Files:**

- Modify: `src/types.ts` (add `AgentState` union)
- Create: `src/agent-state.ts`
- Create: `src/__tests__/agent-state.test.ts`

- [ ] **Step 1: Add the `AgentState` union to `src/types.ts`**

Add at the bottom of the file (above any closing braces, e.g. just before the trailing types):

```ts
export type AgentState = "running" | "waiting" | "complete";

export interface AgentStateRecord {
  state: AgentState;
  /** Epoch milliseconds. Converted from the seconds the hook writes. */
  since: number;
}
```

- [ ] **Step 2: Write the failing tests for `AgentStateTracker`**

Create `src/__tests__/agent-state.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { AgentStateTracker } from "../agent-state";

describe("AgentStateTracker.apply", () => {
  test("stores a valid (state, since) pair", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    expect(t.getRecord("$1")).toEqual({
      state: "running",
      since: 1_717_000_000_000,
    });
    expect(t.getState("$1")).toBe("running");
  });

  test("clears the record when state is null or empty", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    t.apply("$1", null, null);
    expect(t.getRecord("$1")).toBeNull();
    expect(t.getState("$1")).toBeNull();
  });

  test("treats empty-string raw values as cleared (tmux unset)", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    t.apply("$1", "", "");
    expect(t.getRecord("$1")).toBeNull();
  });

  test("ignores invalid state strings", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    t.apply("$1", "bogus", "1717000010");
    expect(t.getRecord("$1")?.state).toBe("running");
  });

  test("falls back to nowMs when since is missing or unparseable", () => {
    const t = new AgentStateTracker(() => 1_800_000_000_000);
    t.apply("$1", "running", null);
    expect(t.getRecord("$1")).toEqual({
      state: "running",
      since: 1_800_000_000_000,
    });
    t.apply("$2", "running", "not-a-number");
    expect(t.getRecord("$2")?.since).toBe(1_800_000_000_000);
  });

  test("getState returns null for unknown ids", () => {
    const t = new AgentStateTracker();
    expect(t.getState("$missing")).toBeNull();
    expect(t.getRecord("$missing")).toBeNull();
  });
});

describe("AgentStateTracker.onChange", () => {
  test("fires on real changes", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("$1", "running", "1717000000");
    t.apply("$1", "waiting", "1717000010");
    expect(seen).toEqual(["$1", "$1"]);
  });

  test("does NOT fire on idempotent (same state, same since) re-apply", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("$1", "running", "1717000000");
    t.apply("$1", "running", "1717000000");
    expect(seen).toEqual(["$1"]);
  });

  test("DOES fire when only since changes", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("$1", "running", "1717000000");
    t.apply("$1", "running", "1717000050");
    expect(seen).toEqual(["$1", "$1"]);
  });

  test("fires on clear if there was a prior record", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("$1", "running", "1717000000");
    t.apply("$1", null, null);
    expect(seen).toEqual(["$1", "$1"]);
  });

  test("does NOT fire on clear if there was no prior record", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("$1", null, null);
    expect(seen).toEqual([]);
  });
});

describe("AgentStateTracker.pruneExcept", () => {
  test("removes records for ids not in the active set", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    t.apply("$2", "waiting", "1717000010");
    t.apply("$3", "complete", "1717000020");

    t.pruneExcept(["$1", "$3"]);
    expect(t.getState("$1")).toBe("running");
    expect(t.getState("$2")).toBeNull();
    expect(t.getState("$3")).toBe("complete");
  });
});

describe("AgentStateTracker.size", () => {
  test("reflects number of tracked records", () => {
    const t = new AgentStateTracker();
    expect(t.size).toBe(0);
    t.apply("$1", "running", "1717000000");
    expect(t.size).toBe(1);
    t.apply("$1", null, null);
    expect(t.size).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```
bun test src/__tests__/agent-state.test.ts
```

Expected: FAIL with `Cannot find module '../agent-state'`.

- [ ] **Step 4: Implement `AgentStateTracker`**

Create `src/agent-state.ts`:

```ts
import type { AgentState, AgentStateRecord } from "./types";

const VALID_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "complete",
]);

function isAgentState(v: string): v is AgentState {
  return VALID_STATES.has(v);
}

type ChangeListener = (sessionId: string) => void;

/**
 * Reflects the per-session @jmux-agent-state / @jmux-agent-state-since
 * tmux user options into a typed in-process map. Treats tmux as the source
 * of truth — apply() consumes raw string updates from the control channel
 * and parses/validates them.
 */
export class AgentStateTracker {
  private records = new Map<string, AgentStateRecord>();
  private listeners: ChangeListener[] = [];

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  get size(): number {
    return this.records.size;
  }

  getState(sessionId: string): AgentState | null {
    return this.records.get(sessionId)?.state ?? null;
  }

  getRecord(sessionId: string): AgentStateRecord | null {
    return this.records.get(sessionId) ?? null;
  }

  onChange(fn: ChangeListener): void {
    this.listeners.push(fn);
  }

  /**
   * Apply an update from the control channel. rawState comes from
   * @jmux-agent-state; rawSince comes from @jmux-agent-state-since (epoch
   * seconds as a string, the way `date +%s` produces it).
   *
   * - null or empty rawState clears the record.
   * - unknown rawState is ignored (no state change, no emission).
   * - missing/unparseable rawSince falls back to nowMs().
   * - idempotent re-apply (same state, same since) does not emit.
   */
  apply(
    sessionId: string,
    rawState: string | null,
    rawSince: string | null,
  ): void {
    const previous = this.records.get(sessionId) ?? null;

    if (rawState === null || rawState === "") {
      if (previous === null) return;
      this.records.delete(sessionId);
      this.emit(sessionId);
      return;
    }

    if (!isAgentState(rawState)) return;

    const sinceMs = this.parseSinceMs(rawSince);
    if (previous && previous.state === rawState && previous.since === sinceMs) {
      return;
    }
    this.records.set(sessionId, { state: rawState, since: sinceMs });
    this.emit(sessionId);
  }

  pruneExcept(activeIds: string[]): void {
    const active = new Set(activeIds);
    for (const id of this.records.keys()) {
      if (!active.has(id)) {
        this.records.delete(id);
        // Intentionally no emit — pruning is a cleanup pass, not a
        // semantic state change. The renderer will reconcile via the
        // session list.
      }
    }
  }

  private parseSinceMs(rawSince: string | null): number {
    if (rawSince === null || rawSince === "") return this.nowMs();
    const seconds = Number(rawSince);
    if (!Number.isFinite(seconds) || seconds <= 0) return this.nowMs();
    return Math.floor(seconds * 1000);
  }

  private emit(sessionId: string): void {
    for (const fn of this.listeners) fn(sessionId);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
bun test src/__tests__/agent-state.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/types.ts src/agent-state.ts src/__tests__/agent-state.test.ts
git commit -m "feat(agent-state): AgentStateTracker reflects tmux user options"
```

---

## Task 2: Snapshot stale-state coercion helper

**Note on type sharing:** The schema type `SnapshotAgentState` is added in Task 3. `coerceStaleAgentState` accepts a structural shape that matches it — `{ state: AgentState; since: string }`. We do not duplicate the type; we import it from `./snapshot/schema` once Task 3 lands. To keep this task self-contained (so it builds before Task 3), we declare a local non-exported alias in `src/agent-state.ts` that Task 3 will replace with a re-export.

**Files:**

- Modify: `src/agent-state.ts` (add `coerceStaleAgentState`)
- Modify: `src/__tests__/agent-state.test.ts` (add `coerceStaleAgentState` tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/agent-state.test.ts`:

```ts
import { coerceStaleAgentState } from "../agent-state";

const TEN_MIN_MS = 10 * 60 * 1000;

describe("coerceStaleAgentState", () => {
  test("returns null unchanged", () => {
    expect(
      coerceStaleAgentState(null, "2026-05-20T12:00:00Z", Date.parse("2026-05-20T12:05:00Z"), TEN_MIN_MS),
    ).toBeNull();
  });

  test("returns the input unchanged when within the threshold", () => {
    const stored = { state: "running" as const, since: "2026-05-20T11:59:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T12:00:00Z",
      Date.parse("2026-05-20T12:05:00Z"),
      TEN_MIN_MS,
    );
    expect(out).toEqual(stored);
  });

  test("coerces stale running to complete", () => {
    const stored = { state: "running" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T10:00:00Z",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out).toEqual({
      state: "complete",
      since: "2026-05-20T10:00:00Z",
    });
  });

  test("coerces stale waiting to complete", () => {
    const stored = { state: "waiting" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T10:00:00Z",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out?.state).toBe("complete");
  });

  test("leaves stale complete unchanged", () => {
    const stored = { state: "complete" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T10:00:00Z",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out).toEqual(stored);
  });

  test("malformed capturedAt is treated as stale (safest)", () => {
    const stored = { state: "running" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "garbage",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out?.state).toBe("complete");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
bun test src/__tests__/agent-state.test.ts
```

Expected: FAIL with `coerceStaleAgentState is not a function` (or similar).

- [ ] **Step 3: Implement the helper**

Append to `src/agent-state.ts`. Fold `AgentState` into the existing `import type` line at the top of the file instead of adding a second import:

```ts
/**
 * Structural shape for a stored snapshot agent state. Task 3 will declare
 * the canonical `SnapshotAgentState` type in `src/snapshot/schema.ts`
 * with this exact shape, and Task 5's restore wiring will pass it
 * through here unchanged — structural typing keeps these compatible
 * without a cross-module import.
 */
interface StoredAgentState {
  state: AgentState;
  /** ISO timestamp string. */
  since: string;
}

/**
 * If the snapshot is older than `thresholdMs` and the stored state is
 * `running` or `waiting`, coerce it to `complete` — an agent that was
 * running 10+ minutes ago without any subsequent hook fire is almost
 * certainly dead. Used by the snapshot restore path.
 *
 * A malformed `capturedAt` is treated as stale (safest: we don't want
 * to leave a bogus "RUNNING 4h" on the screen after a long suspend).
 */
export function coerceStaleAgentState<T extends StoredAgentState>(
  stored: T | null,
  capturedAt: string,
  nowMs: number,
  thresholdMs: number,
): T | null {
  if (stored === null) return null;
  if (stored.state === "complete") return stored;

  const capturedMs = Date.parse(capturedAt);
  const age = Number.isFinite(capturedMs)
    ? nowMs - capturedMs
    : Number.POSITIVE_INFINITY;

  if (age <= thresholdMs) return stored;
  return { ...stored, state: "complete" };
}
```

The generic `<T extends StoredAgentState>` means callers in Task 11 can pass a `SnapshotAgentState` and get back a `SnapshotAgentState` (not a wider structural type), and the spread `{ ...stored, state: "complete" }` preserves any extra fields the schema may later add.

- [ ] **Step 4: Run tests to verify they pass**

```
bun test src/__tests__/agent-state.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```
git add src/agent-state.ts src/__tests__/agent-state.test.ts
git commit -m "feat(agent-state): coerceStaleAgentState for snapshot restore"
```

---

## Task 3: Snapshot schema accepts agentState

**Files:**

- Modify: `src/snapshot/schema.ts`
- Modify: `src/__tests__/snapshot/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/snapshot/schema.test.ts` (inside the existing `describe`):

```ts
test("validateSnapshot accepts a session with agentState absent (v1 back-compat)", () => {
  // `good` does not include agentState; baseline test already passes.
  const result = validateSnapshot(good);
  expect(result.ok).toBe(true);
});

test("validateSnapshot accepts agentState: null", () => {
  const snap = { ...good, sessions: [{ ...good.sessions[0], agentState: null }] };
  const result = validateSnapshot(snap);
  expect(result.ok).toBe(true);
});

test("validateSnapshot accepts a well-formed agentState object", () => {
  const snap = {
    ...good,
    sessions: [
      {
        ...good.sessions[0],
        agentState: { state: "running", since: "2026-05-20T12:00:00.000Z" },
      },
    ],
  };
  const result = validateSnapshot(snap);
  expect(result.ok).toBe(true);
});

test("validateSnapshot rejects an invalid agentState.state", () => {
  const snap = {
    ...good,
    sessions: [
      {
        ...good.sessions[0],
        agentState: { state: "bogus", since: "2026-05-20T12:00:00.000Z" },
      },
    ],
  };
  const result = validateSnapshot(snap);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("agentState");
});

test("validateSnapshot rejects an agentState with non-string since", () => {
  const snap = {
    ...good,
    sessions: [
      {
        ...good.sessions[0],
        agentState: { state: "running", since: 12345 },
      },
    ],
  };
  const result = validateSnapshot(snap);
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
bun test src/__tests__/snapshot/schema.test.ts
```

Expected: the four new tests pass except the two that rely on validator rejecting bad shapes — those will fail because the validator currently ignores unknown fields. Confirm.

- [ ] **Step 3: Extend the schema and validator**

Edit `src/snapshot/schema.ts`. Above `SnapshotSession`:

```ts
export type SnapshotAgentStateName = "running" | "waiting" | "complete";

export interface SnapshotAgentState {
  state: SnapshotAgentStateName;
  /** ISO timestamp, like other snapshot times. */
  since: string;
}
```

Extend `SnapshotSession`:

```ts
export interface SnapshotSession {
  name: string;
  cwd: string;
  worktreePath: string | null;
  projectGroup: string | null;
  pinned: boolean;
  attention: boolean;
  permissionMode: SnapshotPermissionMode;
  otel: SnapshotOtel | null;
  links: SessionLink[];
  windows: SnapshotWindow[];
  /** Optional & nullable for v1 back-compat. Absent means "no agent signal seen yet". */
  agentState?: SnapshotAgentState | null;
}
```

Add a validator helper above `validateSession`:

```ts
const KNOWN_AGENT_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "complete",
]);

function validateAgentState(v: unknown, path: string): string | null {
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) return `${path}: not an object, null, or absent`;
  if (typeof v.state !== "string" || !KNOWN_AGENT_STATES.has(v.state)) {
    return `${path}.state: invalid`;
  }
  if (typeof v.since !== "string" || !ISO_RX.test(v.since)) {
    return `${path}.since: not an ISO timestamp`;
  }
  return null;
}
```

Inside `validateSession`, after the `windows` loop, add:

```ts
const agentStateErr = validateAgentState(v.agentState, `${path}.agentState`);
if (agentStateErr) return agentStateErr;
```

- [ ] **Step 4: Run tests to verify they pass**

```
bun test src/__tests__/snapshot/schema.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```
git add src/snapshot/schema.ts src/__tests__/snapshot/schema.test.ts
git commit -m "feat(snapshot): accept additive nullable agentState (no version bump)"
```

---

## Task 4: SnapshotModel and Snapshotter wire agentState

**Files:**

- Modify: `src/snapshot/model.ts`
- Modify: `src/snapshot/capture.ts`
- Modify: `src/__tests__/snapshot/model.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/snapshot/model.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { SnapshotModel } from "../../snapshot/model";

describe("SnapshotModel.setAgentState", () => {
  test("upserts the agentState for an existing session", () => {
    const m = new SnapshotModel("0.0.0");
    m.upsertSession(SnapshotModel.makeEmptySession("foo", "/tmp"));
    m.setAgentState("foo", {
      state: "running",
      since: "2026-05-20T12:00:00.000Z",
    });
    expect(m.getSession("foo")?.agentState).toEqual({
      state: "running",
      since: "2026-05-20T12:00:00.000Z",
    });
  });

  test("setting null clears the agentState", () => {
    const m = new SnapshotModel("0.0.0");
    m.upsertSession(SnapshotModel.makeEmptySession("foo", "/tmp"));
    m.setAgentState("foo", { state: "running", since: "2026-05-20T12:00:00.000Z" });
    m.setAgentState("foo", null);
    expect(m.getSession("foo")?.agentState).toBeNull();
  });

  test("setting on an unknown session is a no-op", () => {
    const m = new SnapshotModel("0.0.0");
    m.setAgentState("missing", { state: "running", since: "2026-05-20T12:00:00.000Z" });
    expect(m.getSession("missing")).toBeUndefined();
  });

  test("makeEmptySession initialises agentState to null", () => {
    const s = SnapshotModel.makeEmptySession("foo", "/tmp");
    expect(s.agentState).toBeNull();
  });

  test("toFile preserves agentState", () => {
    const m = new SnapshotModel("0.0.0");
    m.upsertSession(SnapshotModel.makeEmptySession("foo", "/tmp"));
    m.setAgentState("foo", { state: "waiting", since: "2026-05-20T12:00:00.000Z" });
    const file = m.toFile("2026-05-20T12:01:00.000Z");
    expect(file.sessions[0].agentState).toEqual({
      state: "waiting",
      since: "2026-05-20T12:00:00.000Z",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
bun test src/__tests__/snapshot/model.test.ts
```

Expected: FAIL — `setAgentState` not a method.

- [ ] **Step 3: Implement `setAgentState` and initial `null` on `makeEmptySession`**

In `src/snapshot/model.ts`, add the method below `setOtel`:

```ts
setAgentState(
  sessionName: string,
  agentState: import("./schema").SnapshotAgentState | null,
): void {
  const s = this.sessions.get(sessionName);
  if (s) s.agentState = agentState;
}
```

In `makeEmptySession`, add the field:

```ts
static makeEmptySession(name: string, cwd: string): SnapshotSession {
  return {
    name,
    cwd,
    worktreePath: null,
    projectGroup: null,
    pinned: false,
    attention: false,
    permissionMode: null,
    otel: null,
    links: [],
    windows: [],
    agentState: null,
  };
}
```

In `toFile`'s session mapping, the spread (`...s`) already carries the field through; no other change needed.

- [ ] **Step 4: Add the Snapshotter sink**

In `src/snapshot/capture.ts`, mirror `onAttention`. Below the existing `onAttention`:

```ts
onAgentState(
  name: string,
  agentState: import("./schema").SnapshotAgentState | null,
): void {
  this.opts.model.setAgentState(name, agentState);
  this.markDirty();
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
bun test src/__tests__/snapshot/model.test.ts src/__tests__/snapshot/capture-events.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```
git add src/snapshot/model.ts src/snapshot/capture.ts src/__tests__/snapshot/model.test.ts
git commit -m "feat(snapshot): SnapshotModel.setAgentState + Snapshotter.onAgentState"
```

---

## Task 5: Snapshot restore writes agentState back to tmux

**Files:**

- Modify: `src/snapshot/restore.ts`
- Modify: `src/__tests__/snapshot/restore-sequence.test.ts` (or `restore-partial.test.ts` — whichever holds the sink-fanout assertion already)

- [ ] **Step 1: Write the failing tests**

The existing sink fanout test lives in `src/__tests__/snapshot/restore-links-upsert.test.ts`. Append two tests there, mirroring the existing `attentionSink` idiom:

```ts
test("agentStateSink fires for each eligible session with the stored value", async () => {
  const calls: Array<{ name: string; state: any }> = [];
  const fullSnap: SnapshotFile = {
    formatVersion: 1,
    jmuxVersion: "test",
    capturedAt: "2026-05-20T12:00:00.000Z",
    tmuxSocket: "",
    lastFocusedSession: null,
    sessions: [
      {
        name: "alpha",
        cwd: "/repos/foo",
        worktreePath: null,
        projectGroup: null,
        pinned: false,
        attention: false,
        permissionMode: "default",
        otel: null,
        links: [],
        windows: [
          {
            index: 0,
            name: "main",
            layout: "LAYOUT-W0",
            active: true,
            panes: [
              { index: 0, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
            ],
          },
        ],
        agentState: { state: "running", since: "2026-05-20T11:58:00.000Z" },
      },
      {
        name: "beta",
        cwd: "/repos/foo",
        worktreePath: null,
        projectGroup: null,
        pinned: false,
        attention: false,
        permissionMode: "default",
        otel: null,
        links: [],
        windows: [
          {
            index: 0,
            name: "main",
            layout: "LAYOUT-W0",
            active: true,
            panes: [
              { index: 0, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
            ],
          },
        ],
        agentState: null,
      },
    ],
  };
  const r = new Restorer({
    dir: "/snap",
    fs: new FakeFs(),
    runner: new FakeRunner(),
    clock: new FakeClock(),
    jmuxVersion: "test",
    userShell: "/bin/zsh",
    claudeCommand: "claude",
    cwdExists: async (p: string) => p === "/repos/foo",
    agentStateSink: (name, state) => calls.push({ name, state }),
  });
  await r.run(fullSnap);
  expect(calls).toEqual([
    { name: "alpha", state: { state: "running", since: "2026-05-20T11:58:00.000Z" } },
    { name: "beta", state: null },
  ]);
});

test("agentStateSink is not fired for skipped sessions", async () => {
  const calls: Array<{ name: string }> = [];
  const r = new Restorer({
    dir: "/snap",
    fs: new FakeFs(),
    runner: new FakeRunner(),
    clock: new FakeClock(),
    jmuxVersion: "test",
    userShell: "/bin/zsh",
    claudeCommand: "claude",
    // cwdExists returning false for every path causes the restorer to skip
    // sessions — mirrors the existing "no sinks fire for a skipped session"
    // test in this file.
    cwdExists: async () => false,
    agentStateSink: (name) => calls.push({ name }),
  });
  await r.run(/* same fullSnap as the previous test */);
  expect(calls).toEqual([]);
});
```

(Reuse the same `fullSnap` object across the two tests by pulling it out into a helper inside the file, the way the existing two-test pair in this file already does.)

- [ ] **Step 2: Run tests to verify they fail**

```
bun test src/__tests__/snapshot/restore-links-upsert.test.ts
```

Expected: FAIL — `agentStateSink` is not an option on `RestoreOptions`.

- [ ] **Step 4: Add the `agentStateSink` option to `Restorer`**

Edit `src/snapshot/restore.ts`. Extend the `RestoreOptions` (or equivalently-named) interface at line ~15:

```ts
agentStateSink?: (
  name: string,
  agentState: import("./schema").SnapshotAgentState | null,
) => void;
```

In the per-session restore body (the section around line 266 that already calls `attentionSink` and friends), add:

```ts
this.opts.agentStateSink?.(session.name, session.agentState ?? null);
```

Place it next to the existing `attentionSink` call so the order is stable.

- [ ] **Step 5: Run tests to verify they pass**

```
bun test src/__tests__/snapshot/
```

Expected: all snapshot tests pass.

- [ ] **Step 6: Commit**

```
git add src/snapshot/restore.ts src/__tests__/snapshot/restore-sequence.test.ts
git commit -m "feat(snapshot): agentStateSink dispatched per restored session"
```

---

## Task 6: OtelReceiver emits onAgentResumeHint

**Files:**

- Modify: `src/otel-receiver.ts`
- Modify: `src/__tests__/otel-receiver.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/otel-receiver.test.ts`, inside the main `describe("OtelReceiver", ...)`, append:

```ts
describe("onAgentResumeHint callback", () => {
  test("fires on api_request with the session name", async () => {
    const seen: string[] = [];
    const recv = new OtelReceiver({
      onAgentResumeHint: (name) => seen.push(name),
    });
    const port = await recv.start();
    try {
      await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        body: JSON.stringify(makeOtlpPayload({ sessionName: "foo", eventName: "api_request" })),
      });
    } finally {
      recv.stop();
    }
    expect(seen).toEqual(["foo"]);
  });

  test("fires on tool_result with the session name", async () => {
    const seen: string[] = [];
    const recv = new OtelReceiver({
      onAgentResumeHint: (name) => seen.push(name),
    });
    const port = await recv.start();
    try {
      await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        body: JSON.stringify(
          makeOtlpPayload({
            sessionName: "bar",
            eventName: "tool_result",
            attributes: [
              { key: "tool_name", value: { stringValue: "Edit" } },
              { key: "duration_ms", value: { stringValue: "12" } },
              { key: "success", value: { boolValue: true } },
            ],
          }),
        ),
      });
    } finally {
      recv.stop();
    }
    expect(seen).toEqual(["bar"]);
  });

  test("does NOT fire on user_prompt", async () => {
    const seen: string[] = [];
    const recv = new OtelReceiver({
      onAgentResumeHint: (name) => seen.push(name),
    });
    const port = await recv.start();
    try {
      await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        body: JSON.stringify(makeOtlpPayload({ sessionName: "foo", eventName: "user_prompt" })),
      });
    } finally {
      recv.stop();
    }
    expect(seen).toEqual([]);
  });

  test("missing callback is fine (no throw)", async () => {
    const recv = new OtelReceiver();
    const port = await recv.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        body: JSON.stringify(makeOtlpPayload({ eventName: "api_request" })),
      });
      expect(res.status).toBe(200);
    } finally {
      recv.stop();
    }
  });
});
```

(If the existing constructor takes positional args, switch the `new OtelReceiver({...})` to whatever shape Step 3 establishes — see below.)

- [ ] **Step 2: Run tests to verify they fail**

```
bun test src/__tests__/otel-receiver.test.ts
```

Expected: FAIL — constructor doesn't accept the options object.

- [ ] **Step 3: Extend the receiver constructor**

Edit `src/otel-receiver.ts`:

Replace the existing class header / constructor with one that accepts an optional options bag. Today the class has no constructor and no fields beyond `private state` / `private server` / etc. Introduce:

```ts
export interface OtelReceiverOptions {
  /**
   * Called once per api_request and tool_result event with the OTLP
   * resource attribute `tmux_session_name`. main.ts uses this to
   * close the WAITING→RUNNING gap when Claude resumes after a
   * permission grant without firing UserPromptSubmit.
   */
  onAgentResumeHint?: (sessionName: string) => void;
}

export class OtelReceiver {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private state = new Map<string, SessionOtelState>();
  private readonly onAgentResumeHint: (name: string) => void;
  onUpdate: ((sessionName: string) => void) | null = null;
  private sessionUpdateListeners: Array<(name: string) => void> = [];

  constructor(opts: OtelReceiverOptions = {}) {
    this.onAgentResumeHint = opts.onAgentResumeHint ?? (() => {});
  }
  // ... existing methods follow unchanged
}
```

In `processRecord`, after the existing `api_request` block, before its `return`, add:

```ts
this.onAgentResumeHint(sessionName);
```

In the `tool_result` block, after `this.onUpdate?.(sessionName); this.emitSessionUpdate(sessionName);`, before its `return`, add:

```ts
this.onAgentResumeHint(sessionName);
```

- [ ] **Step 4: Run tests to verify they pass**

```
bun test src/__tests__/otel-receiver.test.ts
```

Expected: all pass.

- [ ] **Step 5: Update the `new OtelReceiver()` call site in main.ts to use the options-bag shape**

Search:

```
grep -n "new OtelReceiver" src/main.ts
```

Replace `new OtelReceiver()` with `new OtelReceiver({})` for now (callback added in Task 11).

- [ ] **Step 6: Commit**

```
git add src/otel-receiver.ts src/__tests__/otel-receiver.test.ts src/main.ts
git commit -m "feat(otel): emit onAgentResumeHint on api_request and tool_result"
```

---

## Task 7: Hook installer extracted, four-hook block, legacy migration

**Files:**

- Create: `src/hook-installer.ts`
- Create: `src/__tests__/hook-installer.test.ts`
- Modify: `src/main.ts` (replace the body of `installAgentHooks` with a thin wrapper that does only fs I/O and calls into the new module)

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/hook-installer.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import {
  buildHookBlock,
  detectInstalledKind,
  installHooks,
  type InstallOutcome,
} from "../hook-installer";

describe("buildHookBlock", () => {
  test("returns the four-hook spec verbatim", () => {
    const block = buildHookBlock();
    expect(Object.keys(block).sort()).toEqual([
      "PermissionRequest",
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
    for (const [, entries] of Object.entries(block)) {
      const cmd = entries[0].hooks[0].command;
      expect(cmd).toContain("@jmux-agent-state");
      expect(cmd).toContain("@jmux-agent-state-since");
    }
    // PreToolUse must be idempotent — only writes when state != running.
    expect(block.PreToolUse[0].hooks[0].command).toContain(
      'show-option -qv @jmux-agent-state',
    );
  });
});

describe("detectInstalledKind", () => {
  test("empty settings → none", () => {
    expect(detectInstalledKind({})).toBe("none");
    expect(detectInstalledKind({ hooks: {} })).toBe("none");
  });

  test("legacy @jmux-attention Stop hook → legacy", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "tmux set-option @jmux-attention 1 2>/dev/null || true", timeout: 5 },
            ],
          },
        ],
      },
    };
    expect(detectInstalledKind(settings)).toBe("legacy");
  });

  test("new four-hook block → current", () => {
    const settings = { hooks: buildHookBlock() };
    expect(detectInstalledKind(settings)).toBe("current");
  });

  test("partial new install (some hooks present, some missing) → partial", () => {
    const block = buildHookBlock();
    const settings = {
      hooks: {
        Stop: block.Stop,
        UserPromptSubmit: block.UserPromptSubmit,
        // missing PermissionRequest and PreToolUse
      },
    };
    expect(detectInstalledKind(settings)).toBe("partial");
  });
});

describe("installHooks", () => {
  test("none → installs all four", () => {
    const settings = {};
    const out: InstallOutcome = installHooks(settings);
    expect(out.kind).toBe("installed");
    expect(detectInstalledKind(out.settings)).toBe("current");
  });

  test("legacy → removes legacy entry and installs all four", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "tmux set-option @jmux-attention 1 2>/dev/null || true", timeout: 5 },
            ],
          },
        ],
      },
    };
    const out = installHooks(settings);
    expect(out.kind).toBe("migrated");
    expect(detectInstalledKind(out.settings)).toBe("current");
    const stopCommands = (out.settings.hooks!.Stop as any[]).flatMap((e) =>
      e.hooks.map((h: any) => h.command),
    );
    expect(stopCommands.every((c: string) => !c.includes("@jmux-attention"))).toBe(true);
  });

  test("current → noop", () => {
    const settings = { hooks: buildHookBlock() };
    const out = installHooks(settings);
    expect(out.kind).toBe("noop");
    expect(out.settings).toEqual(settings);
  });

  test("partial → fills in missing hooks, leaves existing in place", () => {
    const block = buildHookBlock();
    const settings = { hooks: { Stop: block.Stop } };
    const out = installHooks(settings);
    expect(out.kind).toBe("installed");
    expect(detectInstalledKind(out.settings)).toBe("current");
  });

  test("preserves unrelated Stop entries", () => {
    const unrelated = {
      hooks: [
        { type: "command", command: "echo unrelated", timeout: 5 },
      ],
    };
    const settings = { hooks: { Stop: [unrelated] } };
    const out = installHooks(settings);
    expect(out.kind).toBe("installed");
    // Both unrelated entry AND the jmux Stop entry should be present.
    const stop = out.settings.hooks!.Stop as any[];
    expect(stop).toContainEqual(unrelated);
    expect(stop.some((e) =>
      e.hooks.some((h: any) => h.command.includes("@jmux-agent-state")),
    )).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
bun test src/__tests__/hook-installer.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the installer**

Create `src/hook-installer.ts`:

```ts
export type HookEvent =
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "PreToolUse"
  | "Stop";

interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
}

interface HookEntry {
  hooks: HookCommand[];
}

export type ClaudeSettings = {
  hooks?: Partial<Record<string, HookEntry[]>>;
  [k: string]: unknown;
};

export type InstallKind = "none" | "legacy" | "partial" | "current";
export type InstallOutcomeKind = "installed" | "migrated" | "noop";

export interface InstallOutcome {
  kind: InstallOutcomeKind;
  settings: ClaudeSettings;
}

const SET_RUNNING =
  "tmux set-option @jmux-agent-state running 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null || true";
const SET_WAITING =
  "tmux set-option @jmux-agent-state waiting 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null || true";
const SET_COMPLETE =
  "tmux set-option @jmux-agent-state complete 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null || true";
const SET_RUNNING_IDEMPOTENT =
  "[ \"$(tmux show-option -qv @jmux-agent-state 2>/dev/null)\" = \"running\" ] || { tmux set-option @jmux-agent-state running 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null; } || true";

const TIMEOUT = 5;

const HOOK_COMMANDS: Record<HookEvent, string> = {
  UserPromptSubmit: SET_RUNNING,
  PermissionRequest: SET_WAITING,
  PreToolUse: SET_RUNNING_IDEMPOTENT,
  Stop: SET_COMPLETE,
};

export function buildHookBlock(): Record<HookEvent, HookEntry[]> {
  const out = {} as Record<HookEvent, HookEntry[]>;
  for (const event of Object.keys(HOOK_COMMANDS) as HookEvent[]) {
    out[event] = [
      {
        hooks: [
          { type: "command", command: HOOK_COMMANDS[event], timeout: TIMEOUT },
        ],
      },
    ];
  }
  return out;
}

function isJmuxHookCommand(cmd: string): boolean {
  return cmd.includes("@jmux-agent-state");
}

function isLegacyHookCommand(cmd: string): boolean {
  return cmd.includes("@jmux-attention");
}

function hasJmuxHook(entries: HookEntry[] | undefined): boolean {
  return !!entries?.some((e) => e.hooks.some((h) => isJmuxHookCommand(h.command)));
}

export function detectInstalledKind(settings: ClaudeSettings): InstallKind {
  const hooks = settings.hooks ?? {};
  const legacyStop = hooks.Stop?.some((e) =>
    e.hooks.some((h) => isLegacyHookCommand(h.command)),
  );
  if (legacyStop) return "legacy";

  const events: HookEvent[] = ["UserPromptSubmit", "PermissionRequest", "PreToolUse", "Stop"];
  const present = events.filter((ev) => hasJmuxHook(hooks[ev]));
  if (present.length === 0) return "none";
  if (present.length === events.length) return "current";
  return "partial";
}

function stripLegacyStop(entries: HookEntry[]): HookEntry[] {
  return entries
    .map((e) => ({
      ...e,
      hooks: e.hooks.filter((h) => !isLegacyHookCommand(h.command)),
    }))
    .filter((e) => e.hooks.length > 0);
}

function stripJmuxEntries(entries: HookEntry[] | undefined): HookEntry[] {
  if (!entries) return [];
  return entries
    .map((e) => ({
      ...e,
      hooks: e.hooks.filter(
        (h) => !isJmuxHookCommand(h.command) && !isLegacyHookCommand(h.command),
      ),
    }))
    .filter((e) => e.hooks.length > 0);
}

export function installHooks(settings: ClaudeSettings): InstallOutcome {
  const detected = detectInstalledKind(settings);
  if (detected === "current") return { kind: "noop", settings };

  // Deep-clone so callers can compare structurally.
  const next: ClaudeSettings = JSON.parse(JSON.stringify(settings));
  next.hooks ??= {};

  // For each managed event, strip any prior jmux/legacy entries and prepend
  // the canonical one. Preserves unrelated user entries.
  const block = buildHookBlock();
  for (const event of Object.keys(block) as HookEvent[]) {
    const existing = stripJmuxEntries(next.hooks![event] as HookEntry[] | undefined);
    next.hooks![event] = [...block[event], ...existing];
  }

  // Stop hook may have carried the legacy command alongside others; strip.
  if (Array.isArray(next.hooks!.Stop)) {
    next.hooks!.Stop = stripLegacyStop(next.hooks!.Stop as HookEntry[]);
    // The block's Stop entry will still be in there; verify and re-prepend
    // if it got stripped because both legacy and new shared an entry slot.
    if (!hasJmuxHook(next.hooks!.Stop)) {
      next.hooks!.Stop = [block.Stop[0], ...next.hooks!.Stop];
    }
  }

  return {
    kind: detected === "legacy" ? "migrated" : "installed",
    settings: next,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
bun test src/__tests__/hook-installer.test.ts
```

Expected: all pass. If any fail, fix the implementation — do **not** loosen the tests.

- [ ] **Step 5: Rewire main.ts to use the new module**

In `src/main.ts`, add a static import near the top with the other imports:

```ts
import { installHooks, type ClaudeSettings } from "./hook-installer";
```

Then replace the body of `installAgentHooks` (lines 135–186):

```ts
function installAgentHooks(): void {
  const claudeDir = resolve(homedir(), ".claude");
  const settingsPath = resolve(claudeDir, "settings.json");

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error("Error: could not parse ~/.claude/settings.json");
      process.exit(1);
    }
  }

  const outcome = installHooks(settings);

  if (outcome.kind === "noop") {
    console.log("jmux agent hooks are already installed.");
    return;
  }

  writeFileSync(settingsPath, JSON.stringify(outcome.settings, null, 2) + "\n");

  if (outcome.kind === "migrated") {
    console.log("Migrated jmux Stop hook to the new agent-state hooks");
    console.log("(UserPromptSubmit, PermissionRequest, PreToolUse, Stop).");
    console.log("Restart Claude Code in any open session to pick them up.");
  } else {
    console.log("Installed jmux agent hooks in ~/.claude/settings.json");
    console.log("");
    console.log("Your jmux sidebar will now show RUNNING / WAITING / COMPLETE");
    console.log("for each Claude Code session.");
  }
}
```

- [ ] **Step 6: Run the full test suite and typecheck**

```
bun test
bun run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```
git add src/hook-installer.ts src/__tests__/hook-installer.test.ts src/main.ts
git commit -m "feat(hooks): four-hook block + legacy migration via hook-installer"
```

---

## Task 8: session-view exposes agentState and the new row-1 timer

**Files:**

- Modify: `src/session-view.ts`
- Modify: `src/__tests__/session-view.test.ts`

- [ ] **Step 1: Survey the existing `SessionView` and `buildSessionView`**

```
grep -n "interface SessionView\|export function buildSessionView" src/session-view.ts
```

Reread lines 11–35 and 49–120 to confirm the current shape.

- [ ] **Step 2: Write the failing tests**

Append to `src/__tests__/session-view.test.ts`:

```ts
import type { AgentState, AgentStateRecord } from "../types";

function makeAgentStateRecord(overrides: Partial<AgentStateRecord> = {}): AgentStateRecord {
  return {
    state: "running",
    since: Date.now() - 8_000,
    ...overrides,
  };
}

describe("buildSessionView — agent state", () => {
  test("populates agentState and agentStateSince when present", () => {
    const since = Date.now() - 5_000;
    const view = buildSessionView(
      makeSession(),
      undefined,
      undefined,
      new Set(),
      { state: "running", since },
    );
    expect(view.agentState).toBe("running");
    expect(view.agentStateSince).toBe(since);
  });

  test("agentState is null when no record passed", () => {
    const view = buildSessionView(makeSession(), undefined, undefined, new Set());
    expect(view.agentState).toBeNull();
    expect(view.agentStateSince).toBeNull();
  });
});

describe("buildSessionView — row-1 timer fallback", () => {
  // The timer text lives in view.timerText. The fallback chain is:
  //   1. cache countdown (cacheTimer > 0)
  //   2. promoted session (agentState present) → elapsed since agentStateSince
  //   3. non-promoted with prior OTEL data → elapsed since latest OTEL event
  //   4. blank

  test("cache countdown wins over agentState elapsed", () => {
    const otel = makeSessionOtelState();
    otel.lastRequestTime = Date.now() - 60_000; // 240s remaining on 300s cache
    const view = buildSessionView(
      makeSession(),
      undefined,
      otel,
      new Set(),
      { state: "running", since: Date.now() - 8_000 },
    );
    expect(view.timerText).toMatch(/^[0-9]:[0-5][0-9]$/); // M:SS
    expect(view.timerRemaining).toBeGreaterThan(0);
  });

  test("promoted session, cache expired → elapsed from agentStateSince", () => {
    const otel = makeSessionOtelState();
    otel.lastRequestTime = Date.now() - 10 * 60 * 1000; // cache long-expired
    otel.lastUserPromptTime = Date.now() - 10 * 60 * 1000;
    const since = Date.now() - 90_000; // 1m30s in current state
    const view = buildSessionView(
      makeSession(),
      undefined,
      otel,
      new Set(),
      { state: "waiting", since },
    );
    expect(view.timerText).toBe("1m");        // formatted to coarse buckets
    expect(view.timerRemaining).toBe(0);
  });

  test("non-promoted session with OTEL data → elapsed from latest OTEL event", () => {
    const otel = makeSessionOtelState();
    otel.lastRequestTime = Date.now() - 10 * 60 * 1000;
    otel.lastUserPromptTime = Date.now() - 45_000;
    const view = buildSessionView(makeSession(), undefined, otel, new Set());
    expect(view.timerText).toBe("45s");
  });

  test("non-promoted session with no OTEL data → blank timer", () => {
    const view = buildSessionView(makeSession(), undefined, undefined, new Set());
    expect(view.timerText).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```
bun test src/__tests__/session-view.test.ts
```

Expected: FAIL — `buildSessionView` doesn't accept a fifth argument, fields don't exist.

- [ ] **Step 4: Extend `SessionView` and `buildSessionView`**

Edit `src/session-view.ts`. Extend the interface:

```ts
export interface SessionView {
  sessionId: string;
  sessionName: string;

  hasActivity: boolean;
  hasAttention: boolean;
  indicatorKind: IndicatorKind;

  modeBadge: ModeBadge;

  linearId: string | null;

  branch: string | null;

  timerText: string | null;
  timerRemaining: number;

  mrId: string | null;
  pipelineState: string | null;

  // NEW: agent state from AgentStateTracker, plumbed through for renderer.
  agentState: import("./types").AgentState | null;
  agentStateSince: number | null;
}
```

Add a small helper near `formatTimer`:

```ts
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}
```

Change `buildSessionView`'s signature:

```ts
export function buildSessionView(
  session: SessionInfo,
  ctx: SessionContext | undefined,
  timerState: SessionOtelState | undefined,
  activitySet: Set<string>,
  agentStateRecord: import("./types").AgentStateRecord | null = null,
): SessionView {
```

Replace the existing timer block:

```ts
// Timer
let timerText: string | null = null;
let timerRemaining = 0;
if (timerState && timerState.lastRequestTime > 0) {
  const elapsed = Math.floor((Date.now() - timerState.lastRequestTime) / 1000);
  timerRemaining = Math.max(0, CACHE_TIMER_TTL - elapsed);
  timerText = formatTimer(timerRemaining);
}
```

with:

```ts
// Row-1 unified timer fallback chain (see spec section "Row 1 unified timer"):
//   1) cache countdown while alive
//   2) promoted session → elapsed since agentStateSince
//   3) non-promoted with OTEL data → elapsed since latest OTEL event
//   4) blank
let timerText: string | null = null;
let timerRemaining = 0;
const now = Date.now();
if (timerState && timerState.lastRequestTime > 0) {
  const elapsedS = Math.floor((now - timerState.lastRequestTime) / 1000);
  timerRemaining = Math.max(0, CACHE_TIMER_TTL - elapsedS);
  if (timerRemaining > 0) {
    timerText = formatTimer(timerRemaining);
  }
}
if (timerText === null) {
  if (agentStateRecord) {
    timerText = formatElapsed(now - agentStateRecord.since);
  } else if (timerState) {
    const candidates = [
      timerState.lastRequestTime,
      timerState.lastUserPromptTime ?? 0,
      timerState.lastTool?.timestamp ?? 0,
    ].filter((t) => t > 0);
    if (candidates.length > 0) {
      timerText = formatElapsed(now - Math.max(...candidates));
    }
  }
}
```

In the return value, add:

```ts
agentState: agentStateRecord?.state ?? null,
agentStateSince: agentStateRecord?.since ?? null,
```

- [ ] **Step 5: Run tests to verify they pass**

```
bun test src/__tests__/session-view.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```
git add src/session-view.ts src/__tests__/session-view.test.ts
git commit -m "feat(session-view): agentState fields + unified row-1 timer fallback"
```

---

## Task 9: row-2 layout includes the state label

**Files:**

- Modify: `src/session-view.ts` (rework `buildSessionRow3`)
- Modify: `src/__tests__/session-view.test.ts`

- [ ] **Step 1: Survey the existing row-2 builder**

```
grep -n "buildSessionRow3\|drop priority" src/session-view.ts
```

Reread lines 144–212 of `src/session-view.ts`.

- [ ] **Step 2: Write the failing tests**

Append to `src/__tests__/session-view.test.ts`:

```ts
import type { AgentState } from "../types";

function rowWithState(state: AgentState, width: number, otelOverrides: Partial<SessionOtelState> = {}): string {
  const otel = makeSessionOtelState();
  otel.costUsd = 0.42;
  otel.lastTool = { name: "Edit", durationMs: 2_100, success: true, timestamp: Date.now() };
  Object.assign(otel, otelOverrides);
  return buildSessionRow3(otel, width, state);
}

describe("buildSessionRow3 — state label", () => {
  test("wide width (26) — cost + tool + state, state on right", () => {
    const text = rowWithState("running", 26);
    expect(text).toContain("$0.42");
    expect(text).toContain("Edit 2.1s");
    expect(text.trimEnd().endsWith("RUNNING")).toBe(true);
  });

  test("narrower width — drop tool first, keep cost + state", () => {
    const text = rowWithState("waiting", 18);
    expect(text).toContain("$0.42");
    expect(text).not.toContain("Edit 2.1s");
    expect(text.trimEnd().endsWith("WAITING")).toBe(true);
  });

  test("very narrow — drop cost, state stays", () => {
    const text = rowWithState("complete", 10);
    expect(text).not.toContain("$0.42");
    expect(text).not.toContain("Edit 2.1s");
    expect(text.trimEnd().endsWith("COMPLETE")).toBe(true);
  });

  test("no state passed — today's behavior preserved (cost/tool/idle)", () => {
    const otel = makeSessionOtelState();
    otel.costUsd = 0.42;
    otel.lastUserPromptTime = Date.now() - 60_000;
    const text = buildSessionRow3(otel, 26, null);
    expect(text).toContain("$0.42");
    expect(text).toMatch(/idle/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```
bun test src/__tests__/session-view.test.ts
```

Expected: FAIL — `buildSessionRow3` takes two args, not three; doesn't return state.

- [ ] **Step 4: Rework `buildSessionRow3`**

In `src/session-view.ts`, change the signature and body:

```ts
const STATE_LABEL: Record<import("./types").AgentState, string> = {
  running: "RUNNING",
  waiting: "WAITING",
  complete: "COMPLETE",
};

export function buildSessionRow3(
  state: SessionOtelState,
  width: number,
  agentState: import("./types").AgentState | null,
): string {
  const costText = state.costUsd > 0 ? `$${state.costUsd.toFixed(2)}` : null;
  const toolText = state.lastTool
    ? `${state.lastTool.name} ${formatToolDuration(state.lastTool.durationMs)}`
    : null;
  const idleText = state.lastUserPromptTime !== null
    ? formatIdle(Date.now() - state.lastUserPromptTime)
    : null;

  const usable = Math.max(0, width);

  // Promoted session: state label is the right-side anchor. Drop priority:
  // tool → cost; state stays. Idle is replaced by the row-1 unified timer
  // and never appears here for promoted sessions.
  if (agentState !== null) {
    const stateText = STATE_LABEL[agentState];
    const leftCandidates: Array<Array<{ text: string; align: "left" | "right" }>> = [];
    if (costText && toolText) {
      leftCandidates.push([
        { text: costText, align: "left" },
        { text: toolText, align: "left" },
        { text: stateText, align: "right" },
      ]);
    }
    if (costText) {
      leftCandidates.push([
        { text: costText, align: "left" },
        { text: stateText, align: "right" },
      ]);
    }
    leftCandidates.push([{ text: stateText, align: "right" }]);

    for (const fields of leftCandidates) {
      const totalLen = fields.reduce((s, f) => s + f.text.length, 0)
        + Math.max(0, fields.length - 1) * ROW3_GAP.length;
      if (totalLen <= usable) return layoutRow3(fields, usable);
    }
    return stateText.slice(0, usable);
  }

  // Non-promoted: keep existing cost/tool/idle behavior unchanged.
  const candidates: Array<Array<{ text: string; align: "left" | "right" }>> = [];
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
  if (idleText) candidates.push([{ text: idleText, align: "right" }]);

  for (const fields of candidates) {
    const totalLen = fields.reduce((s, f) => s + f.text.length, 0)
      + Math.max(0, fields.length - 1) * ROW3_GAP.length;
    if (totalLen <= usable) {
      return layoutRow3(fields, usable);
    }
  }
  if (costText) return costText.slice(0, usable);
  return "";
}
```

- [ ] **Step 5: Update the one existing call site in the sidebar (placeholder)**

Search:

```
grep -n "buildSessionRow3" src/sidebar.ts src/session-view.ts src/__tests__
```

In `src/sidebar.ts`, find the call to `buildSessionRow3(otel, this.width - 3)` and change it to `buildSessionRow3(otel, this.width - 3, null)` for now. Task 10 will wire the real agent state through.

- [ ] **Step 6: Run tests to verify they pass**

```
bun test src/__tests__/session-view.test.ts src/__tests__/sidebar.test.ts
```

Expected: all pass. If existing sidebar tests fail on the `null` placeholder, the test was probably asserting on a string returned by `buildSessionRow3` — adjust the test to pass `null` and verify it stays green.

- [ ] **Step 7: Commit**

```
git add src/session-view.ts src/sidebar.ts src/__tests__/session-view.test.ts
git commit -m "feat(session-view): row-2 state label with drop priority (tool→cost→state stays)"
```

---

## Task 10: Sidebar renders col-1 state glyph and row-2 state label

**Files:**

- Modify: `src/sidebar.ts`
- Modify: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Survey existing indicator rendering**

```
grep -n "indicatorKind\|switch (view.indicatorKind" src/sidebar.ts
```

Reread lines 27–50 (attrs) and 622–637 (indicator switch) of `src/sidebar.ts`.

- [ ] **Step 2: Write the failing tests**

Open `src/__tests__/sidebar.test.ts` and find the existing render-plan / indicator tests. Append a new describe block at the end:

```ts
describe("Sidebar — agent state rendering", () => {
  test("col-1 glyph for running is ⏵ in green", () => {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      attention: false, windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setAgentStateRecord("$1", { state: "running", since: Date.now() });
    const grid = sb.getGrid();
    // The col-1 indicator lives at row 2 (header rows 0+1 are the jmux title).
    const cell = grid.cells[2][1];
    expect(cell.char).toBe("⏵");                 // ⏵
    expect(cell.fg).toBe(2);                          // palette green
  });

  test("col-1 glyph for waiting is ! orange bold", () => {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      attention: false, windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setAgentStateRecord("$1", { state: "waiting", since: Date.now() });
    const grid = sb.getGrid();
    const cell = grid.cells[2][1];
    expect(cell.char).toBe("!");
    expect(cell.fg).toBe(3);                          // palette orange
    expect(cell.bold).toBe(true);
  });

  test("col-1 glyph for complete is ✓ dim blue", () => {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      attention: false, windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setAgentStateRecord("$1", { state: "complete", since: Date.now() });
    const grid = sb.getGrid();
    const cell = grid.cells[2][1];
    expect(cell.char).toBe("✓");                 // ✓
    expect(cell.fg).toBe(4);                          // palette blue
    expect(cell.dim).toBe(true);
  });

  test("indicator priority: error > mcp-down > agent-state > activity", () => {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      attention: false, windowCount: 1,
    };
    sb.updateSessions([session]);
    // Set agent state AND failed MCP — mcp-down should win.
    sb.setAgentStateRecord("$1", { state: "running", since: Date.now() });
    const otel = makeSessionOtelState();
    otel.failedMcpServers = new Set(["server-a"]);
    sb.setSessionOtelState("$1", otel);
    const grid = sb.getGrid();
    expect(grid.cells[2][1].char).toBe("⊘");     // ⊘ mcp-down
  });
});
```

Add the missing imports at the top of the file:

```ts
import type { SessionInfo } from "../types";
import { makeSessionOtelState } from "../types";
```

(These are present in the file already for most existing tests — only add what is missing.)

- [ ] **Step 3: Run tests to verify they fail**

```
bun test src/__tests__/sidebar.test.ts
```

Expected: FAIL — `setAgentStateRecord` not a method; col-1 glyph still `!` (legacy attention).

- [ ] **Step 4: Extend `Sidebar` and the col-1 indicator**

Edit `src/sidebar.ts`.

Near the other `*_ATTRS` constants, add:

```ts
const AGENT_STATE_RUNNING_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
};
const AGENT_STATE_WAITING_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
  bold: true,
};
const AGENT_STATE_COMPLETE_ATTRS: CellAttrs = {
  fg: 4,
  fgMode: ColorMode.Palette,
  dim: true,
};
```

Add a private agent-state map and a setter on the class:

```ts
private agentStateRecords = new Map<string, import("./types").AgentStateRecord>();

setAgentStateRecord(sessionId: string, record: import("./types").AgentStateRecord | null): void {
  if (record === null) this.agentStateRecords.delete(sessionId);
  else this.agentStateRecords.set(sessionId, record);
}
```

Extend `updateSessions` to prune the new map too:

```ts
updateSessions(sessions: SessionInfo[]): void {
  this.sessions = sessions;
  const activeIds = new Set(sessions.map((s) => s.id));
  for (const id of this.otelStates.keys()) {
    if (!activeIds.has(id)) this.otelStates.delete(id);
  }
  for (const id of this.agentStateRecords.keys()) {
    if (!activeIds.has(id)) this.agentStateRecords.delete(id);
  }
  this.rebuildPlan();
}
```

In `renderSession`, the indicator switch currently keys on `view.indicatorKind` which only knows `error`/`mcp-down`/`attention`/`activity`. Update `session-view.ts`'s `IndicatorKind` and `buildSessionView` to compute the new priority:

In `src/session-view.ts`:

```ts
export type IndicatorKind =
  | "error"
  | "mcp-down"
  | "agent-running"
  | "agent-waiting"
  | "agent-complete"
  | "activity"
  | null;
```

Replace the indicator-priority block in `buildSessionView` with:

```ts
// Col-1 indicator priority: error > mcp-down > agent-state > activity.
let indicatorKind: IndicatorKind = null;
if (timerState?.lastError) indicatorKind = "error";
else if ((timerState?.failedMcpServers.size ?? 0) > 0) indicatorKind = "mcp-down";
else if (agentStateRecord?.state === "running") indicatorKind = "agent-running";
else if (agentStateRecord?.state === "waiting") indicatorKind = "agent-waiting";
else if (agentStateRecord?.state === "complete") indicatorKind = "agent-complete";
else if (activitySet.has(session.id)) indicatorKind = "activity";
```

In `src/sidebar.ts`'s `renderSession`, extend the switch:

```ts
switch (view.indicatorKind) {
  case "error":
    writeString(grid, nameRow, 1, "⨯", ERROR_ATTRS);
    break;
  case "mcp-down":
    writeString(grid, nameRow, 1, "⊘", MCP_DOWN_ATTRS);
    break;
  case "agent-running":
    writeString(grid, nameRow, 1, "⏵", AGENT_STATE_RUNNING_ATTRS);
    break;
  case "agent-waiting":
    writeString(grid, nameRow, 1, "!", AGENT_STATE_WAITING_ATTRS);
    break;
  case "agent-complete":
    writeString(grid, nameRow, 1, "✓", AGENT_STATE_COMPLETE_ATTRS);
    break;
  case "activity":
    writeString(grid, nameRow, 1, "●", ACTIVITY_ATTRS);
    break;
}
```

Remove the `case "attention":` branch entirely. The `attention` IndicatorKind is no longer produced.

In `renderSession`, where `view` is built, pass the agent state through:

```ts
const ctx = this.sessionContexts.get(session.name);
const timerState = this.cacheTimersEnabled ? this.otelStates.get(session.id) ?? undefined : undefined;
const agentStateRecord = this.agentStateRecords.get(session.id) ?? null;
const view = buildSessionView(session, ctx, timerState, this.activitySet, agentStateRecord);
```

And at the row-2 call site (the `buildSessionRow3` call introduced as a placeholder in Task 9 Step 5):

```ts
const text = buildSessionRow3(otel, this.width - 3, agentStateRecord?.state ?? null);
```

Pick attrs for the row-2 state label so the label color matches the glyph color. In `renderSession`, after the `text` is written, find the agent-state segment in the rendered string and re-paint with the right attrs. The simplest way: write the body in dim attrs first (existing behavior), then if `agentStateRecord` is present, find the label substring and overwrite those cells with the state-specific attrs:

```ts
if (text.length > 0) {
  const row3Attrs: CellAttrs = isActive
    ? ACTIVE_DETAIL_ATTRS
    : isHovered
      ? HOVER_DETAIL_ATTRS
      : DIM_ATTRS;
  writeString(grid, row3, 3, text, row3Attrs);

  if (agentStateRecord) {
    const labelByState: Record<import("./types").AgentState, { text: string; attrs: CellAttrs }> = {
      running:  { text: "RUNNING",  attrs: AGENT_STATE_RUNNING_ATTRS },
      waiting:  { text: "WAITING",  attrs: AGENT_STATE_WAITING_ATTRS },
      complete: { text: "COMPLETE", attrs: AGENT_STATE_COMPLETE_ATTRS },
    };
    const { text: labelText, attrs: labelAttrs } = labelByState[agentStateRecord.state];
    const idx = text.lastIndexOf(labelText);
    if (idx >= 0) {
      const col = 3 + idx;
      writeString(grid, row3, col, labelText, {
        ...labelAttrs,
        // Preserve any background painted by paintRowChrome.
        ...(isActive ? { bg: ACTIVE_BG, bgMode: ColorMode.RGB } : {}),
        ...(isHovered ? { bg: HOVER_BG, bgMode: ColorMode.RGB } : {}),
      });
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
bun test src/__tests__/sidebar.test.ts src/__tests__/session-view.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```
git add src/sidebar.ts src/session-view.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): col-1 state glyph + row-2 state label"
```

---

## Task 11: main.ts wires everything together

**Files:**

- Modify: `src/main.ts`
- Modify: `src/cli/session.ts`

**This task is large — break it into the substeps below and commit at the end. There are no new unit tests; main.ts is the integration glue and is exercised end-to-end by the smoke test in Task 12.**

- [ ] **Step 1: Add an `AgentStateTracker` instance**

In `src/main.ts`, near where `sidebar` and `otelReceiver` are constructed, add the import at the top of the file with the other imports:

```ts
import { AgentStateTracker, coerceStaleAgentState } from "./agent-state";
```

And then construct the tracker:

```ts
const agentStateTracker = new AgentStateTracker();
agentStateTracker.onChange((sessionId) => {
  sidebar.setAgentStateRecord(sessionId, agentStateTracker.getRecord(sessionId));
  scheduleRender();
});
```

- [ ] **Step 2: Replace the `@jmux-attention` subscription with two new subscriptions**

Search for the existing block (around line 3589):

```ts
// Subscribe to @jmux-attention across all sessions
await control.registerSubscription(
  "attention",
  1,
  "#{S:#{session_id}=#{@jmux-attention} }",
);
```

Replace with:

```ts
// Subscribe to per-session agent-state user options. The format string
// produces a space-separated list of "<session_id>=<value>" pairs.
await control.registerSubscription(
  "agent-state",
  1,
  "#{S:#{session_id}=#{@jmux-agent-state} }",
);
await control.registerSubscription(
  "agent-state-since",
  1,
  "#{S:#{session_id}=#{@jmux-agent-state-since} }",
);
```

- [ ] **Step 3: Handle the new subscription change events**

Find the `subscription-changed` case (around line 3287). Replace:

```ts
if (event.name === "attention") {
  fetchSessions();
} else if (event.name === "windows") {
  fetchWindows();
}
```

with:

```ts
if (event.name === "agent-state" || event.name === "agent-state-since") {
  fetchAgentState();
} else if (event.name === "windows") {
  fetchWindows();
}
```

Add `fetchAgentState` near the other `fetch*` helpers:

```ts
async function fetchAgentState(): Promise<void> {
  const result = await control.sendCommand(
    "list-sessions -F '#{session_id}:#{@jmux-agent-state}:#{@jmux-agent-state-since}'",
  );
  const activeIds: string[] = [];
  for (const line of result) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon1 = trimmed.indexOf(":");
    const colon2 = trimmed.indexOf(":", colon1 + 1);
    if (colon1 < 0 || colon2 < 0) continue;
    const id = trimmed.slice(0, colon1);
    const rawState = trimmed.slice(colon1 + 1, colon2);
    const rawSince = trimmed.slice(colon2 + 1);
    activeIds.push(id);
    agentStateTracker.apply(id, rawState || null, rawSince || null);
  }
  agentStateTracker.pruneExcept(activeIds);
}
```

Call `fetchAgentState()` once during startup (look for where the other initial fetches happen):

```ts
await fetchAgentState();
```

- [ ] **Step 4: Drop attention from the session-list query (or unset it)**

Find the listing in `main.ts` around line 858. The format string currently includes `#{@jmux-attention}`. Remove that field and drop the `attention` field from `SessionInfo` parsing if it was being plumbed in — or, if `SessionInfo.attention` still has consumers, leave the field but parse it as always `false`. The cleanest move:

- Remove `#{@jmux-attention}` from the format string.
- Remove the parse of the attention column from `parseSessionLine` / the equivalent.
- Drop `attention: boolean` from `SessionInfo` — and update all consumers (`hasAttention` returns false unconditionally and is removed if unused).

Run:

```
grep -n "attention\b" src/types.ts src/sidebar.ts src/session-view.ts src/cli/session.ts
```

…and remove each remaining reference. (Several were already touched in Task 10 when the `attention` IndicatorKind branch was deleted.)

- [ ] **Step 5: Wire the OTEL resume callback**

Find where `OtelReceiver` is constructed (search `new OtelReceiver`). Pass the resume callback:

```ts
const otelReceiver = new OtelReceiver({
  onAgentResumeHint: (sessionName) => {
    const id = sessionIdByName(sessionName);
    if (!id) return;
    if (agentStateTracker.getState(id) !== "waiting") return;
    void runner.run(["set-option", "-t", id, "@jmux-agent-state", "running"]);
    void runner.run([
      "set-option",
      "-t",
      id,
      "@jmux-agent-state-since",
      String(Math.floor(Date.now() / 1000)),
    ]);
  },
});
```

`sessionIdByName` is the existing helper that resolves a session name to its `$N` id (look around the session-details cache for the lookup).

- [ ] **Step 6: Remove the legacy attention codepaths**

In `clearSessionIndicators` (around line 1107), remove the entire `if (needsAttentionClear)` block and its dependent variable:

```ts
function clearSessionIndicators(): void {
  if (!currentSessionId) return;
  const id = currentSessionId;
  if (!sidebar.hasActivity(id)) return;
  lastViewedTimestamps.set(id, Math.floor(Date.now() / 1000));
  sidebar.setActivity(id, false);
  scheduleRender();
}
```

`Sidebar.hasAttention` can be left in place if any other caller uses it; the renderer no longer does. (Search confirms it.)

- [ ] **Step 7: One-shot legacy cleanup at startup**

After `fetchAgentState()`, add:

```ts
// Unset any stale @jmux-attention flags from previous jmux versions.
// Fire-and-forget; per-session failures are harmless.
const sessionIds = currentSessions.map((s) => s.id);
for (const id of sessionIds) {
  void control.sendCommand(`set-option -t ${tq(id)} -u @jmux-attention`).catch(() => {});
}
```

Use the same `tq` quoting helper that the rest of `main.ts` uses.

- [ ] **Step 8: Update `src/cli/session.ts`**

Find the format strings (lines 57, 98, 189–192) and:

- Drop `#{@jmux-attention}` from the format string.
- Remove the field from the JSON output if it was being surfaced. The ctl API is documented in `skills/jmux-control.md`; if attention is documented there, also remove it from the docs.

- [ ] **Step 9: Snapshot wiring — capture**

Find the call site where `snapshotter.onAttention(name, attention)` is invoked (search `onAttention(`). Adjacent to it, when agent state changes for a session, call:

```ts
const record = agentStateTracker.getRecord(sessionId);
const snapState = record
  ? { state: record.state, since: new Date(record.since).toISOString() }
  : null;
snapshotter?.onAgentState(sessionName, snapState);
```

Wire this off the `agentStateTracker.onChange` handler from Step 1 — extend the existing handler:

```ts
agentStateTracker.onChange((sessionId) => {
  const record = agentStateTracker.getRecord(sessionId);
  sidebar.setAgentStateRecord(sessionId, record);
  const sessionName = sessionNameById(sessionId);
  if (sessionName) {
    const snapState = record
      ? { state: record.state, since: new Date(record.since).toISOString() }
      : null;
    snapshotter?.onAgentState(sessionName, snapState);
  }
  scheduleRender();
});
```

- [ ] **Step 10: Snapshot wiring — restore**

Find the `attentionSink` definition (line 438) and add an `agentStateSink` alongside it:

```ts
agentStateSink: (name, agentState) => {
  if (!agentState) return;
  // Apply 10-min stale coercion before writing back to tmux.
  const TEN_MIN_MS = 10 * 60 * 1000;
  const coerced = coerceStaleAgentState(
    agentState,
    eligibility.snapshot.capturedAt,
    Date.now(),
    TEN_MIN_MS,
  );
  if (!coerced) return;
  const sinceEpoch = Math.floor(Date.parse(coerced.since) / 1000);
  void runner.run(["set-option", "-t", name, "@jmux-agent-state", coerced.state]);
  void runner.run(["set-option", "-t", name, "@jmux-agent-state-since", String(sinceEpoch)]);
},
```

(If `eligibility` is not in scope at the sink definition, refactor so `capturedAt` is captured via closure — or inline the snapshot reference the same way `permissionModeSink` accesses its surrounding state.)

- [ ] **Step 11: Run the full test suite and typecheck**

```
bun test
bun run typecheck
```

Expected: all pass. Investigate and fix any regressions before commit.

- [ ] **Step 12: Commit**

```
git add src/main.ts src/cli/session.ts skills/jmux-control.md
git commit -m "feat(main): wire AgentStateTracker, OTEL resume, legacy attention removal"
```

---

## Task 12: Manual smoke test and final verification

**Files:** none.

- [ ] **Step 1: Run the full test suite, typecheck, and coverage gate**

```
bun test
bun run typecheck
bun test --coverage src/agent-state.ts src/__tests__/agent-state.test.ts
```

Expected: all green; `src/agent-state.ts` line coverage ≥ 95%.

- [ ] **Step 2: Build + run the clean-env docker sanity check**

```
bun run docker
```

Expected: container starts, jmux launches without errors. Exit with `Ctrl-D` once the sidebar renders.

- [ ] **Step 3: Manual end-to-end walkthrough**

In a real jmux session:

1. Back up your existing `~/.claude/settings.json`.
2. Run `bun run dev` to launch the new jmux from source in a separate tmux outside the current session (or use `--socket` to isolate).
3. Open a Claude Code session inside the new jmux.
4. Run `bun run src/main.ts --install-agent-hooks`. Verify the migration message if you had legacy hooks; otherwise the install message.
5. Restart Claude Code in the session.
6. Send a prompt. Sidebar should flip the col-1 glyph to ⏵ (green) and show `RUNNING` on row 2.
7. Trigger a permission prompt (e.g. ask Claude to run a bash command that requires approval). Sidebar should flip to `!` (orange bold) + `WAITING`.
8. Answer the prompt. Sidebar should flip back to `RUNNING` within a couple of seconds (the OTEL safety-net fires on the next `api_request` or `tool_result`).
9. Wait for the response to finish. Sidebar should flip to ✓ (dim blue) + `COMPLETE`.
10. Restart jmux (Ctrl-D). On relaunch, the state should still be `COMPLETE` (tmux user options survive).

Restore your backup of `~/.claude/settings.json` afterwards if desired.

- [ ] **Step 4: Final commit**

If any minor adjustments were needed during the smoke test, fix them and commit:

```
git add -p
git commit -m "fix(agent-state): smoke-test follow-up tweaks"
```

If no changes were needed, no commit. Document the smoke-test outcome in the PR description rather than the codebase.

---

## Spec self-review (planner)

Walking the spec section-by-section against this plan:

- **Summary / Goals** — task set produces all three states visibly per session, hooks-driven, 3 rows, snapshot-restorable. ✓
- **Decisions: state source = hooks** — Task 7 installs the four hooks. ✓
- **Decisions: storage = tmux user options** — Task 11 Steps 2–3 subscribe; Task 11 Step 10 restores. ✓
- **Decisions: resuming from WAITING** — Task 7 installs PreToolUse (idempotent); Task 6 emits `onAgentResumeHint`; Task 11 Step 5 owns the tmux write. ✓
- **Decisions: 3-row display, retain existing info** — Tasks 8–10. ✓
- **State model + transitions + initial state + stale coercion** — Task 1 (tracker), Task 2 (`coerceStaleAgentState`). ✓
- **Snapshot schema additive + nullable + no version bump** — Task 3. ✓
- **MigrationRegistry out of scope** — confirmed by not touching it. ✓
- **Hook installer behavior** — Task 7 covers `none → install`, `legacy → migrate`, `current → noop`, `partial → install`, unrelated entries preserved. ✓
- **Subscription / list-sessions format changes** — Task 11 Steps 2–4 (main.ts), Step 8 (cli/session.ts). ✓
- **Legacy @jmux-attention cleanup** — Task 11 Steps 6–7. ✓
- **OTEL safety-net seam (callback, no tmux dep in OtelReceiver)** — Task 6 + Task 11 Step 5. ✓
- **Sidebar layout + col-1 priority + row-2 state label + row-1 timer fallback** — Tasks 8–10. ✓
- **Snapshot capture + restore wiring + 10-min stale coercion** — Tasks 4, 5, 11 Steps 9–10. ✓
- **Tests: agent-state.test.ts** — Tasks 1, 2. ✓
- **Tests: sidebar.test.ts extensions** — Task 10. ✓
- **Tests: session-view.test.ts extensions** — Tasks 8, 9. ✓
- **Tests: hook-installer.test.ts** — Task 7. ✓
- **Coverage gate extension to src/agent-state.ts** — Task 12 Step 1. ✓
- **Manual smoke test** — Task 12 Step 3. ✓
- **Rollout / migration message** — Task 7 Step 5 (`Migrated jmux Stop hook...`). ✓

No gaps identified.
