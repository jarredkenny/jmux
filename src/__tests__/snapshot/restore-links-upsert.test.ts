import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import type { SnapshotFile } from "../../snapshot/schema";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

const snap: SnapshotFile = {
  formatVersion: 1,
  jmuxVersion: "test",
  capturedAt: "2026-05-12T00:00:00.000Z",
  tmuxSocket: "",
  lastFocusedSession: "alpha",
  sessions: [
    {
      name: "alpha",
      cwd: "/ok",
      worktreePath: null,
      projectGroup: null,
      pinned: false,
      attention: false,
      permissionMode: null,
      otel: null,
      links: [
        { type: "issue", id: "ENG-1" },
        { type: "mr", id: "42" },
      ],
      windows: [
        {
          index: 0,
          name: "main",
          layout: "L",
          active: true,
          panes: [
            { index: 0, cwd: "/ok", command: "zsh", kind: "shell", scrollbackFile: null },
          ],
        },
      ],
    },
  ],
};

/** A snapshot where every optional field is populated. */
const fullSnap: SnapshotFile = {
  formatVersion: 1,
  jmuxVersion: "test",
  capturedAt: "2026-05-12T00:00:00.000Z",
  tmuxSocket: "",
  lastFocusedSession: "beta",
  sessions: [
    {
      name: "beta",
      cwd: "/ok",
      worktreePath: null,
      projectGroup: null,
      pinned: true,
      attention: true,
      permissionMode: "plan",
      otel: {
        costUsd: 1.23,
        cacheWasHit: true,
        lastRequestTime: "2026-05-12T00:00:00.000Z",
        lastCompactionTime: null,
        lastTool: "Read",
        lastUserPromptTime: null,
        lastError: null,
        failedMcpServers: [],
      },
      links: [{ type: "issue", id: "ENG-99" }],
      windows: [
        {
          index: 0,
          name: "main",
          layout: "L",
          active: true,
          panes: [
            { index: 0, cwd: "/ok", command: "zsh", kind: "shell", scrollbackFile: null },
          ],
        },
      ],
    },
  ],
};

describe("Restorer links upsert", () => {
  test("invokes sessionLinksSink for each restored session", async () => {
    const calls: Array<{ name: string; links: { type: string; id: string }[] }> = [];
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => true,
      sessionLinksSink: (name, links) => calls.push({ name, links }),
    });
    await r.run(snap);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("alpha");
    expect(calls[0].links).toEqual([
      { type: "issue", id: "ENG-1" },
      { type: "mr", id: "42" },
    ]);
  });

  test("does not invoke sink for skipped session", async () => {
    const calls: Array<{ name: string }> = [];
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => false,
      sessionLinksSink: (name) => calls.push({ name }),
    });
    await r.run(snap);
    expect(calls.length).toBe(0);
  });
});

describe("Restorer all five sinks", () => {
  test("all five sinks fire for a fully-populated restored session", async () => {
    const events: string[] = [];
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => true,
      sessionLinksSink: () => events.push("links"),
      permissionModeSink: () => events.push("permissionMode"),
      otelSink: () => events.push("otel"),
      pinnedSink: () => events.push("pinned"),
      attentionSink: () => events.push("attention"),
    });
    await r.run(fullSnap);
    expect(events.sort()).toEqual(["attention", "links", "otel", "permissionMode", "pinned"]);
  });

  test("no sinks fire for a skipped session", async () => {
    const events: string[] = [];
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => false,
      sessionLinksSink: () => events.push("links"),
      permissionModeSink: () => events.push("permissionMode"),
      otelSink: () => events.push("otel"),
      pinnedSink: () => events.push("pinned"),
      attentionSink: () => events.push("attention"),
    });
    await r.run(fullSnap);
    expect(events).toEqual([]);
  });
});
