# Cache Expiry Countdown Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display a per-session countdown timer in the jmux sidebar showing time remaining before Claude's prompt cache expires, driven by Claude Code's native OpenTelemetry telemetry.

**Architecture:** A lightweight OTLP HTTP receiver (`Bun.serve`) consumes `api_request` log events from Claude Code, maps them to tmux sessions via resource attributes, and feeds timer state to the sidebar for rendering as a color-coded `m:ss` countdown on each session's detail row. Environment variables are injected as tmux globals so all sessions auto-export telemetry. A settings toggle in config.json controls whether timers render.

**Tech Stack:** Bun (runtime + HTTP server + test runner), TypeScript, tmux control protocol

---

## File Map

| File | Role |
|------|------|
| `src/otel-receiver.ts` | **New.** OTLP HTTP server + OTLP JSON parser + CacheTimerState map |
| `src/__tests__/otel-receiver.test.ts` | **New.** Tests for OTLP parsing, state management, pruning |
| `src/types.ts` | Add `CacheTimerState` interface |
| `src/sidebar.ts` | Add `setCacheTimer()`, `cacheTimersEnabled`, render countdown on detail row |
| `src/__tests__/sidebar.test.ts` | Add timer rendering tests |
| `src/main.ts` | Wire receiver lifecycle, env injection, render tick, settings toggle, pruning |

---

### Task 1: CacheTimerState type

**Files:**
- Modify: `src/types.ts:40-50`

- [ ] **Step 1: Add the CacheTimerState interface to types.ts**

Add after the `SessionInfo` interface (after line 50):

```typescript
export interface CacheTimerState {
  lastRequestTime: number;  // Date.now() when the api_request event was received
  cacheWasHit: boolean;     // cache_read_tokens > 0 on the last request
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no consumers yet)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add CacheTimerState type"
```

---

### Task 2: OTLP Receiver — tests first

**Files:**
- Create: `src/__tests__/otel-receiver.test.ts`

- [ ] **Step 1: Write tests for OTLP JSON parsing and state management**

Create `src/__tests__/otel-receiver.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { OtelReceiver } from "../otel-receiver";

// Minimal OTLP JSON payload matching the structure Claude Code exports
function makeOtlpPayload(opts: {
  sessionId?: string;
  eventName?: string;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): object {
  const {
    sessionId = "$0",
    eventName = "api_request",
    cacheReadTokens = 100,
    cacheCreationTokens = 0,
  } = opts;

  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "tmux_session_id", value: { stringValue: sessionId } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                attributes: [
                  { key: "event.name", value: { stringValue: eventName } },
                  { key: "cache_read_tokens", value: { intValue: String(cacheReadTokens) } },
                  { key: "cache_creation_tokens", value: { intValue: String(cacheCreationTokens) } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("OtelReceiver", () => {
  let receiver: OtelReceiver;

  beforeEach(() => {
    receiver = new OtelReceiver();
  });

  afterEach(() => {
    receiver.stop();
  });

  test("starts and returns a port", async () => {
    const port = await receiver.start();
    expect(port).toBeGreaterThan(0);
  });

  test("parses api_request event and updates timer state", async () => {
    const port = await receiver.start();
    const payload = makeOtlpPayload({ sessionId: "$1", cacheReadTokens: 50 });

    const resp = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(resp.status).toBe(200);

    const state = receiver.getTimerState("$1");
    expect(state).not.toBeNull();
    expect(state!.cacheWasHit).toBe(true);
    expect(state!.lastRequestTime).toBeGreaterThan(0);
  });

  test("cache miss when cache_read_tokens is 0", async () => {
    const port = await receiver.start();
    const payload = makeOtlpPayload({ sessionId: "$2", cacheReadTokens: 0, cacheCreationTokens: 500 });

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const state = receiver.getTimerState("$2");
    expect(state).not.toBeNull();
    expect(state!.cacheWasHit).toBe(false);
  });

  test("ignores non-api_request events", async () => {
    const port = await receiver.start();
    const payload = makeOtlpPayload({ sessionId: "$3", eventName: "tool_result" });

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(receiver.getTimerState("$3")).toBeNull();
  });

  test("ignores payloads without tmux_session_id", async () => {
    const port = await receiver.start();
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(Date.now() * 1_000_000),
                  attributes: [
                    { key: "event.name", value: { stringValue: "api_request" } },
                    { key: "cache_read_tokens", value: { intValue: "100" } },
                    { key: "cache_creation_tokens", value: { intValue: "0" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(receiver.getActiveSessionIds()).toEqual([]);
  });

  test("handles malformed JSON gracefully", async () => {
    const port = await receiver.start();
    const resp = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(resp.status).toBe(200);
    expect(receiver.getActiveSessionIds()).toEqual([]);
  });

  test("returns 200 for non-logs endpoints", async () => {
    const port = await receiver.start();
    const resp = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
      method: "POST",
      body: "{}",
    });
    expect(resp.status).toBe(200);
  });

  test("updates state on subsequent requests", async () => {
    const port = await receiver.start();

    // First request — cache miss
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionId: "$0", cacheReadTokens: 0 })),
    });
    const first = receiver.getTimerState("$0");
    expect(first!.cacheWasHit).toBe(false);
    const firstTime = first!.lastRequestTime;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 5));

    // Second request — cache hit
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionId: "$0", cacheReadTokens: 200 })),
    });
    const second = receiver.getTimerState("$0");
    expect(second!.cacheWasHit).toBe(true);
    expect(second!.lastRequestTime).toBeGreaterThanOrEqual(firstTime);
  });

  test("getActiveSessionIds returns sessions with state", async () => {
    const port = await receiver.start();

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionId: "$0" })),
    });
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionId: "$5" })),
    });

    const ids = receiver.getActiveSessionIds().sort();
    expect(ids).toEqual(["$0", "$5"]);
  });

  test("pruneExcept removes stale sessions", async () => {
    const port = await receiver.start();

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionId: "$0" })),
    });
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionId: "$5" })),
    });

    receiver.pruneExcept(["$0"]);
    expect(receiver.getTimerState("$0")).not.toBeNull();
    expect(receiver.getTimerState("$5")).toBeNull();
  });

  test("fires onUpdate callback when state changes", async () => {
    const port = await receiver.start();
    const updates: string[] = [];
    receiver.onUpdate = (id) => updates.push(id);

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionId: "$7" })),
    });

    expect(updates).toEqual(["$7"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: FAIL — `Cannot find module "../otel-receiver"`

- [ ] **Step 3: Commit test file**

```bash
git add src/__tests__/otel-receiver.test.ts
git commit -m "test: add OtelReceiver tests (red)"
```

---

### Task 3: OTLP Receiver — implementation

**Files:**
- Create: `src/otel-receiver.ts`

- [ ] **Step 1: Implement OtelReceiver**

Create `src/otel-receiver.ts`:

```typescript
import type { CacheTimerState } from "./types";

export class OtelReceiver {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private state = new Map<string, CacheTimerState>();
  onUpdate: ((sessionId: string) => void) | null = null;

  async start(): Promise<number> {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.handleRequest(req),
    });
    return this.server.port;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  getTimerState(sessionId: string): CacheTimerState | null {
    return this.state.get(sessionId) ?? null;
  }

  getActiveSessionIds(): string[] {
    return [...this.state.keys()];
  }

  pruneExcept(activeSessionIds: string[]): void {
    const active = new Set(activeSessionIds);
    for (const id of this.state.keys()) {
      if (!active.has(id)) this.state.delete(id);
    }
  }

  private handleRequest(req: Request): Response {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/logs") {
      // Process async, respond immediately
      req.json().then((body) => this.processLogs(body)).catch(() => {});
      return new Response("", { status: 200 });
    }
    return new Response("", { status: 200 });
  }

  private processLogs(body: any): void {
    const resourceLogs = body?.resourceLogs;
    if (!Array.isArray(resourceLogs)) return;

    for (const rl of resourceLogs) {
      const sessionId = this.extractResourceAttr(rl?.resource, "tmux_session_id");
      if (!sessionId) continue;

      const scopeLogs = rl?.scopeLogs;
      if (!Array.isArray(scopeLogs)) continue;

      for (const sl of scopeLogs) {
        const logRecords = sl?.logRecords;
        if (!Array.isArray(logRecords)) continue;

        for (const record of logRecords) {
          this.processRecord(record, sessionId);
        }
      }
    }
  }

  private processRecord(record: any, sessionId: string): void {
    const attrs = record?.attributes;
    if (!Array.isArray(attrs)) return;

    const eventName = this.findAttrString(attrs, "event.name");
    if (eventName !== "api_request") return;

    const cacheReadTokens = this.findAttrInt(attrs, "cache_read_tokens");
    const cacheWasHit = cacheReadTokens > 0;

    this.state.set(sessionId, {
      lastRequestTime: Date.now(),
      cacheWasHit,
    });

    this.onUpdate?.(sessionId);
  }

  private extractResourceAttr(resource: any, key: string): string | null {
    const attrs = resource?.attributes;
    if (!Array.isArray(attrs)) return null;
    return this.findAttrString(attrs, key);
  }

  private findAttrString(attrs: any[], key: string): string | null {
    for (const attr of attrs) {
      if (attr?.key === key) return attr?.value?.stringValue ?? null;
    }
    return null;
  }

  private findAttrInt(attrs: any[], key: string): number {
    for (const attr of attrs) {
      if (attr?.key === key) {
        const v = attr?.value?.intValue;
        return typeof v === "number" ? v : parseInt(v, 10) || 0;
      }
    }
    return 0;
  }
}
```

- [ ] **Step 2: Run the tests**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/otel-receiver.ts
git commit -m "feat: implement OtelReceiver for Claude Code telemetry"
```

---

### Task 4: Sidebar cache timer — tests first

**Files:**
- Modify: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Add cache timer rendering tests**

Add at the end of the `describe("Sidebar", ...)` block in `src/__tests__/sidebar.test.ts`, before the closing `});`:

```typescript
  test("renders cache timer on detail row when set", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main", directory: "~/mydir", gitBranch: "dev" }]),
    );
    // Set timer with 4 minutes remaining (60 seconds elapsed)
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Detail row is row 3 (row 2 = name, row 3 = detail)
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailText).toContain("4:0");
  });

  test("timer shows 0:00 when cache expired", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    // 6 minutes ago — expired
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 360_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailText).toContain("0:00");
  });

  test("no timer rendered when cache timer state is null", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main", directory: "~/mydir", gitBranch: "dev" }]),
    );
    // Don't set any timer
    const grid = sidebar.getGrid();
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailText).not.toMatch(/\d:\d\d/);
  });

  test("timer uses green color when > 180s remaining", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    // 30 seconds elapsed → 270s remaining (green)
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 30_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Find the timer text on detail row (row 3), check fg color
    const row = grid.cells[3];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].fg).toBe(2); // palette green
  });

  test("timer uses yellow color when 30-180s remaining", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    // 200 seconds elapsed → 100s remaining (yellow)
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 200_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    const row = grid.cells[3];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].fg).toBe(3); // palette yellow
  });

  test("timer uses red color when < 30s remaining", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    // 280 seconds elapsed → 20s remaining (red)
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 280_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    const row = grid.cells[3];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].fg).toBe(1); // palette red
  });

  test("timer uses dim when expired at 0:00", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 400_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    const row = grid.cells[3];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].dim).toBe(true);
  });

  test("timer truncates branch text when space is tight", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{
        name: "main",
        directory: "~/Code/work/api",
        gitBranch: "very-long-branch-name-here",
      }]),
    );
    // Two sessions needed for grouping
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api", gitBranch: "very-long-branch-name-here" },
        { name: "web", directory: "~/Code/work/web", gitBranch: "main" },
      ]),
    );
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Find api's detail row (row 2: header, row 3: spacer, row 4: api name, row 5: api detail)
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    // Branch should be truncated with ellipsis, timer should be present
    expect(detailText).toContain("\u2026");
    expect(detailText).toContain("4:0");
  });

  test("cacheTimersEnabled false suppresses timer rendering", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    sidebar.cacheTimersEnabled = false;
    const grid = sidebar.getGrid();
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailText).not.toMatch(/\d:\d\d/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: FAIL — `setCacheTimer is not a function` / `cacheTimersEnabled` not found

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/sidebar.test.ts
git commit -m "test: add sidebar cache timer tests (red)"
```

---

### Task 5: Sidebar cache timer — implementation

**Files:**
- Modify: `src/sidebar.ts:1-4` (imports)
- Modify: `src/sidebar.ts:182-196` (class fields)
- Modify: `src/sidebar.ts:433-537` (renderSession)

- [ ] **Step 1: Add import and timer constants to sidebar.ts**

Add `CacheTimerState` to the types import on line 1:

```typescript
import type { CellGrid, SessionInfo, CacheTimerState } from "./types";
```

Add timer color constants after the existing `GROUP_HEADER_ATTRS` block (after line 63):

```typescript
const CACHE_TIMER_TTL = 300; // 5 minutes in seconds

function cacheTimerAttrs(remaining: number, isActive: boolean, isHovered: boolean): CellAttrs {
  const base: CellAttrs = {};
  if (isActive) {
    base.bg = ACTIVE_BG;
    base.bgMode = ColorMode.RGB;
  } else if (isHovered) {
    base.bg = HOVER_BG;
    base.bgMode = ColorMode.RGB;
  }
  if (remaining <= 0) return { ...base, dim: true };
  if (remaining <= 29) return { ...base, fg: 1, fgMode: ColorMode.Palette };
  if (remaining <= 180) return { ...base, fg: 3, fgMode: ColorMode.Palette };
  return { ...base, fg: 2, fgMode: ColorMode.Palette };
}

function formatTimer(remaining: number): string {
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
```

- [ ] **Step 2: Add cache timer state fields to Sidebar class**

Add after the `latestVersion` field (after line 196):

```typescript
  private cacheTimers = new Map<string, CacheTimerState>();
  cacheTimersEnabled = true;
```

Add the `setCacheTimer` method after the `setVersion` method (after line 253):

```typescript
  setCacheTimer(sessionId: string, state: CacheTimerState | null): void {
    if (state) {
      this.cacheTimers.set(sessionId, state);
    } else {
      this.cacheTimers.delete(sessionId);
    }
  }
```

- [ ] **Step 3: Update renderSession to show timer on detail row**

In the `renderSession` method, replace the detail line section (the block starting with `// Detail line` around line 502) with logic that accounts for the timer.

Replace the entire detail line block (from `// Detail line` to the end of the method) with:

```typescript
    // Detail line
    const detailAttrs: CellAttrs = isActive
      ? ACTIVE_DETAIL_ATTRS
      : isHovered
        ? HOVER_DETAIL_ATTRS
        : DIM_ATTRS;

    // Cache timer (right-aligned on detail row)
    const timerState = this.cacheTimersEnabled ? this.cacheTimers.get(session.id) : undefined;
    let timerCols = 0;
    if (timerState) {
      const elapsed = Math.floor((Date.now() - timerState.lastRequestTime) / 1000);
      const remaining = Math.max(0, CACHE_TIMER_TTL - elapsed);
      const timerText = formatTimer(remaining);
      const timerCol = this.width - timerText.length - 1;
      const timerAttrs = cacheTimerAttrs(remaining, isActive, isHovered);
      if (timerCol > 3) {
        writeString(grid, detailRow, timerCol, timerText, timerAttrs);
        timerCols = timerText.length + 2; // text + gap + edge padding
      }
    }

    if (item.grouped) {
      if (session.gitBranch) {
        const detailStart = 3;
        const maxLen = this.width - detailStart - timerCols - 1;
        let branch = session.gitBranch;
        if (maxLen > 0 && branch.length > maxLen) {
          branch = branch.slice(0, maxLen - 1) + "\u2026";
        }
        if (maxLen > 0) {
          writeString(grid, detailRow, detailStart, branch, detailAttrs);
        }
      }
    } else {
      const detailStart = 3;
      if (session.directory !== undefined) {
        const dirMaxLen = this.width - detailStart - timerCols - 1;
        let displayDir = session.directory;
        if (dirMaxLen > 0 && displayDir.length > dirMaxLen) {
          displayDir = displayDir.slice(0, dirMaxLen - 1) + "\u2026";
        }
        if (dirMaxLen > 0) {
          writeString(grid, detailRow, detailStart, displayDir, detailAttrs);
        }
      }
    }
```

Note: for ungrouped sessions, when a timer is present the branch is dropped and only directory + timer are shown. This matches the spec — the timer is more actionable than the branch.

- [ ] **Step 4: Run sidebar tests**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: All tests PASS (including new timer tests)

- [ ] **Step 5: Run full test suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/sidebar.ts
git commit -m "feat: render cache timer countdown on sidebar detail row"
```

---

### Task 6: Wire receiver into main.ts — env injection + lifecycle

**Files:**
- Modify: `src/main.ts:1-25` (imports)
- Modify: `src/main.ts:157-162` (config)
- Modify: `src/main.ts:300-313` (receiver init, cache timer enabled)
- Modify: `src/main.ts:326-366` (fetchSessions — prune)
- Modify: `src/main.ts:893-920` (new-session handler — per-session env)
- Modify: `src/main.ts:1210-1243` (config watcher)
- Modify: `src/main.ts:1460-1462` (env injection at startup)
- Modify: `src/main.ts:1572-1584` (cleanup)

- [ ] **Step 1: Add import for OtelReceiver**

At the top of `main.ts`, after the existing imports (around line 22), add:

```typescript
import { OtelReceiver } from "./otel-receiver";
```

- [ ] **Step 2: Add config reading + receiver instance**

After the `claudeCommand` line (around line 162), add:

```typescript
let cacheTimersEnabled = (userConfig.cacheTimers as boolean) !== false;
```

After the `const sidebar = new Sidebar(sidebarWidth, rows);` line (around line 303), add:

```typescript
const otelReceiver = new OtelReceiver();
sidebar.cacheTimersEnabled = cacheTimersEnabled;
```

- [ ] **Step 3: Add render tick management**

After the `const sessionDetailsCache` line (around line 313), add:

```typescript
let cacheTimerInterval: ReturnType<typeof setInterval> | null = null;

function startCacheTimerTick(): void {
  if (cacheTimerInterval) return;
  cacheTimerInterval = setInterval(() => {
    if (cacheTimersEnabled && otelReceiver.getActiveSessionIds().length > 0) {
      scheduleRender();
    }
  }, 1000);
}

function stopCacheTimerTick(): void {
  if (cacheTimerInterval) {
    clearInterval(cacheTimerInterval);
    cacheTimerInterval = null;
  }
}
```

- [ ] **Step 4: Wire onUpdate callback**

After the render tick code, add:

```typescript
otelReceiver.onUpdate = (sessionId) => {
  const state = otelReceiver.getTimerState(sessionId);
  sidebar.setCacheTimer(sessionId, state);
  startCacheTimerTick();
  scheduleRender();
};
```

- [ ] **Step 5: Add prune call to fetchSessions**

In `fetchSessions()`, after `sidebar.updateSessions(sessions);` (around line 358), add:

```typescript
    // Prune cache timer state for dead sessions
    const liveIds = sessions.map((s) => s.id);
    otelReceiver.pruneExcept(liveIds);
    // Stop tick if no timers remain
    if (otelReceiver.getActiveSessionIds().length === 0) {
      stopCacheTimerTick();
    }
```

- [ ] **Step 6: Add per-session env injection to new-session handlers**

In the `case "standard"` block of the new-session handler (around line 895), after the `new-session -d` command and before `switch-client`, add:

```typescript
              await control.sendCommand(`set-environment -t '${session}' OTEL_RESOURCE_ATTRIBUTES 'tmux_session_id=${session}'`);
```

Note: We use the session name here, not the session ID (like `$0`), because we don't know the ID yet. The tmux session name is what we pass to `new-session -d -s`. We'll need to handle the mapping — actually, the `fetchSessions` data uses `session_id` format (`$0`, `$1`). We should set the resource attribute using the session name and correlate on the session name instead. However, that creates a problem if session names contain special characters. 

A better approach: after creating the session, query its ID and set the env var with that. But the simplest approach is to use the session name as the key in both the resource attribute and the timer map lookup. Let's revisit: in `fetchSessions`, the session `id` field comes from `#{session_id}` which is `$0`, `$1`, etc. We need the resource attribute to use this same value.

After `new-session -d`, the session exists and we can query it:

```typescript
              const idLines = await control.sendCommand(`display-message -t '${session}' -p '#{session_id}'`);
              const newSessionId = (idLines[0] || "").trim();
              if (newSessionId) {
                await control.sendCommand(`set-environment -t '${session}' OTEL_RESOURCE_ATTRIBUTES 'tmux_session_id=${newSessionId}'`);
              }
```

Add this same block in all three new-session cases (`standard`, `existing_worktree`, `new_worktree`), after each `new-session -d` command and before `switch-client`.

- [ ] **Step 7: Add env injection at startup**

In the startup section, after the existing `set-environment -g JMUX 1` block (around line 1462), add:

```typescript
  // Start OTLP receiver and inject OTel env vars
  const otelPort = await otelReceiver.start();
  await control.sendCommand("set-environment -g CLAUDE_CODE_ENABLE_TELEMETRY 1");
  await control.sendCommand("set-environment -g OTEL_LOGS_EXPORTER otlp");
  await control.sendCommand("set-environment -g OTEL_EXPORTER_OTLP_PROTOCOL http/json");
  await control.sendCommand(`set-environment -g OTEL_EXPORTER_OTLP_ENDPOINT http://127.0.0.1:${otelPort}`);

  // Set per-session resource attributes for all existing sessions
  for (const session of currentSessions) {
    await control.sendCommand(
      `set-environment -t '${session.id}' OTEL_RESOURCE_ATTRIBUTES 'tmux_session_id=${session.id}'`,
    );
  }
```

Note: the `otelReceiver.start()` call must happen before `set-environment` commands that reference the port.

- [ ] **Step 8: Add cleanup**

In the `cleanup()` function (around line 1572), add before `process.exit(0)`:

```typescript
  otelReceiver.stop();
  stopCacheTimerTick();
```

- [ ] **Step 9: Add cacheTimers to config watcher**

In the config file watcher callback (around line 1217), after `claudeCommand = newClaudeCmd;`, add:

```typescript
    const newCacheTimers = (updated.cacheTimers as boolean) !== false;
    if (newCacheTimers !== cacheTimersEnabled) {
      cacheTimersEnabled = newCacheTimers;
      sidebar.cacheTimersEnabled = newCacheTimers;
      if (newCacheTimers && otelReceiver.getActiveSessionIds().length > 0) {
        startCacheTimerTick();
      } else if (!newCacheTimers) {
        stopCacheTimerTick();
      }
      scheduleRender();
    }
```

- [ ] **Step 10: Run full test suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: All PASS

- [ ] **Step 11: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire OtelReceiver lifecycle, env injection, render tick, and config watcher"
```

---

### Task 7: Settings palette toggle

**Files:**
- Modify: `src/main.ts:714-737` (buildPaletteCommands)
- Modify: `src/main.ts:1037-1046` (handlePaletteAction setting-wtm area)

- [ ] **Step 1: Add palette command in buildPaletteCommands**

After the `setting-project-dirs` entry (around line 735), add:

```typescript
  commands.push({
    id: "setting-cache-timers",
    label: `Cache timers: ${settings.cacheTimers !== false ? "on" : "off"}`,
    category: "setting",
  });
```

- [ ] **Step 2: Add handler in handlePaletteAction**

After the `case "setting-wtm"` block (around line 1046), add:

```typescript
    case "setting-cache-timers": {
      let ctSettings: Record<string, any> = {};
      try {
        const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
        if (existsSync(cfgPath)) ctSettings = JSON.parse(readFileSync(cfgPath, "utf-8"));
      } catch {}
      const current = ctSettings.cacheTimers !== false;
      await applySetting("cacheTimers", !current, "boolean");
      return;
    }
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: add cache timers toggle to settings palette"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Manual smoke test**

Run: `bun run dev`

1. Verify jmux starts without errors
2. Open settings (Ctrl-a i) — confirm "Cache timers: on" appears
3. Toggle it off and back on — confirm it hot-applies
4. The timer will only appear when a Claude Code instance in a session sends OTel data — this requires running Claude Code in a session. Without that, confirm no timers show (no crashes, no visual glitches).

- [ ] **Step 4: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "fix: address smoke test findings"
```
