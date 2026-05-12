import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import type { SnapshotFile } from "../../snapshot/schema";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function makeSnap(lastFocused: string | null, present: Record<string, boolean>): SnapshotFile {
  return {
    formatVersion: 1,
    jmuxVersion: "test",
    capturedAt: "2026-05-12T00:00:00.000Z",
    tmuxSocket: "",
    lastFocusedSession: lastFocused,
    sessions: Object.entries(present).map(([name, cwdOk]) => ({
      name,
      cwd: cwdOk ? "/ok" : "/nope",
      worktreePath: null,
      projectGroup: null,
      pinned: false,
      attention: false,
      permissionMode: null,
      otel: null,
      links: [],
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
    })),
  };
}

describe("Restorer attach target selection", () => {
  test("returns lastFocused if it was restored", async () => {
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async (p) => p === "/ok",
    });
    await r.run(makeSnap("beta", { alpha: true, beta: true }));
    expect(r.attachTarget()).toBe("beta");
  });

  test("falls back to first restored when lastFocused was skipped", async () => {
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async (p) => p === "/ok",
    });
    await r.run(makeSnap("beta", { alpha: true, beta: false }));
    expect(r.attachTarget()).toBe("alpha");
  });

  test("returns null when no session restored at all", async () => {
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => false,
    });
    await r.run(makeSnap("alpha", { alpha: false, beta: false }));
    expect(r.attachTarget()).toBeNull();
  });
});
