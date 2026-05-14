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

function makeSession(
  name: string,
  windows: Array<{ index: number; name: string; active: boolean; panes: Array<{ index: number }> }>,
): SnapshotFile["sessions"][number] {
  return {
    name,
    cwd: "/repos/foo",
    worktreePath: null,
    projectGroup: null,
    pinned: false,
    attention: false,
    permissionMode: null,
    otel: null,
    links: [],
    windows: windows.map((w) => ({
      index: w.index,
      name: w.name,
      layout: "L",
      active: w.active,
      panes: w.panes.map((p) => ({
        index: p.index,
        cwd: "/repos/foo",
        command: "zsh",
        kind: "shell" as const,
        scrollbackFile: null,
      })),
    })),
  };
}

describe("Restorer zero-pane window handling", () => {
  test("first window zero-pane: second window becomes new-session", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const snapshot: SnapshotFile = {
      formatVersion: 1,
      jmuxVersion: "test",
      capturedAt: "2026-05-12T00:00:00.000Z",
      tmuxSocket: "",
      lastFocusedSession: null,
      sessions: [
        makeSession("alpha", [
          { index: 0, name: "empty", active: false, panes: [] },
          { index: 1, name: "work", active: true, panes: [{ index: 0 }] },
        ]),
      ],
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
    await r.run(snapshot);

    expect(r.outcomeFor("alpha")).toBe("restored");
    // The first tmux command for the session must be new-session, not new-window
    const sessionCmds = runner.invocations.filter(
      (a) => a[0] === "new-session" || a[0] === "new-window",
    );
    expect(sessionCmds[0][0]).toBe("new-session");
    expect(sessionCmds[0]).toContain("alpha");
    // new-window must NOT have been issued (only one non-empty window)
    expect(runner.invocations.some((a) => a[0] === "new-window")).toBe(false);
  });

  test("all windows zero-pane: session logged as skipped with no_restorable_windows", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const snapshot: SnapshotFile = {
      formatVersion: 1,
      jmuxVersion: "test",
      capturedAt: "2026-05-12T00:00:00.000Z",
      tmuxSocket: "",
      lastFocusedSession: null,
      sessions: [
        makeSession("ghost", [
          { index: 0, name: "empty0", active: false, panes: [] },
          { index: 1, name: "empty1", active: true, panes: [] },
        ]),
      ],
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
    await r.run(snapshot);

    expect(r.outcomeFor("ghost")).toBe("skipped");
    // No tmux session creation commands should have been issued
    expect(runner.invocations.some((a) => a[0] === "new-session")).toBe(false);
    expect(runner.invocations.some((a) => a[0] === "new-window")).toBe(false);
    // Log must contain the no_restorable_windows reason
    const logBytes = fs.files.get("/snap/restore.log");
    expect(logBytes).not.toBeUndefined();
    const logText = new TextDecoder().decode(logBytes!);
    expect(logText).toContain('"reason":"no_restorable_windows"');
    expect(logText).toContain('"outcome":"skipped"');
  });
});

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
