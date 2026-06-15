import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function setupSession(runner: FakeRunner) {
  runner.setResponse("list-sessions -f #{?#{m:__jmux_*,#{session_name}},0,1} -F #{session_name}", {
    stdout: "alpha\n",
    stderr: "",
    exitCode: 0,
  });
  runner.setResponse("list-windows -t alpha -F #{window_index}", {
    stdout: "0\n",
    stderr: "",
    exitCode: 0,
  });
  runner.setResponse("list-panes -t alpha:0 -F #{pane_index}", {
    stdout: "0\n",
    stderr: "",
    exitCode: 0,
  });
}

describe("Snapshotter scrollback loop", () => {
  test("captures pane output to scrollback file on tick", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    setupSession(runner);
    runner.setResponse(
      "capture-pane -p -e -J -S - -t alpha:0.0",
      { stdout: "scrollback bytes here", stderr: "", exitCode: 0 },
    );
    const model = new SnapshotModel("test");
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, [
          SnapshotModel.makeEmptyPane(0, "/x", "zsh"),
        ]),
      ],
    });
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 1000,
    });
    await s.start();
    clock.advance(1000);
    await clock.flushMicrotasks();

    const written = fs.files.get("/snap/scrollback/alpha/0-0.ansi");
    expect(written).not.toBeUndefined();
    expect(new TextDecoder().decode(written!)).toBe("scrollback bytes here");
    await s.stop();
  });

  test("empty pane writes null to model and removes scrollback file", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    setupSession(runner);
    runner.setResponse(
      "capture-pane -p -e -J -S - -t alpha:0.0",
      { stdout: "", stderr: "", exitCode: 0 },
    );
    fs.files.set("/snap/scrollback/alpha/0-0.ansi", new Uint8Array([1, 2]));
    const model = new SnapshotModel("test");
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, [
          SnapshotModel.makeEmptyPane(0, "/x", "zsh"),
        ]),
      ],
    });
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 1000,
    });
    await s.start();
    clock.advance(1000);
    await clock.flushMicrotasks();
    expect(fs.files.has("/snap/scrollback/alpha/0-0.ansi")).toBe(false);
    await s.stop();
  });

  test("failing capture-pane skips pane without aborting tick", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -f #{?#{m:__jmux_*,#{session_name}},0,1} -F #{session_name}", {
      stdout: "alpha\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("list-windows -t alpha -F #{window_index}", {
      stdout: "0\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("list-panes -t alpha:0 -F #{pane_index}", {
      stdout: "0\n1\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("capture-pane -p -e -J -S - -t alpha:0.0", {
      stdout: "",
      stderr: "pane closed",
      exitCode: 1,
    });
    runner.setResponse("capture-pane -p -e -J -S - -t alpha:0.1", {
      stdout: "second pane scrollback",
      stderr: "",
      exitCode: 0,
    });
    const model = new SnapshotModel("test");
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, [
          SnapshotModel.makeEmptyPane(0, "/x", "zsh"),
          SnapshotModel.makeEmptyPane(1, "/x", "zsh"),
        ]),
      ],
    });
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 1000,
    });
    await s.start();
    clock.advance(1000);
    await clock.flushMicrotasks();
    expect(fs.files.has("/snap/scrollback/alpha/0-1.ansi")).toBe(true);
    await s.stop();
  });

  test("size cap truncates oldest bytes with marker", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    setupSession(runner);
    const big = "x".repeat(10000);
    runner.setResponse("capture-pane -p -e -J -S - -t alpha:0.0", {
      stdout: big,
      stderr: "",
      exitCode: 0,
    });
    const model = new SnapshotModel("test");
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, [
          SnapshotModel.makeEmptyPane(0, "/x", "zsh"),
        ]),
      ],
    });
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 1000,
      scrollbackMaxBytes: 1000,
    });
    await s.start();
    clock.advance(1000);
    await clock.flushMicrotasks();
    const written = fs.files.get("/snap/scrollback/alpha/0-0.ansi")!;
    const text = new TextDecoder().decode(written);
    // Allow some slack: the "dropped" digit count affects marker size.
    expect(written.byteLength).toBeLessThanOrEqual(1100);
    expect(text).toContain("--- truncated: oldest");
    // Original was 10000 bytes; result must be much smaller.
    expect(written.byteLength).toBeLessThan(10000);
    await s.stop();
  });

  test("gcScrollback prunes orphan pane files within a live session", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();

    // "alpha" is live with panes 0-0 and 0-1
    runner.setResponse("list-sessions -f #{?#{m:__jmux_*,#{session_name}},0,1} -F #{session_name}", {
      stdout: "alpha\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("list-windows -t alpha -F #{window_index}", {
      stdout: "0\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("list-panes -t alpha:0 -F #{pane_index}", {
      stdout: "0\n1\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("capture-pane -p -e -J -S - -t alpha:0.0", {
      stdout: "pane0 content",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("capture-pane -p -e -J -S - -t alpha:0.1", {
      stdout: "pane1 content",
      stderr: "",
      exitCode: 0,
    });

    // Pre-populate: live panes 0-0 and 0-1 plus stale 0-2 that no longer exists
    fs.files.set("/snap/scrollback/alpha/0-0.ansi", new Uint8Array([1]));
    fs.files.set("/snap/scrollback/alpha/0-1.ansi", new Uint8Array([2]));
    fs.files.set("/snap/scrollback/alpha/0-2.ansi", new Uint8Array([3]));

    const model = new SnapshotModel("test");
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, [
          SnapshotModel.makeEmptyPane(0, "/x", "zsh"),
          SnapshotModel.makeEmptyPane(1, "/x", "zsh"),
        ]),
      ],
    });

    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 1000,
    });
    await s.start();
    clock.advance(1000);
    await clock.flushMicrotasks();

    // Live pane files survive
    expect(fs.files.has("/snap/scrollback/alpha/0-0.ansi")).toBe(true);
    expect(fs.files.has("/snap/scrollback/alpha/0-1.ansi")).toBe(true);
    // Stale pane file for closed pane 0-2 is pruned
    expect(fs.files.has("/snap/scrollback/alpha/0-2.ansi")).toBe(false);
    await s.stop();
  });

  test("gcScrollback removes files and dir for dead sessions", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();

    // Only "beta" is live; "dead" is gone
    runner.setResponse("list-sessions -f #{?#{m:__jmux_*,#{session_name}},0,1} -F #{session_name}", {
      stdout: "beta\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("list-windows -t beta -F #{window_index}", {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    // Pre-populate scrollback files for the dead session
    fs.files.set("/snap/scrollback/dead/0-0.ansi", new Uint8Array([1, 2, 3]));
    fs.dirs.add("/snap/scrollback/dead");

    const model = new SnapshotModel("test");
    model.upsertSession(SnapshotModel.makeEmptySession("beta", "/x"));

    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 1000,
    });
    await s.start();
    clock.advance(1000);
    await clock.flushMicrotasks();

    // File in dead session dir should be removed
    expect(fs.files.has("/snap/scrollback/dead/0-0.ansi")).toBe(false);
    // The dead session dir itself should be removed
    expect(fs.dirs.has("/snap/scrollback/dead")).toBe(false);
    await s.stop();
  });
});
