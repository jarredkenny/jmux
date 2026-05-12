import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import type { SnapshotFile } from "../../snapshot/schema";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function snapshot(): SnapshotFile {
  return {
    formatVersion: 1,
    jmuxVersion: "test",
    capturedAt: "2026-05-12T18:00:00.000Z",
    tmuxSocket: "",
    lastFocusedSession: "alpha",
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
              { index: 0, cwd: "/repos/foo", command: "claude", kind: "claude", scrollbackFile: "scrollback/alpha/0-0.ansi" },
              { index: 1, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
            ],
          },
          {
            index: 1,
            name: "logs",
            layout: "LAYOUT-W1",
            active: false,
            panes: [
              { index: 0, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
            ],
          },
        ],
      },
    ],
  };
}

describe("Restorer.run sequence", () => {
  test("emits new-session, new-window, split-window, select-layout, rename-window in order", async () => {
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
      cwdExists: async (p: string) => p === "/repos/foo",
    });
    await r.run(snapshot());

    const cmds = runner.invocations.map((a) => a.join(" "));
    const firstNewSession = cmds.findIndex((c) => c.startsWith("new-session -d -s alpha"));
    const newWindowW1 = cmds.findIndex((c) => c.startsWith("new-window -t alpha:1"));
    const splitW0 = cmds.findIndex((c) => c.startsWith("split-window -t alpha:0"));
    const selectLayoutW0 = cmds.findIndex((c) => c.startsWith("select-layout -t alpha:0"));
    const selectLayoutW1 = cmds.findIndex((c) => c.startsWith("select-layout -t alpha:1"));
    const renameW0 = cmds.findIndex((c) => c.startsWith("rename-window -t alpha:0 main"));
    const renameW1 = cmds.findIndex((c) => c.startsWith("rename-window -t alpha:1 logs"));

    expect(firstNewSession).toBeGreaterThanOrEqual(0);
    expect(splitW0).toBeGreaterThan(firstNewSession);
    expect(selectLayoutW0).toBeGreaterThan(splitW0);
    expect(newWindowW1).toBeGreaterThan(selectLayoutW0);
    expect(selectLayoutW1).toBeGreaterThan(newWindowW1);
    expect(renameW0).toBeGreaterThan(selectLayoutW0);
    expect(renameW1).toBeGreaterThan(selectLayoutW1);
  });

  test("painter argv is passed as the pane command", async () => {
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
      cwdExists: async (p: string) => p === "/repos/foo",
    });
    await r.run(snapshot());

    const newSession = runner.invocations.find((a) => a[0] === "new-session");
    expect(newSession).toBeDefined();
    // tail is sh -c '...' jmux-restore <path> <ts> claude --continue
    const shIdx = newSession!.indexOf("sh");
    expect(shIdx).toBeGreaterThanOrEqual(0);
    expect(newSession![shIdx + 3]).toBe("jmux-restore");
    expect(newSession![newSession!.length - 2]).toBe("claude");
    expect(newSession![newSession!.length - 1]).toBe("--continue");
  });

  test("records 'restored' outcome for fully-restored session", async () => {
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
      cwdExists: async (p: string) => p === "/repos/foo",
    });
    await r.run(snapshot());
    expect(r.outcomeFor("alpha")).toBe("restored");
  });
});
