/**
 * Tests for Snapshotter event handlers and edge cases not covered by the
 * existing capture-* test files.
 */
import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function makeSnapper(overrides?: Partial<{ runner: FakeRunner; model: SnapshotModel }>) {
  const clock = new FakeClock();
  const fs = new FakeFs();
  const runner = overrides?.runner ?? new FakeRunner();
  const model = overrides?.model ?? new SnapshotModel("test");
  const s = new Snapshotter({
    dir: "/snap",
    model,
    fs,
    runner,
    clock,
    debounceMs: 200,
    scrollbackIntervalMs: 1000,
  });
  return { s, clock, fs, runner, model };
}

describe("Snapshotter window-level event handlers", () => {
  test("onWindowAdded rederives windows and marks dirty", async () => {
    const { s, fs, runner, model } = makeSnapper();
    model.upsertSession(SnapshotModel.makeEmptySession("alpha", "/x"));
    runner.setResponse(
      "list-windows -t alpha -F #{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
      { stdout: "0|main|L|1\n1|editor|L|0\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse(
      "list-panes -t alpha:0 -F #{pane_index}|#{pane_current_path}|#{pane_start_command}",
      { stdout: "0|/x|zsh\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse(
      "list-panes -t alpha:1 -F #{pane_index}|#{pane_current_path}|#{pane_start_command}",
      { stdout: "0|/x|vim\n", stderr: "", exitCode: 0 },
    );
    await s.start();
    await s.onWindowAdded("alpha");
    const file = model.toFile("2026-05-12T00:00:00.000Z");
    expect(file.sessions[0].windows).toHaveLength(2);
    expect(file.sessions[0].windows[1].name).toBe("editor");
    await s.stop();
  });

  test("onWindowClosed rederives windows and marks dirty", async () => {
    const { s, fs, runner, model } = makeSnapper();
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, []),
        SnapshotModel.makeEmptyWindow(1, "old", "L", false, []),
      ],
    });
    runner.setResponse(
      "list-windows -t alpha -F #{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
      { stdout: "0|main|L|1\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse(
      "list-panes -t alpha:0 -F #{pane_index}|#{pane_current_path}|#{pane_start_command}",
      { stdout: "0|/x|zsh\n", stderr: "", exitCode: 0 },
    );
    await s.start();
    await s.onWindowClosed("alpha");
    const file = model.toFile("2026-05-12T00:00:00.000Z");
    expect(file.sessions[0].windows).toHaveLength(1);
    await s.stop();
  });

  test("onWindowRenamed rederives windows and marks dirty", async () => {
    const { s, fs, runner, model } = makeSnapper();
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [SnapshotModel.makeEmptyWindow(0, "old-name", "L", true, [])],
    });
    runner.setResponse(
      "list-windows -t alpha -F #{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
      { stdout: "0|new-name|L|1\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse(
      "list-panes -t alpha:0 -F #{pane_index}|#{pane_current_path}|#{pane_start_command}",
      { stdout: "0|/x|zsh\n", stderr: "", exitCode: 0 },
    );
    await s.start();
    await s.onWindowRenamed("alpha");
    const file = model.toFile("2026-05-12T00:00:00.000Z");
    expect(file.sessions[0].windows[0].name).toBe("new-name");
    await s.stop();
  });
});

describe("Snapshotter.onFocused", () => {
  test("propagates focused session to model and marks dirty", async () => {
    const { s, fs, model } = makeSnapper();
    model.upsertSession(SnapshotModel.makeEmptySession("alpha", "/x"));
    await s.start();
    s.onFocused("alpha");
    await s.flushNow();
    const written = fs.files.get("/snap/state.json");
    expect(written).not.toBeUndefined();
    const parsed = JSON.parse(new TextDecoder().decode(written!));
    expect(parsed.lastFocusedSession).toBe("alpha");
    await s.stop();
  });

  test("propagates null focused session to model", async () => {
    const { s, fs, model } = makeSnapper();
    model.upsertSession(SnapshotModel.makeEmptySession("alpha", "/x"));
    model.setLastFocused("alpha");
    await s.start();
    s.onFocused(null);
    await s.flushNow();
    const written = fs.files.get("/snap/state.json");
    expect(written).not.toBeUndefined();
    const parsed = JSON.parse(new TextDecoder().decode(written!));
    expect(parsed.lastFocusedSession).toBeNull();
    await s.stop();
  });
});

describe("Snapshotter.onSessionsChanged failure paths", () => {
  test("returns early (no dirty flag) when list-sessions exits non-zero", async () => {
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}|#{session_path}", {
      stdout: "",
      stderr: "error",
      exitCode: 1,
    });
    const { s, fs } = makeSnapper({ runner });
    await s.start();
    await s.onSessionsChanged();
    // No flush should have been written because we returned early
    expect(fs.writes("/snap/state.json")).toBe(0);
    await s.stop();
  });

  test("removes stale sessions from model when they disappear from tmux", async () => {
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}|#{session_path}", {
      stdout: "beta|/y\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse(
      "list-windows -t beta -F #{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
      { stdout: "0|main|L|1\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse(
      "list-panes -t beta:0 -F #{pane_index}|#{pane_current_path}|#{pane_start_command}",
      { stdout: "0|/y|zsh\n", stderr: "", exitCode: 0 },
    );
    const model = new SnapshotModel("test");
    model.upsertSession(SnapshotModel.makeEmptySession("alpha", "/x")); // stale
    model.upsertSession(SnapshotModel.makeEmptySession("beta", "/y")); // still live
    const { s } = makeSnapper({ runner, model });
    await s.start();
    await s.onSessionsChanged();
    expect(model.hasSession("alpha")).toBe(false);
    expect(model.hasSession("beta")).toBe(true);
    await s.stop();
  });
});

describe("Snapshotter.scrollbackTick failure paths", () => {
  test("skips scrollback processing when list-sessions fails", async () => {
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "",
      stderr: "no server",
      exitCode: 1,
    });
    const clock = new FakeClock();
    const fs = new FakeFs();
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
    // No scrollback file should have been written
    expect(fs.files.has("/snap/scrollback/alpha/0-0.ansi")).toBe(false);
    await s.stop();
  });

  test("skips a window when list-windows fails during scrollback tick", async () => {
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "alpha\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("list-windows -t alpha -F #{window_index}", {
      stdout: "",
      stderr: "closed",
      exitCode: 1,
    });
    const clock = new FakeClock();
    const fs = new FakeFs();
    const model = new SnapshotModel("test");
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [SnapshotModel.makeEmptyWindow(0, "main", "L", true, [SnapshotModel.makeEmptyPane(0, "/x", "zsh")])],
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
});
