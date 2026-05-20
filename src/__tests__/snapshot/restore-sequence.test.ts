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

    // The first new-session is prefixed with `-f <bootstrap.conf>` to seed
    // base-index on a fresh tmux server (see Restorer.writeBootstrapConfig).
    // Subsequent invocations are unprefixed, so we search by substring.
    const cmds = runner.invocations.map((a) => a.join(" "));
    const firstNewSession = cmds.findIndex((c) => c.includes("new-session -d -s alpha"));
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

    // The first new-session is preceded by `-f <bootstrap.conf>`, so locate
    // it by including "new-session" anywhere in the args array.
    const newSession = runner.invocations.find((a) => a.includes("new-session"));
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

describe("Restorer base-index bootstrap", () => {
  function snapshotWithBaseIndex(idx: number): SnapshotFile {
    return {
      formatVersion: 1,
      jmuxVersion: "test",
      capturedAt: "2026-05-20T00:00:00.000Z",
      tmuxSocket: "",
      lastFocusedSession: null,
      sessions: [
        {
          name: "s",
          cwd: "/repos/foo",
          worktreePath: null,
          projectGroup: null,
          pinned: false,
          permissionMode: "default",
          otel: null,
          links: [],
          windows: [
            {
              index: idx,
              name: "w",
              layout: "LAYOUT",
              active: true,
              panes: [
                { index: idx, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
              ],
            },
          ],
        },
      ],
    };
  }

  test("first new-session passes `-f <bootstrap.conf>` for base-index 1 snapshots", async () => {
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
      cwdExists: async () => true,
    });
    await r.run(snapshotWithBaseIndex(1));

    const newSession = runner.invocations.find((a) => a.includes("new-session"));
    expect(newSession).toBeDefined();
    const fIdx = newSession!.indexOf("-f");
    expect(fIdx).toBeGreaterThanOrEqual(0);
    expect(newSession![fIdx + 1]).toBe("/snap/.bootstrap.conf");

    const bytes = await fs.readFile("/snap/.bootstrap.conf");
    expect(bytes).not.toBeNull();
    const written = new TextDecoder().decode(bytes!);
    expect(written).toContain("set -g base-index 1");
    expect(written).toContain("set -g pane-base-index 1");
  });

  test("derives base-index from the snapshot (uses 0 when snapshot has window 0)", async () => {
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
      cwdExists: async () => true,
    });
    await r.run(snapshotWithBaseIndex(0));

    const bytes = await fs.readFile("/snap/.bootstrap.conf");
    expect(bytes).not.toBeNull();
    const written = new TextDecoder().decode(bytes!);
    expect(written).toContain("set -g base-index 0");
    expect(written).toContain("set -g pane-base-index 0");
  });

  test("only the first new-session gets the -f flag; subsequent ones don't", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const snap: SnapshotFile = {
      ...snapshotWithBaseIndex(1),
      sessions: [
        snapshotWithBaseIndex(1).sessions[0],
        { ...snapshotWithBaseIndex(1).sessions[0], name: "s2" },
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
    await r.run(snap);

    const newSessions = runner.invocations.filter((a) => a.includes("new-session"));
    expect(newSessions.length).toBe(2);
    expect(newSessions[0].includes("-f")).toBe(true);
    expect(newSessions[1].includes("-f")).toBe(false);
  });

  test("no bootstrap config is written when every session is skipped", async () => {
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
    await r.run(snapshotWithBaseIndex(1));

    expect(runner.invocations.length).toBe(0);
    const bytes = await fs.readFile("/snap/.bootstrap.conf");
    expect(bytes).toBeNull();
  });
});
