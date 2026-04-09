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
