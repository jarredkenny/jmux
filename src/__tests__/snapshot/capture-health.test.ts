import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { INTERNAL_SESSION_FILTER } from "../../glass/internal-sessions";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

const F = INTERNAL_SESSION_FILTER;

function mk(runner: FakeRunner, fs = new FakeFs(), clock = new FakeClock()) {
  return new Snapshotter({
    dir: "/snap",
    model: new SnapshotModel("test"),
    fs,
    runner,
    clock,
    debounceMs: 200,
    scrollbackIntervalMs: 5000,
    staleMs: 60_000,
  });
}

describe("Snapshotter health", () => {
  test("successful topology + commit -> healthy", async () => {
    const runner = new FakeRunner();
    runner.setResponse(
      `list-sessions -f ${F} -F #{session_name}|#{session_path}`,
      { stdout: "a|/tmp/a\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse(
      "list-windows -t a -F #{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
      { stdout: "1|a|layout|1\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse(
      "list-panes -t a:1 -F #{pane_index}|#{pane_current_path}|#{pane_start_command}",
      { stdout: "1|/tmp/a|\n", stderr: "", exitCode: 0 },
    );
    const s = mk(runner);
    await s.start();
    await s.onSessionsChanged();
    await s.flushNow();
    expect(s.getHealth(0)).toBe("healthy");
    await s.stop();
  });

  test("topology tmux failure records a failure signal", async () => {
    const runner = new FakeRunner();
    runner.defaultResponse = { stdout: "", stderr: "boom", exitCode: 1 };
    const s = mk(runner);
    await s.start();
    await s.onSessionsChanged();
    expect(s.healthSnapshot().topology.consecutiveFailures).toBeGreaterThanOrEqual(
      1,
    );
    await s.stop();
  });
});
