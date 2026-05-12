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
