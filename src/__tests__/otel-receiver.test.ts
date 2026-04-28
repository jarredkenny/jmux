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

    const state = receiver.getTimerState("$1");
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

    const state = receiver.getTimerState("$2");
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

    expect(receiver.getTimerState("$3")).toBeNull();
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
    const first = receiver.getTimerState("$0");
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
    const second = receiver.getTimerState("$0");
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
});
