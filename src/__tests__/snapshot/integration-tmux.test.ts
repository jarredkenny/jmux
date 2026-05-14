import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProductionFileSystem } from "../../snapshot/fs";
import { ProductionTmuxRunner } from "../../snapshot/runner";
import { ProductionClock } from "../../snapshot/clock";
import { Snapshotter } from "../../snapshot/capture";
import { Restorer } from "../../snapshot/restore";
import { SnapshotModel } from "../../snapshot/model";

function hasTmux(): boolean {
  try {
    const p = Bun.spawnSync(["tmux", "-V"]);
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

const SOCKET = `jmux-test-${process.pid}-${Date.now()}`;
let tmpDir: string;
let runner: ProductionTmuxRunner;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "jmux-integration-"));
  runner = new ProductionTmuxRunner(SOCKET);
});

afterAll(async () => {
  await runner.run(["kill-server"]).catch(() => undefined);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!hasTmux())("snapshot/restore against real tmux", () => {
  test("captures topology and restores it after kill-server", async () => {
    const cwd = tmpDir;
    writeFileSync(join(cwd, ".cwd-marker"), "ok");

    // Build a topology: 2 sessions, alpha has 2 windows (window 0 with 2 panes, window 1 with 1 pane);
    // beta has 1 window with 1 pane.
    await runner.run(["-f", "/dev/null", "new-session", "-d", "-s", "alpha", "-c", cwd, "sleep 60"]);
    await runner.run(["split-window", "-t", "alpha:0", "-c", cwd, "sleep 60"]);
    await runner.run(["new-window", "-t", "alpha", "-c", cwd, "sleep 60"]);
    await runner.run(["new-session", "-d", "-s", "beta", "-c", cwd, "sleep 60"]);

    // Take a snapshot
    const snapshotDir = join(tmpDir, "snap");
    const model = new SnapshotModel("test");
    model.setSocket(SOCKET);
    const fs = new ProductionFileSystem();
    const snap = new Snapshotter({
      dir: snapshotDir,
      model,
      fs,
      runner,
      clock: new ProductionClock(),
      debounceMs: 50,
      scrollbackIntervalMs: 500,
    });
    await snap.start();
    await snap.onSessionsChanged();
    await snap.flushNow();
    // Wait for one scrollback tick to collect scrollback files
    await new Promise((r) => setTimeout(r, 700));
    await snap.stop();

    // Verify state.json exists and contains both sessions
    const bytes = await fs.readFile(join(snapshotDir, "state.json"));
    expect(bytes).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(bytes!));
    expect(parsed.sessions.map((s: { name: string }) => s.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);

    // Kill the server. After this, list-sessions returns non-zero with "no server running".
    await runner.run(["kill-server"]);

    // The server is gone — Restorer should be eligible.
    const restorer = new Restorer({
      dir: snapshotDir,
      fs,
      runner,
      clock: new ProductionClock(),
      jmuxVersion: "test",
      userShell: process.env.SHELL ?? "/bin/sh",
      claudeCommand: "claude",
    });
    const eligibility = await restorer.checkEligibility();
    expect(eligibility.ok).toBe(true);
    if (!eligibility.ok) throw new Error(`not eligible: ${eligibility.reason}`);
    await restorer.run(eligibility.snapshot);

    // Verify topology
    const ls = await runner.run(["list-sessions", "-F", "#{session_name}"]);
    expect(ls.exitCode).toBe(0);
    const names = ls.stdout.trim().split("\n").sort();
    expect(names).toEqual(["alpha", "beta"]);

    const wins = await runner.run(["list-windows", "-t", "alpha", "-F", "#{window_index}"]);
    const winIdxs = wins.stdout
      .trim()
      .split("\n")
      .map(Number)
      .sort((a, b) => a - b);
    expect(winIdxs).toEqual([0, 1]);

    const panes0 = await runner.run(["list-panes", "-t", "alpha:0", "-F", "#{pane_index}"]);
    expect(panes0.stdout.trim().split("\n").length).toBe(2);

    expect(restorer.attachTarget()).not.toBeNull();
  }, 30000);
});
