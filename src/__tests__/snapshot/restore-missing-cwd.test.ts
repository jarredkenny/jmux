import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import type { SnapshotFile } from "../../snapshot/schema";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

const snap: SnapshotFile = {
  formatVersion: 1,
  jmuxVersion: "test",
  capturedAt: "2026-05-12T00:00:00.000Z",
  tmuxSocket: "",
  lastFocusedSession: null,
  sessions: [
    {
      name: "gone",
      cwd: "/no/such/path",
      worktreePath: null,
      projectGroup: null,
      pinned: false,
      attention: false,
      permissionMode: null,
      otel: null,
      links: [{ type: "issue", id: "ENG-1" }],
      windows: [
        {
          index: 0,
          name: "main",
          layout: "L",
          active: true,
          panes: [
            { index: 0, cwd: "/no/such/path", command: "zsh", kind: "shell", scrollbackFile: null },
          ],
        },
      ],
    },
  ],
};

describe("Restorer missing cwd", () => {
  test("skipped session lands in restore.log with cwd_missing reason", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => false,
    });
    await r.run(snap);
    expect(r.outcomeFor("gone")).toBe("skipped");
    const log = new TextDecoder().decode(fs.files.get("/snap/restore.log")!);
    expect(log).toContain('"reason":"cwd_missing"');
    expect(log).toContain('"session":"gone"');
  });

  test("skipped session does not invoke tmux commands", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => false,
    });
    await r.run(snap);
    expect(runner.invocations.length).toBe(0);
  });
});
