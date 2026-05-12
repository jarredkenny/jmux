import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function snap() {
  const model = new SnapshotModel("test");
  return {
    model,
    clock: new FakeClock(),
    fs: new FakeFs(),
    runner: new FakeRunner(),
  };
}

describe("Snapshotter structural events", () => {
  test("session created via tmux events triggers a session in the model", async () => {
    const { model, clock, fs, runner } = snap();
    runner.setResponse(
      "list-windows -t alpha -F #{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
      { stdout: "0|main|b46c,80x24,0,0,0|1\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse("list-panes -t alpha:0 -F #{pane_index}|#{pane_current_path}|#{pane_start_command}", {
      stdout: "0|/repos/foo|zsh\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse(
      "list-sessions -F #{session_name}|#{session_path}",
      { stdout: "alpha|/repos/foo\n", stderr: "", exitCode: 0 },
    );

    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    await s.onSessionsChanged();
    expect(model.hasSession("alpha")).toBe(true);
    await s.stop();
  });

  test("layout-change updates the window layout in the model", async () => {
    const { model, clock, fs, runner } = snap();
    runner.setResponse(
      "list-windows -t alpha -F #{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
      { stdout: "0|main|NEW-LAYOUT|1\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse(
      "list-panes -t alpha:0 -F #{pane_index}|#{pane_current_path}|#{pane_start_command}",
      { stdout: "0|/repos/foo|zsh\n", stderr: "", exitCode: 0 },
    );
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/repos/foo"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "OLD", true, [
          SnapshotModel.makeEmptyPane(0, "/repos/foo", "zsh"),
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
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    await s.onLayoutChanged("alpha");
    const file = model.toFile("2026-05-12T00:00:00.000Z");
    expect(file.sessions[0].windows[0].layout).toBe("NEW-LAYOUT");
    await s.stop();
  });

  test("metadata event on unknown session is a no-op", async () => {
    const { model, clock, fs, runner } = snap();
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    // No session in the model. These should not throw or pollute the snapshot.
    s.onPermissionMode("ghost", "plan");
    s.onPinned("ghost", true);
    s.onAttention("ghost", true);
    s.onLinks("ghost", [{ type: "issue", id: "ENG-1" }]);
    s.onOtel("ghost", null);
    await s.flushNow();
    const written = fs.files.get("/snap/state.json");
    expect(written).not.toBeUndefined();
    const parsed = JSON.parse(new TextDecoder().decode(written!));
    expect(parsed.sessions).toEqual([]);
    await s.stop();
  });

  test("session-renamed mutates the model name and lastFocused", async () => {
    const { model, clock, fs, runner } = snap();
    model.upsertSession(SnapshotModel.makeEmptySession("old", "/x"));
    model.setLastFocused("old");
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    await s.onSessionRenamed("old", "new");
    expect(model.hasSession("new")).toBe(true);
    expect(model.hasSession("old")).toBe(false);
    expect(model.toFile("2026-05-12T00:00:00.000Z").lastFocusedSession).toBe("new");
    await s.stop();
  });
});
