import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { OtelReceiver } from "../otel-receiver";

// Minimal OTLP JSON payload matching the structure Claude Code actually exports.
// Key differences from naive OTLP assumptions:
// - Resource attributes use tmux_session_name (not tmux_session_id)
// - Token counts come as stringValue, not intValue
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
    const payload = makeOtlpPayload({ sessionName: "$1", cacheReadTokens: 50 });

    const resp = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(resp.status).toBe(200);

    const state = receiver.getSessionState("$1");
    expect(state).not.toBeNull();
    expect(state!.cacheWasHit).toBe(true);
    expect(state!.lastRequestTime).toBeGreaterThan(0);
  });

  test("cache miss when cache_read_tokens is 0", async () => {
    const port = await receiver.start();
    const payload = makeOtlpPayload({ sessionName: "$2", cacheReadTokens: 0, cacheCreationTokens: 500 });

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const state = receiver.getSessionState("$2");
    expect(state).not.toBeNull();
    expect(state!.cacheWasHit).toBe(false);
  });

  test("ignores non-api_request events", async () => {
    const port = await receiver.start();
    const payload = makeOtlpPayload({ sessionName: "$3", eventName: "tool_result" });

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(receiver.getSessionState("$3")).toBeNull();
  });

  test("ignores payloads without tmux_session_name", async () => {
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
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$0", cacheReadTokens: 0 })),
    });
    const first = receiver.getSessionState("$0");
    expect(first!.cacheWasHit).toBe(false);
    const firstTime = first!.lastRequestTime;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 5));

    // Second request — cache hit
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$0", cacheReadTokens: 200 })),
    });
    const second = receiver.getSessionState("$0");
    expect(second!.cacheWasHit).toBe(true);
    expect(second!.lastRequestTime).toBeGreaterThanOrEqual(firstTime);
  });

  test("getActiveSessionIds returns sessions with state", async () => {
    const port = await receiver.start();

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$0" })),
    });
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$5" })),
    });

    const ids = receiver.getActiveSessionIds().sort();
    expect(ids).toEqual(["$0", "$5"]);
  });

  test("pruneExcept removes stale sessions", async () => {
    const port = await receiver.start();

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$0" })),
    });
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$5" })),
    });

    receiver.pruneExcept(["$0"]);
    expect(receiver.getSessionState("$0")).not.toBeNull();
    expect(receiver.getSessionState("$5")).toBeNull();
  });

  test("fires onUpdate callback when state changes", async () => {
    const port = await receiver.start();
    const updates: string[] = [];
    receiver.onUpdate = (id) => updates.push(id);

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$7" })),
    });

    expect(updates).toEqual(["$7"]);
  });

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

  test("compaction sets lastCompactionTime", async () => {
    const port = await receiver.start();
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "$cp", eventName: "compaction" })),
    });

    expect(receiver.getSessionState("$cp")!.lastCompactionTime).not.toBeNull();
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
});

describe("OtelReceiver change events", () => {
  let receiver: OtelReceiver;

  beforeEach(() => {
    receiver = new OtelReceiver();
  });

  afterEach(() => {
    receiver.stop();
  });

  test("onSessionUpdate fires when per-session state changes", async () => {
    const port = await receiver.start();
    const changes: string[] = [];
    receiver.onSessionUpdate((name) => changes.push(name));

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "alpha" })),
    });

    expect(changes).toContain("alpha");
  });

  test("onSessionUpdate fires for every mutation event type", async () => {
    const port = await receiver.start();
    const changes: string[] = [];
    receiver.onSessionUpdate((name) => changes.push(name));

    const events = [
      makeOtlpPayload({ sessionName: "beta", eventName: "api_request" }),
      makeOtlpPayload({ sessionName: "beta", eventName: "api_error" }),
      makeOtlpPayload({ sessionName: "beta", eventName: "user_prompt" }),
      makeOtlpPayload({ sessionName: "beta", eventName: "compaction" }),
      makeOtlpPayload({
        sessionName: "beta",
        eventName: "permission_mode_changed",
        attributes: [{ key: "mode", value: { stringValue: "plan" } }],
      }),
      makeOtlpPayload({
        sessionName: "beta",
        eventName: "mcp_server_connection",
        attributes: [
          { key: "server_name", value: { stringValue: "linear" } },
          { key: "state", value: { stringValue: "failed" } },
        ],
      }),
      makeOtlpPayload({
        sessionName: "beta",
        eventName: "tool_result",
        attributes: [
          { key: "tool_name", value: { stringValue: "Edit" } },
          { key: "duration_ms", value: { intValue: "100" } },
          { key: "success", value: { boolValue: true } },
        ],
      }),
    ];

    for (const payload of events) {
      await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    expect(changes.length).toBe(7);
    expect(changes.every((n) => n === "beta")).toBe(true);
  });

  test("multiple onSessionUpdate listeners all fire", async () => {
    const port = await receiver.start();
    const a: string[] = [];
    const b: string[] = [];
    receiver.onSessionUpdate((name) => a.push(name));
    receiver.onSessionUpdate((name) => b.push(name));

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "gamma" })),
    });

    expect(a).toContain("gamma");
    expect(b).toContain("gamma");
  });

  test("getSessionSnapshot returns a SnapshotOtel-shaped object", async () => {
    const port = await receiver.start();

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "snap1", costUsd: 0.25 })),
    });

    const snap = receiver.getSessionSnapshot("snap1");
    expect(snap).not.toBeNull();
    expect(typeof snap!.costUsd).toBe("number");
    expect(snap!.costUsd).toBeCloseTo(0.25, 5);
    expect(typeof snap!.cacheWasHit).toBe("boolean");
    expect(Array.isArray(snap!.failedMcpServers)).toBe(true);
  });

  test("getSessionSnapshot timestamps are ISO strings or null", async () => {
    const port = await receiver.start();

    // api_request sets lastRequestTime; user_prompt sets lastUserPromptTime; compaction sets lastCompactionTime
    for (const eventName of ["api_request", "user_prompt", "compaction"]) {
      await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeOtlpPayload({ sessionName: "snap2", eventName })),
      });
    }

    const snap = receiver.getSessionSnapshot("snap2");
    expect(snap).not.toBeNull();

    const isoRe = /^\d{4}-\d{2}-\d{2}T/;

    if (snap!.lastRequestTime !== null) {
      expect(snap!.lastRequestTime).toMatch(isoRe);
    }
    if (snap!.lastUserPromptTime !== null) {
      expect(snap!.lastUserPromptTime).toMatch(isoRe);
    }
    if (snap!.lastCompactionTime !== null) {
      expect(snap!.lastCompactionTime).toMatch(isoRe);
    }
    // These were set so they should be non-null
    expect(snap!.lastRequestTime).not.toBeNull();
    expect(snap!.lastUserPromptTime).not.toBeNull();
    expect(snap!.lastCompactionTime).not.toBeNull();
  });

  test("getSessionSnapshot lastTool is the tool name string or null", async () => {
    const port = await receiver.start();

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        makeOtlpPayload({
          sessionName: "snap3",
          eventName: "tool_result",
          attributes: [
            { key: "tool_name", value: { stringValue: "Bash" } },
            { key: "duration_ms", value: { intValue: "500" } },
            { key: "success", value: { boolValue: true } },
          ],
        })
      ),
    });

    const snap = receiver.getSessionSnapshot("snap3");
    expect(snap).not.toBeNull();
    expect(snap!.lastTool).toBe("Bash");
  });

  test("getSessionSnapshot lastError is a string representation or null", async () => {
    const port = await receiver.start();

    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeOtlpPayload({ sessionName: "snap4", eventName: "api_error" })),
    });

    const snap = receiver.getSessionSnapshot("snap4");
    expect(snap).not.toBeNull();
    // lastError in snapshot is a string label or null
    expect(snap!.lastError).toBe("api_error");
  });

  test("getSessionSnapshot failedMcpServers is an array of server names", async () => {
    const port = await receiver.start();

    for (const serverName of ["linear", "github"]) {
      await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          makeOtlpPayload({
            sessionName: "snap5",
            eventName: "mcp_server_connection",
            attributes: [
              { key: "server_name", value: { stringValue: serverName } },
              { key: "state", value: { stringValue: "failed" } },
            ],
          })
        ),
      });
    }

    const snap = receiver.getSessionSnapshot("snap5");
    expect(snap).not.toBeNull();
    expect(Array.isArray(snap!.failedMcpServers)).toBe(true);
    expect(snap!.failedMcpServers.sort()).toEqual(["github", "linear"]);
  });

  test("getSessionSnapshot returns null for unknown session", () => {
    expect(receiver.getSessionSnapshot("does-not-exist")).toBeNull();
  });

  test("getSessionSnapshot cacheWasHit is null when no api_request received", () => {
    // No events fired — unknown session
    const snap = receiver.getSessionSnapshot("no-events");
    expect(snap).toBeNull();
  });

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

    test("does NOT fire on api_error", async () => {
      const seen: string[] = [];
      const recv = new OtelReceiver({
        onAgentResumeHint: (name) => seen.push(name),
      });
      const port = await recv.start();
      try {
        await fetch(`http://127.0.0.1:${port}/v1/logs`, {
          method: "POST",
          body: JSON.stringify(makeOtlpPayload({ sessionName: "foo", eventName: "api_error" })),
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
});
