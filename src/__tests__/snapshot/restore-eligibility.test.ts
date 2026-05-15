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

  test("checkEligibility acquires lock on eligible result", async () => {
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
    // Lock must have been acquired
    expect(fs.locks.has("/snap/.lock")).toBe(true);
  });

  test("second Restorer on same dir gets reason locked", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode(snapshotJson()));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const r1 = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    await r1.checkEligibility();
    // r1 now holds the lock

    const r2 = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result2 = await r2.checkEligibility();
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.reason).toBe("locked");
  });

  test("takeLock transfers ownership and subsequent takeLock returns null", async () => {
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
    await r.checkEligibility();
    const lock = r.takeLock();
    expect(lock).not.toBeNull();
    // Subsequent call returns null — ownership transferred
    const lock2 = r.takeLock();
    expect(lock2).toBeNull();
  });

  test("releaseLock releases the held lock back to FakeFs", async () => {
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
    await r.checkEligibility();
    // Lock is held after eligibility check
    expect(fs.locks.has("/snap/.lock")).toBe(true);
    // Release it (no Snapshotter will be constructed)
    await r.releaseLock();
    // Lock is released — another process could now acquire it
    expect(fs.locks.has("/snap/.lock")).toBe(false);
    // Calling releaseLock again is safe (no-op)
    await r.releaseLock();
  });
});
