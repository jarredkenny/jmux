import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function snapshotJson(): string {
  return JSON.stringify({
    formatVersion: 1,
    jmuxVersion: "test",
    capturedAt: "2026-05-12T00:00:00.000Z",
    tmuxSocket: "",
    lastFocusedSession: null,
    sessions: [],
  });
}

describe("Restorer eligibility", () => {
  test("eligible when state.json valid + server empty + lock free", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode(snapshotJson()));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(true);
  });

  test("ineligible when state.json missing", async () => {
    const fs = new FakeFs();
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_snapshot");
  });

  test("eligible when list-sessions exits non-zero with no-server stderr", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode(snapshotJson()));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "",
      stderr: "no server running on /tmp/tmux-501/default",
      exitCode: 1,
    });
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(true);
  });

  test("ineligible when server has sessions", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode(snapshotJson()));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "existing\n",
      stderr: "",
      exitCode: 0,
    });
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("server_busy");
  });

  test("ineligible when list-sessions errors unrecognisably", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode(snapshotJson()));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "",
      stderr: "permission denied: socket /tmp/...",
      exitCode: 1,
    });
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("tmux_error");
  });

  test("invalid snapshot is backed up and ineligible", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode("{not json"));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "",
      stderr: "no server running",
      exitCode: 1,
    });
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_snapshot");
    // Backup file should have been written
    const backupKey = Array.from(fs.files.keys()).find((k) =>
      k.startsWith("/snap/state.json.broken-"),
    );
    expect(backupKey).toBeDefined();
  });
});
