import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import type { SnapshotFile } from "../../snapshot/schema";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function twoSessions(): SnapshotFile {
  return {
    formatVersion: 1,
    jmuxVersion: "test",
    capturedAt: "2026-05-12T00:00:00.000Z",
    tmuxSocket: "",
    lastFocusedSession: null,
    sessions: [
      {
        name: "broken",
        cwd: "/repos/foo",
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
              { index: 0, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
              { index: 1, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
            ],
          },
        ],
      },
      {
        name: "fine",
        cwd: "/repos/foo",
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
              { index: 0, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
            ],
          },
        ],
      },
    ],
  };
}

describe("Restorer partial failure", () => {
  test("topology failure kills the session and proceeds to next", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    // Make split-window fail for "broken" session
    const origRun = runner.run.bind(runner);
    runner.run = async (args) => {
      if (args[0] === "split-window" && args.includes("broken:0")) {
        return { stdout: "", stderr: "tmux: bad pane", exitCode: 1 };
      }
      return origRun(args);
    };

    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => true,
    });
    await r.run(twoSessions());
    expect(r.outcomeFor("broken")).toBe("failed");
    expect(r.outcomeFor("fine")).toBe("restored");
    expect(
      runner.invocations.some(
        (a) => a[0] === "kill-session" && a.includes("broken"),
      ),
    ).toBe(true);
  });

  test("select-layout failure keeps session and marks layout_degraded", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const origRun = runner.run.bind(runner);
    runner.run = async (args) => {
      if (args[0] === "select-layout") {
        return { stdout: "", stderr: "tmux: bad layout", exitCode: 1 };
      }
      return origRun(args);
    };
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => true,
    });
    await r.run(twoSessions());
    expect(r.outcomeFor("broken")).toBe("restored");
    expect(r.outcomeFor("fine")).toBe("restored");
    expect(
      runner.invocations.some((a) => a[0] === "kill-session"),
    ).toBe(false);
    // restore.log should mark layout_degraded for at least one session
    const logBytes = fs.files.get("/snap/restore.log");
    expect(logBytes).not.toBeUndefined();
    const logText = new TextDecoder().decode(logBytes!);
    expect(logText).toContain('"reason":"layout_degraded"');
  });
});
