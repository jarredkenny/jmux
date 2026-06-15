# Pane of Glass — Foundation (pin state, reconciler, CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, fully-unit-tested foundation for pane-level pinning — the internal-session helper, the per-pane `@jmux-pinned` reflection tracker, the pure reconciler/restore-planner, the persisted home-record schema, and the `jmux ctl pane pin/unpin/pinned` CLI — with **no tmux side effects wired yet**.

**Architecture:** Mirrors the existing `AgentStateTracker` pattern (pure logic module + listener) and the `buildAttentionCommands` CLI pattern (pure command builders + thin handler). Writers (CLI/TUI) only set/unset the per-pane tmux option `@jmux-pinned`; a pure reconciler computes break/join/discard *decisions* from observed state. The actual break-pane/join-pane execution and multi-client rendering land in the follow-up runtime plan. This plan ends with every new module green under `bun test` and `bun run typecheck`.

**Tech Stack:** TypeScript (strict), Bun 1.3.8+ test runner (`bun:test`), tmux 3.6a (target runtime; not invoked by these unit tests).

**Companion spec:** `docs/superpowers/specs/2026-06-15-pane-of-glass-pane-pinning-design.md` (commit a3c84c8).

**Out of scope (deferred to the runtime plan):** the `__jmux_glass`/`__jmux_park` session creation, multi-`TmuxPty` tile compositing, tile chrome, input routing, the Overview sidebar entry + layout math, the `@jmux-pinned` control-channel subscription wiring, view persistence, and ADR/CONTEXT doc revisions.

---

## File Structure

**New files:**
- `src/glass/types.ts` — shared types: `PinnedPaneRecord`, `PaneLocation`, `RestorePlan`, `ReconcileAction`.
- `src/glass/internal-sessions.ts` — `INTERNAL_SESSION_PREFIX`, name builders, `isInternalSession`, `INTERNAL_SESSION_FILTER`.
- `src/glass/pinned-pane-tracker.ts` — `PinnedPaneTracker` (desired-membership reflection).
- `src/glass/reconciler.ts` — `reconcilePins` and `planRestore` (pure decision functions).
- `src/__tests__/glass/internal-sessions.test.ts`
- `src/__tests__/glass/pinned-pane-tracker.test.ts`
- `src/__tests__/glass/reconciler.test.ts`
- `src/__tests__/cli/pane-pin.test.ts`

**Modified files:**
- `src/config.ts` — add `pinnedPanes?: PinnedPaneRecord[]` to `JmuxConfig`; reject the internal prefix in `sanitizeTmuxSessionName`.
- `src/cli/pane.ts` — add `pin` / `unpin` / `pinned` subcommands + pure builders/parsers.
- Every `list-sessions` seam surfaced by the Task 2 inventory — add the internal-session filter / predicate.

---

## Task 0: Inventory the list-sessions seams (pre-flight)

This task writes no code. It produces the authoritative seam list that Task 2 consumes, per the spec's "enumerate from `rg`, not a fixed count" rule.

- [ ] **Step 1: Run the fresh inventory**

Run:
```bash
rg -n "list-sessions" src --glob '!src/__tests__/**'
```

- [ ] **Step 2: Record the result in the plan's working notes**

For each hit, note in your task tracker: file:line, the enclosing function, and whether it already filters to a specific session name (e.g. `-f '#{==:#{session_name},NAME}'`). At time of writing the expected hits are:

- `src/main.ts` `fetchSessions` (sidebar) — surfaces internal sessions, **needs filter**
- `src/main.ts` `fetchAgentState` — surfaces internal sessions, **needs filter**
- `src/cli/status.ts` `handleStatus` (`STATUS_FORMAT`) — **needs filter**
- `src/cli/session.ts` `list` (line ~107) — **needs filter**
- `src/cli/session.ts` two name-scoped lookups (lines ~129, ~148) — already filter by name, **audit only**
- `src/cli/session.ts` last-session guard (line ~207) — counts sessions, **needs filter** (internal sessions must not count)
- `src/cli/agent.ts` `handleAgent` (`AGENT_FORMAT`) — **needs filter**
- `src/cli/issue.ts` (`ISSUE_LINK_FORMAT`) — **needs filter**
- `src/snapshot/capture.ts` `onSessionsChanged` (line ~124) — **needs filter**
- `src/snapshot/capture.ts` `scrollbackTick` (line ~220) — **needs filter**
- `src/snapshot/restore.ts` (line ~130) — **audit**: restore re-creates sessions from a snapshot file; internal sessions are never snapshotted (Task 2 guarantees they're never captured), so this seam needs no live filter, but confirm.

Treat the live `rg` output as truth if it diverges from this list.

---

## Task 1: Internal-session helper module

**Files:**
- Create: `src/glass/types.ts`
- Create: `src/glass/internal-sessions.ts`
- Test: `src/__tests__/glass/internal-sessions.test.ts`

- [ ] **Step 1: Create the shared types file**

Create `src/glass/types.ts`:

```typescript
/** Where a pane physically lives (tmux ids, stable for the server lifetime). */
export interface PaneLocation {
  sessionId: string;
  windowId: string;
}

/**
 * Durable home-restore record for a checked-out (pinned) pane. Persisted to
 * config.json so a pane can always be returned home, even across a jmux
 * restart while the tmux server is alive. IDs are authoritative; names are
 * UI-only and may go stale.
 */
export interface PinnedPaneRecord {
  paneId: string;
  homeSessionId: string;
  homeWindowId: string;
  homeLayout: string;
  displaySessionName?: string;
  displayWindowName?: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/__tests__/glass/internal-sessions.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import {
  INTERNAL_SESSION_PREFIX,
  INTERNAL_SESSION_FILTER,
  GLASS_HOLDING_SESSION,
  PARK_SESSION,
  tileSessionName,
  isInternalSession,
} from "../../glass/internal-sessions";

describe("isInternalSession", () => {
  test("true for the reserved prefix", () => {
    expect(isInternalSession("__jmux_glass")).toBe(true);
    expect(isInternalSession("__jmux_park")).toBe(true);
    expect(isInternalSession("__jmux_tile_3")).toBe(true);
  });

  test("false for ordinary session names", () => {
    expect(isInternalSession("api")).toBe(false);
    expect(isInternalSession("TRA-123")).toBe(false);
    expect(isInternalSession("_jmux_almost")).toBe(false);
  });
});

describe("internal session names", () => {
  test("constants use the reserved prefix", () => {
    expect(GLASS_HOLDING_SESSION.startsWith(INTERNAL_SESSION_PREFIX)).toBe(true);
    expect(PARK_SESSION.startsWith(INTERNAL_SESSION_PREFIX)).toBe(true);
  });

  test("tileSessionName strips the % from a pane id and is internal", () => {
    const name = tileSessionName("%7");
    expect(name).toBe("__jmux_tile_7");
    expect(isInternalSession(name)).toBe(true);
  });
});

describe("INTERNAL_SESSION_FILTER", () => {
  test("is the documented tmux 3.6a conditional form (no #{!:})", () => {
    expect(INTERNAL_SESSION_FILTER).toBe(
      "#{?#{m:__jmux_*,#{session_name}},0,1}",
    );
    expect(INTERNAL_SESSION_FILTER).not.toContain("#{!:");
  });
});
```

- [ ] **Step 2b: Run it to verify it fails**

Run: `bun test src/__tests__/glass/internal-sessions.test.ts`
Expected: FAIL — `Cannot find module '../../glass/internal-sessions'`.

- [ ] **Step 3: Implement the module**

Create `src/glass/internal-sessions.ts`:

```typescript
/**
 * jmux-internal tmux sessions (the pane-of-glass holding session, the parked
 * main-client scratch session, and the per-tile group-member sessions) all
 * share this reserved name prefix so a single predicate can hide them from the
 * sidebar, the snapshotter, and every `jmux ctl` reader.
 */
export const INTERNAL_SESSION_PREFIX = "__jmux_";

/** The single hidden holding session pinned panes are broken out into. */
export const GLASS_HOLDING_SESSION = `${INTERNAL_SESSION_PREFIX}glass`;

/** Scratch session the main interactive client parks on while the glass is up. */
export const PARK_SESSION = `${INTERNAL_SESSION_PREFIX}park`;

/** Per-tile session-group member name for a given pane id (e.g. "%7" → "__jmux_tile_7"). */
export function tileSessionName(paneId: string): string {
  return `${INTERNAL_SESSION_PREFIX}tile_${paneId.replace(/^%/, "")}`;
}

/** True when a session name belongs to jmux's internal set and must be hidden. */
export function isInternalSession(name: string): boolean {
  return name.startsWith(INTERNAL_SESSION_PREFIX);
}

/**
 * tmux `-f` filter for `list-sessions` that drops internal sessions at the
 * source. `-f` keeps rows whose format evaluates to a non-zero, non-empty
 * value; this conditional yields "0" for a name matching `__jmux_*` (skipped)
 * and "1" otherwise (kept). Uses only operators documented in the tmux 3.6a
 * manual — there is NO `#{!:}` logical-NOT operator.
 */
export const INTERNAL_SESSION_FILTER = "#{?#{m:__jmux_*,#{session_name}},0,1}";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/__tests__/glass/internal-sessions.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/glass/types.ts src/glass/internal-sessions.ts src/__tests__/glass/internal-sessions.test.ts
git commit -m "feat(glass): internal-session helper + shared types"
```

---

## Task 2: Apply the internal-session filter at every seam

**Files (driven by Task 0 inventory):**
- Modify: `src/config.ts` (`sanitizeTmuxSessionName`)
- Modify: `src/main.ts` (`fetchSessions`, `fetchAgentState`)
- Modify: `src/cli/status.ts`, `src/cli/session.ts`, `src/cli/agent.ts`, `src/cli/issue.ts`
- Modify: `src/snapshot/capture.ts` (`onSessionsChanged`, `scrollbackTick`)
- Test: `src/__tests__/glass/internal-sessions.test.ts` (extend), and existing test suites must stay green.

The contract: every `list-sessions` call that can surface internal sessions gains
`-f INTERNAL_SESSION_FILTER`; the `sanitizeTmuxSessionName` mutation rejects the
reserved prefix so a user can never create a colliding session.

- [ ] **Step 1: Write the failing test for prefix rejection**

Add to `src/__tests__/glass/internal-sessions.test.ts`:

```typescript
import { sanitizeTmuxSessionName } from "../../config";

describe("sanitizeTmuxSessionName rejects the reserved prefix", () => {
  test("a user name colliding with the internal prefix is defanged", () => {
    // Must not remain a name that isInternalSession() would treat as internal.
    expect(isInternalSession(sanitizeTmuxSessionName("__jmux_glass"))).toBe(false);
    expect(isInternalSession(sanitizeTmuxSessionName("__jmux_evil"))).toBe(false);
  });

  test("ordinary names are unaffected apart from existing . : rules", () => {
    expect(sanitizeTmuxSessionName("api")).toBe("api");
    expect(sanitizeTmuxSessionName("a.b:c")).toBe("a_b_c");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/glass/internal-sessions.test.ts -t "reserved prefix"`
Expected: FAIL — the current `sanitizeTmuxSessionName` leaves `__jmux_glass` intact, so `isInternalSession(...)` returns `true`.

- [ ] **Step 3: Implement prefix rejection in `sanitizeTmuxSessionName`**

In `src/config.ts`, replace the body of `sanitizeTmuxSessionName` (currently lines 49-51):

```typescript
export function sanitizeTmuxSessionName(name: string): string {
  const cleaned = name.replace(/[.:]/g, "_");
  // Reserve the jmux-internal prefix so user sessions can never collide with
  // the pane-of-glass holding/park/tile sessions. Strip a leading underscore
  // run down to one so "__jmux_glass" → "_jmux_glass" (no longer internal).
  if (cleaned.startsWith("__jmux_")) {
    return cleaned.replace(/^_+/, "_");
  }
  return cleaned;
}
```

(Importing `isInternalSession`/`INTERNAL_SESSION_PREFIX` into config.ts would create a glass→config→glass cycle; keep the literal here and rely on the test to keep them in agreement.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/__tests__/glass/internal-sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `-f` filter to each live list-sessions seam**

For each seam in the Task 0 inventory marked **needs filter**, add `-f INTERNAL_SESSION_FILTER` to the `list-sessions` argument list, importing the constant from `../glass/internal-sessions` (CLI files) or `./glass/internal-sessions` (main.ts/snapshot).

`src/main.ts` `fetchSessions` (control-channel string form) — change:

```typescript
"list-sessions -F '#{session_id}:#{session_name}:#{session_activity}:#{session_attached}:#{session_windows}'",
```
to:
```typescript
`list-sessions -f "${INTERNAL_SESSION_FILTER}" -F '#{session_id}:#{session_name}:#{session_activity}:#{session_attached}:#{session_windows}'`,
```

`src/main.ts` `fetchAgentState` — apply the same `-f "${INTERNAL_SESSION_FILTER}"` insertion to its `list-sessions` string.

`src/cli/status.ts` `handleStatus` (array form):
```typescript
const result = runTmuxDirect(
  ["list-sessions", "-f", INTERNAL_SESSION_FILTER, "-F", STATUS_FORMAT],
  ctx.socket,
);
```

`src/cli/session.ts` `list`, `src/cli/agent.ts`, `src/cli/issue.ts`, and the
`src/snapshot/capture.ts` `onSessionsChanged` + `scrollbackTick` array-form
calls — insert `"-f", INTERNAL_SESSION_FILTER` immediately after `"list-sessions"`.

`src/cli/session.ts` last-session guard (line ~207) — add the filter so internal
sessions never inflate the count:
```typescript
const listResult = runTmuxDirect(
  ["list-sessions", "-f", INTERNAL_SESSION_FILTER, "-F", "#{session_name}"],
  ctx.socket,
);
```

The two name-scoped lookups in `session.ts` (`-f '#{==:#{session_name},NAME}'`)
and `snapshot/restore.ts` need **no change** (a user can't name a session into
the reserved prefix, and restore only re-creates snapshotted sessions). Note this
in your tracker as "audited, no change".

- [ ] **Step 6: Verify nothing regressed**

Run: `bun test && bun run typecheck`
Expected: PASS. (No new unit test asserts the live `-f` wiring — it's an
integration concern verified in the runtime plan's smoke test — but the existing
suites and typecheck must stay green.)

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/main.ts src/cli/status.ts src/cli/session.ts src/cli/agent.ts src/cli/issue.ts src/snapshot/capture.ts src/__tests__/glass/internal-sessions.test.ts
git commit -m "feat(glass): hide internal sessions at every list-sessions seam"
```

---

## Task 3: Persisted home-record config schema

**Files:**
- Modify: `src/config.ts` (`JmuxConfig`)
- Test: `src/__tests__/config.test.ts` (extend; mirrors its existing tmpdir round-trip pattern)

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/config.test.ts` (it already imports `bun:test` with `beforeEach`/`afterEach` and writes a temp `config.json` at `cfgPath`):

```typescript
import type { PinnedPaneRecord } from "../glass/types";

test("round-trips pinnedPanes home records", () => {
  const records: PinnedPaneRecord[] = [
    {
      paneId: "%7",
      homeSessionId: "$2",
      homeWindowId: "@5",
      homeLayout: "bb62,159x48,0,0,3",
      displaySessionName: "api",
      displayWindowName: "tests",
    },
  ];
  const store = new ConfigStore(cfgPath);
  store.set("pinnedPanes", records);

  const reloaded = new ConfigStore(cfgPath);
  expect(reloaded.config.pinnedPanes).toEqual(records);
});
```

(If `config.test.ts` doesn't already import `ConfigStore`, add it to the existing import from `"../config"`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/config.test.ts -t "pinnedPanes"`
Expected: FAIL — `pinnedPanes` is not a key of `JmuxConfig` (typecheck error in the test) / value is `undefined`.

- [ ] **Step 3: Add the field**

In `src/config.ts`, add the import at the top with the other type imports:

```typescript
import type { PinnedPaneRecord } from "./glass/types";
```

And add the field to `JmuxConfig` (after `pinnedSessions?: string[];`):

```typescript
  /** Home-restore records for panes broken out into the glass holding session. */
  pinnedPanes?: PinnedPaneRecord[];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/__tests__/config.test.ts -t "pinnedPanes"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat(glass): persist pinned-pane home records in config"
```

---

## Task 4: PinnedPaneTracker (desired-membership reflection)

Mirrors `AgentStateTracker`: a thin wrapper over a `Set<paneId>` with a listener, fed raw `@jmux-pinned` values. It owns **only desired membership** — never physical checkout.

**Files:**
- Create: `src/glass/pinned-pane-tracker.ts`
- Test: `src/__tests__/glass/pinned-pane-tracker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/pinned-pane-tracker.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { PinnedPaneTracker } from "../../glass/pinned-pane-tracker";

describe("PinnedPaneTracker", () => {
  test("apply('1') adds the pane and fires onChange", () => {
    const t = new PinnedPaneTracker();
    let fired = 0;
    t.onChange(() => fired++);
    t.apply("%1", "1");
    expect(t.has("%1")).toBe(true);
    expect(fired).toBe(1);
  });

  test("apply with an unset/empty value removes the pane", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "1");
    t.apply("%1", "");
    expect(t.has("%1")).toBe(false);
  });

  test("does NOT fire on an idempotent re-apply", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "1");
    let fired = 0;
    t.onChange(() => fired++);
    t.apply("%1", "1");
    expect(fired).toBe(0);
  });

  test("all() returns the pinned pane ids; size reflects membership", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "1");
    t.apply("%2", "1");
    expect(new Set(t.all())).toEqual(new Set(["%1", "%2"]));
    expect(t.size).toBe(2);
  });

  test("pruneExcept drops panes no longer present, firing once on change", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "1");
    t.apply("%2", "1");
    let fired = 0;
    t.onChange(() => fired++);
    t.pruneExcept(["%1"]);
    expect(t.has("%1")).toBe(true);
    expect(t.has("%2")).toBe(false);
    expect(fired).toBe(1);
  });

  test("pruneExcept is silent when nothing changes", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "1");
    let fired = 0;
    t.onChange(() => fired++);
    t.pruneExcept(["%1", "%9"]);
    expect(fired).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/glass/pinned-pane-tracker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tracker**

Create `src/glass/pinned-pane-tracker.ts`:

```typescript
type ChangeListener = (paneId: string) => void;

/**
 * Tracks the set of panes the user/agents have marked as desired glass members
 * via the per-pane tmux option `@jmux-pinned`. This is *desired membership* only
 * — it never breaks or joins panes. tmux is the source of truth; this mirrors
 * what the control channel reports. Mirrors AgentStateTracker's shape.
 */
export class PinnedPaneTracker {
  private pinned = new Set<string>();
  private listeners: ChangeListener[] = [];

  get size(): number {
    return this.pinned.size;
  }

  has(paneId: string): boolean {
    return this.pinned.has(paneId);
  }

  all(): string[] {
    return [...this.pinned];
  }

  onChange(fn: ChangeListener): void {
    this.listeners.push(fn);
  }

  /**
   * Reflect a raw `@jmux-pinned` value for a pane. "1" → pinned; anything else
   * (empty / unset) → not pinned. Only emits when membership actually changes.
   */
  apply(paneId: string, rawPinned: string | null): void {
    const want = rawPinned === "1";
    const have = this.pinned.has(paneId);
    if (want === have) return;
    if (want) this.pinned.add(paneId);
    else this.pinned.delete(paneId);
    this.emit(paneId);
  }

  /** Drop any tracked pane not in `activeIds` (e.g. its process exited). */
  pruneExcept(activeIds: string[]): void {
    const active = new Set(activeIds);
    let changed: string | null = null;
    for (const id of [...this.pinned]) {
      if (!active.has(id)) {
        this.pinned.delete(id);
        changed = id;
      }
    }
    if (changed !== null) this.emit(changed);
  }

  private emit(paneId: string): void {
    for (const fn of this.listeners) fn(paneId);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/__tests__/glass/pinned-pane-tracker.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/glass/pinned-pane-tracker.ts src/__tests__/glass/pinned-pane-tracker.test.ts
git commit -m "feat(glass): PinnedPaneTracker desired-membership reflection"
```

---

## Task 5: The pure reconciler (`reconcilePins`)

Given observed state — desired-pinned set, persisted home records, and the live
location of every pane — compute the break/join/discard *decisions*. Pure
function, no tmux. This is the crash-recovery and steady-state core.

**Files:**
- Modify: `src/glass/types.ts` (add `ReconcileAction`, `ReconcileInput`)
- Create: `src/glass/reconciler.ts`
- Test: `src/__tests__/glass/reconciler.test.ts`

- [ ] **Step 1: Add the action/input types**

Append to `src/glass/types.ts`:

```typescript
/** Inputs to the pure pin reconciler — all observed, no tmux calls. */
export interface ReconcileInput {
  /** Pane ids whose `@jmux-pinned` option is currently set. */
  desired: ReadonlySet<string>;
  /** Persisted home records, keyed by paneId. */
  records: ReadonlyMap<string, PinnedPaneRecord>;
  /** Current location of every live pane, keyed by paneId. */
  live: ReadonlyMap<string, PaneLocation>;
  /** session_id of the glass holding session, or null if it doesn't exist yet. */
  holdingSessionId: string | null;
}

/** A decision the reconciler emits; the executor performs the tmux side effect. */
export type ReconcileAction =
  /** Break a live, home, desired pane out into the holding session. */
  | { type: "checkout"; paneId: string; home: PaneLocation }
  /** Join a checked-out, no-longer-desired pane back home. */
  | { type: "restore"; record: PinnedPaneRecord }
  /** Drop a stale record (pane died, or is already home). */
  | { type: "discardRecord"; paneId: string };
```

- [ ] **Step 2: Write the failing test**

Create `src/__tests__/glass/reconciler.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { reconcilePins } from "../../glass/reconciler";
import type {
  ReconcileInput,
  PinnedPaneRecord,
  PaneLocation,
} from "../../glass/types";

const HOLDING = "$glass";

function loc(sessionId: string, windowId: string): PaneLocation {
  return { sessionId, windowId };
}

function rec(paneId: string, over: Partial<PinnedPaneRecord> = {}): PinnedPaneRecord {
  return {
    paneId,
    homeSessionId: "$2",
    homeWindowId: "@5",
    homeLayout: "layoutstr",
    ...over,
  };
}

function input(over: Partial<ReconcileInput>): ReconcileInput {
  return {
    desired: new Set(),
    records: new Map(),
    live: new Map(),
    holdingSessionId: HOLDING,
    ...over,
  };
}

describe("reconcilePins", () => {
  test("desired + live + home + no record → checkout with home location", () => {
    const actions = reconcilePins(
      input({
        desired: new Set(["%1"]),
        live: new Map([["%1", loc("$2", "@5")]]),
      }),
    );
    expect(actions).toEqual([
      { type: "checkout", paneId: "%1", home: { sessionId: "$2", windowId: "@5" } },
    ]);
  });

  test("desired + already in holding → no action (steady state)", () => {
    const actions = reconcilePins(
      input({
        desired: new Set(["%1"]),
        records: new Map([["%1", rec("%1")]]),
        live: new Map([["%1", loc(HOLDING, "@99")]]),
      }),
    );
    expect(actions).toEqual([]);
  });

  test("crash between record and break: desired, record exists, pane still home → re-checkout", () => {
    const actions = reconcilePins(
      input({
        desired: new Set(["%1"]),
        records: new Map([["%1", rec("%1", { homeSessionId: "$2", homeWindowId: "@5" })]]),
        live: new Map([["%1", loc("$2", "@5")]]),
      }),
    );
    expect(actions).toEqual([
      { type: "checkout", paneId: "%1", home: { sessionId: "$2", windowId: "@5" } },
    ]);
  });

  test("checked out but no longer desired → restore home", () => {
    const r = rec("%1");
    const actions = reconcilePins(
      input({
        desired: new Set(),
        records: new Map([["%1", r]]),
        live: new Map([["%1", loc(HOLDING, "@99")]]),
      }),
    );
    expect(actions).toEqual([{ type: "restore", record: r }]);
  });

  test("desired pane no longer live (process exited) → discard its record", () => {
    const actions = reconcilePins(
      input({
        desired: new Set(["%1"]),
        records: new Map([["%1", rec("%1")]]),
        live: new Map(),
      }),
    );
    expect(actions).toEqual([{ type: "discardRecord", paneId: "%1" }]);
  });

  test("record for a no-longer-desired, no-longer-live pane → discard", () => {
    const actions = reconcilePins(
      input({
        records: new Map([["%1", rec("%1")]]),
        live: new Map(),
      }),
    );
    expect(actions).toEqual([{ type: "discardRecord", paneId: "%1" }]);
  });

  test("record for a no-longer-desired pane already back home → discard record", () => {
    const actions = reconcilePins(
      input({
        records: new Map([["%1", rec("%1")]]),
        live: new Map([["%1", loc("$2", "@5")]]),
      }),
    );
    expect(actions).toEqual([{ type: "discardRecord", paneId: "%1" }]);
  });

  test("holdingSessionId null: cannot check out yet, emits nothing for fresh pins", () => {
    const actions = reconcilePins(
      input({
        desired: new Set(["%1"]),
        live: new Map([["%1", loc("$2", "@5")]]),
        holdingSessionId: null,
      }),
    );
    expect(actions).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test src/__tests__/glass/reconciler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `reconcilePins`**

Create `src/glass/reconciler.ts`:

```typescript
import type { ReconcileAction, ReconcileInput } from "./types";

/**
 * Pure pin reconciler. Compares desired membership (`@jmux-pinned`) against the
 * physical world (persisted records + live pane locations) and returns the
 * minimal set of break/join/discard decisions. The same function serves
 * steady-state, agent-initiated pins, and startup crash recovery.
 *
 * A pane is "checked out" when its live location is the holding session.
 */
export function reconcilePins(input: ReconcileInput): ReconcileAction[] {
  const { desired, records, live, holdingSessionId } = input;
  const actions: ReconcileAction[] = [];

  const isCheckedOut = (paneId: string): boolean =>
    holdingSessionId !== null && live.get(paneId)?.sessionId === holdingSessionId;

  // 1. Drive desired panes toward being checked out.
  for (const paneId of desired) {
    const here = live.get(paneId);
    if (!here) {
      // Desired but the pane is gone (e.g. its process exited). Drop any record;
      // PinnedPaneTracker.pruneExcept clears it from `desired` separately.
      if (records.has(paneId)) actions.push({ type: "discardRecord", paneId });
      continue;
    }
    if (isCheckedOut(paneId)) continue; // already in glass-land — steady state
    if (holdingSessionId === null) continue; // no holding session yet; cannot break out
    // Live and home (or anywhere non-holding) but desired → break it out.
    actions.push({ type: "checkout", paneId, home: here });
  }

  // 2. Resolve records whose pane is no longer desired.
  for (const [paneId, record] of records) {
    if (desired.has(paneId)) continue; // handled above
    if (isCheckedOut(paneId)) {
      actions.push({ type: "restore", record }); // unpinned → bring home
    } else {
      // Pane is gone, or already back home — nothing to join; just drop the record.
      actions.push({ type: "discardRecord", paneId });
    }
  }

  return actions;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/__tests__/glass/reconciler.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 6: Commit**

```bash
git add src/glass/types.ts src/glass/reconciler.ts src/__tests__/glass/reconciler.test.ts
git commit -m "feat(glass): pure pin reconciler"
```

---

## Task 6: Restore-target planner (`planRestore`)

The three unpin home-gone branches from the spec, as a pure function the executor consults when performing a `restore` action.

**Files:**
- Modify: `src/glass/types.ts` (add `RestorePlan`)
- Modify: `src/glass/reconciler.ts` (add `planRestore`)
- Test: `src/__tests__/glass/reconciler.test.ts` (extend)

- [ ] **Step 1: Add the `RestorePlan` type**

Append to `src/glass/types.ts`:

```typescript
/** How to bring a checked-out pane home, given what still exists in tmux. */
export type RestorePlan =
  /** Home window still exists: join back and re-apply the saved layout. */
  | { mode: "rejoinWindow"; windowId: string; layout: string }
  /** Home window gone but session alive: join as a new window in that session. */
  | { mode: "newWindowInSession"; sessionId: string }
  /** Home session gone: promote the holding window into its own new session. */
  | { mode: "newSession" };
```

- [ ] **Step 2: Write the failing test**

Append to `src/__tests__/glass/reconciler.test.ts`:

```typescript
import { planRestore } from "../../glass/reconciler";

describe("planRestore", () => {
  const record = rec("%1", {
    homeSessionId: "$2",
    homeWindowId: "@5",
    homeLayout: "savedlayout",
  });

  test("home window alive → rejoin + layout", () => {
    const plan = planRestore(record, new Set(["@5", "@6"]), new Set(["$2"]));
    expect(plan).toEqual({ mode: "rejoinWindow", windowId: "@5", layout: "savedlayout" });
  });

  test("home window gone, session alive → new window in session", () => {
    const plan = planRestore(record, new Set(["@6"]), new Set(["$2"]));
    expect(plan).toEqual({ mode: "newWindowInSession", sessionId: "$2" });
  });

  test("home session gone → new session (never kill the process)", () => {
    const plan = planRestore(record, new Set(["@6"]), new Set(["$9"]));
    expect(plan).toEqual({ mode: "newSession" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test src/__tests__/glass/reconciler.test.ts -t "planRestore"`
Expected: FAIL — `planRestore` is not exported.

- [ ] **Step 4: Implement `planRestore`**

Append to `src/glass/reconciler.ts`:

```typescript
import type { PinnedPaneRecord, RestorePlan } from "./types";

/**
 * Decide how to bring a checked-out pane home. Encodes the spec's three
 * branches; never destroys the pane's process.
 */
export function planRestore(
  record: PinnedPaneRecord,
  liveWindowIds: ReadonlySet<string>,
  liveSessionIds: ReadonlySet<string>,
): RestorePlan {
  if (liveWindowIds.has(record.homeWindowId)) {
    return { mode: "rejoinWindow", windowId: record.homeWindowId, layout: record.homeLayout };
  }
  if (liveSessionIds.has(record.homeSessionId)) {
    return { mode: "newWindowInSession", sessionId: record.homeSessionId };
  }
  return { mode: "newSession" };
}
```

(Adjust the existing `import type { ReconcileAction, ReconcileInput } from "./types";`
line at the top of `reconciler.ts` to also import `PinnedPaneRecord` and
`RestorePlan`, or add the second import line shown above — either is fine under
strict mode.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/__tests__/glass/reconciler.test.ts`
Expected: PASS (all reconciler + planRestore cases).

- [ ] **Step 6: Commit**

```bash
git add src/glass/types.ts src/glass/reconciler.ts src/__tests__/glass/reconciler.test.ts
git commit -m "feat(glass): restore-target planner for unpin home-gone branches"
```

---

## Task 7: `jmux ctl pane pin / unpin / pinned`

Writers only set/unset the per-pane option — **no break/join here**. Mirrors the
`buildAttentionCommands` pure-builder pattern so the command shape is unit-tested.

**Files:**
- Modify: `src/cli/pane.ts`
- Test: `src/__tests__/cli/pane-pin.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/cli/pane-pin.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { buildPinCommands, parsePinnedListOutput } from "../../cli/pane";

describe("buildPinCommands", () => {
  test("pin sets the per-pane @jmux-pinned option", () => {
    expect(buildPinCommands("pin", "%7")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "@jmux-pinned", "1"], required: true },
    ]);
  });

  test("unpin unsets the per-pane option with -u", () => {
    expect(buildPinCommands("unpin", "%7")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "-u", "@jmux-pinned"], required: true },
    ]);
  });
});

describe("parsePinnedListOutput", () => {
  test("returns only pane ids whose value is exactly '1'", () => {
    const lines = ["%1:1", "%2:", "%3:1", "%4:0"];
    expect(parsePinnedListOutput(lines)).toEqual(["%1", "%3"]);
  });

  test("ignores blank lines", () => {
    expect(parsePinnedListOutput(["", "%9:1", ""])).toEqual(["%9"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/__tests__/cli/pane-pin.test.ts`
Expected: FAIL — `buildPinCommands` / `parsePinnedListOutput` not exported from `cli/pane`.

- [ ] **Step 3: Add the pure builders/parser to `src/cli/pane.ts`**

At the top of `src/cli/pane.ts`, alongside the existing `PANE_FORMAT` constant, add:

```typescript
const PINNED_LIST_FORMAT = "#{pane_id}:#{@jmux-pinned}";

export interface PaneOptionCommand {
  args: string[];
  required: boolean;
}

/**
 * Build the tmux command(s) to set/unset the per-pane `@jmux-pinned` option.
 * This is the *only* thing pin/unpin do — the running TUI reconciler observes
 * the option change and performs the break-pane/join-pane itself.
 */
export function buildPinCommands(
  verb: "pin" | "unpin",
  target: string,
): PaneOptionCommand[] {
  if (verb === "pin") {
    return [
      { args: ["set-option", "-p", "-t", target, "@jmux-pinned", "1"], required: true },
    ];
  }
  return [
    { args: ["set-option", "-p", "-t", target, "-u", "@jmux-pinned"], required: true },
  ];
}

/** Parse `list-panes -a -F '#{pane_id}:#{@jmux-pinned}'` into pinned pane ids. */
export function parsePinnedListOutput(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf(":");
    if (idx < 0) continue;
    const id = trimmed.slice(0, idx);
    const val = trimmed.slice(idx + 1);
    if (val === "1") out.push(id);
  }
  return out;
}
```

- [ ] **Step 4: Run the builder/parser test to verify it passes**

Run: `bun test src/__tests__/cli/pane-pin.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the subcommands into `handlePane`**

In `src/cli/pane.ts`, the existing `handlePane(ctx, parsed)` switch (around lines
41-160) imports `runTmuxDirect`, `tmuxOrThrow`, `requireSession`, and `CliError`
from the same places the other cases use. Add a small `resolveTarget` helper and
three cases. Add this near the top of `handlePane` body or above it:

```typescript
function resolvePaneTarget(ctx: CliContext, flags: ParsedCtlArgs["flags"]): string {
  if (typeof flags.target === "string" && flags.target) return flags.target;
  if (ctx.paneId) return ctx.paneId;
  throw new CliError("--target is required (or run inside the target pane)");
}
```

Then add these cases to the switch:

```typescript
    case "pin":
    case "unpin": {
      const target = resolvePaneTarget(ctx, flags);
      for (const cmd of buildPinCommands(action, target)) {
        const result = runTmuxDirect(cmd.args, ctx.socket);
        if (cmd.required) tmuxOrThrow(result);
      }
      return { target, pinned: action === "pin" };
    }

    case "pinned": {
      const lines = tmuxOrThrow(
        runTmuxDirect(["list-panes", "-a", "-F", PINNED_LIST_FORMAT], ctx.socket),
      );
      return { pinned: parsePinnedListOutput(lines) };
    }
```

Ensure `CliContext` and `ParsedCtlArgs` are imported at the top of the file (they
already are, since `handlePane(ctx: CliContext, parsed: ParsedCtlArgs)` is the
signature). If `CliError` isn't yet imported in `pane.ts`, add it:
`import { CliError, requireSession } from "./context";` (merge with the existing
context import).

- [ ] **Step 6: Verify the whole suite + types**

Run: `bun test && bun run typecheck`
Expected: PASS. The new pane subcommands dispatch through the existing
`handlePane` registration in `src/cli.ts` (the `case "pane"` branch) with no
change needed there — `pin`/`unpin`/`pinned` are actions within the `pane` group.

- [ ] **Step 7: Commit**

```bash
git add src/cli/pane.ts src/__tests__/cli/pane-pin.test.ts
git commit -m "feat(cli): jmux ctl pane pin/unpin/pinned (option set/unset only)"
```

---

## Final Verification

- [ ] **Step 1: Full unit suite**

Run: `bun test`
Expected: PASS — all existing suites plus the four new glass/cli suites.

- [ ] **Step 2: Strict typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual CLI smoke test (real tmux)**

This is the only step that touches a live tmux; it exercises the option-write
path end to end (no break/join yet — that's the runtime plan).

```bash
# Inside a jmux/tmux session:
bun run src/main.ts ctl pane pin              # pins the current pane
bun run src/main.ts ctl pane pinned           # → {"pinned":["%<current>"]}
tmux show-option -p @jmux-pinned              # → @jmux-pinned 1
bun run src/main.ts ctl pane unpin
bun run src/main.ts ctl pane pinned           # → {"pinned":[]}
```

Expected: pin writes `@jmux-pinned 1` on the pane; `pinned` lists it; unpin clears it.

- [ ] **Step 4: Confirm internal-session hiding doesn't break listing**

Run: `bun run src/main.ts ctl session list`
Expected: your real sessions appear; the JSON is well-formed (no `__jmux_*`
entries — there won't be any yet, but the `-f` filter must not error).

---

## Self-Review Notes (author)

- **Spec coverage:** internal-session filter (Tasks 1-2) ✓; desired-vs-physical split — desired membership lives in `PinnedPaneTracker` + `@jmux-pinned`, physical state in records + reconciler (Tasks 3-5) ✓; crash-safe ordering encoded as reconciler decisions incl. the "still-desired → re-checkout" case (Task 5) ✓; ID-based records (Task 1 `PinnedPaneRecord`) ✓; three unpin branches (Task 6 `planRestore`) ✓; CLI option-only writers (Task 7) ✓. **Deferred to runtime plan (intentionally):** rendering model, sidebar Overview/labels/markers, layout math, navigation, persistence, reflection subscription wiring, ADR/CONTEXT docs.
- **Type consistency:** `PinnedPaneRecord`, `PaneLocation`, `ReconcileAction`, `ReconcileInput`, `RestorePlan` all defined in `src/glass/types.ts` and imported by config/reconciler/tests under the same names. `buildPinCommands`/`parsePinnedListOutput`/`PaneOptionCommand` exported from `src/cli/pane.ts` and consumed by its test under the same names.
- **No placeholders:** every code step shows complete code; every run step shows the command + expected result.
