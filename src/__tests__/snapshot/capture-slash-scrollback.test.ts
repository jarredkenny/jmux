import { describe, test, expect } from "bun:test";
import { Snapshotter, scrollbackDirName } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { INTERNAL_SESSION_FILTER } from "../../glass/internal-sessions";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

const F = INTERNAL_SESSION_FILTER;

describe("scrollbackDirName", () => {
  test("percent-encodes slashes and percents so names stay flat", () => {
    expect(scrollbackDirName("fix/solutions-stack-deploy")).toBe(
      "fix%2Fsolutions-stack-deploy",
    );
    expect(scrollbackDirName("plain")).toBe("plain");
    expect(scrollbackDirName("a%b/c")).toBe("a%25b%2Fc");
  });
});

describe("gcScrollback with slash-named sessions + legacy nested dirs", () => {
  test("does not throw EPERM and cleans a legacy nested dir", async () => {
    const fs = new FakeFs();
    // Legacy debris from the old raw-slash layout: a NESTED directory tree.
    fs.files.set(
      "/snap/scrollback/fix/solutions-stack-deploy/1-1.ansi",
      new Uint8Array([1]),
    );

    const runner = new FakeRunner();
    // One live session whose name contains a slash.
    runner.setResponse(`list-sessions -f ${F} -F #{session_name}`, {
      stdout: "live/branch\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("list-windows -t live/branch -F #{window_index}", {
      stdout: "1\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("list-panes -t live/branch:1 -F #{pane_index}", {
      stdout: "0\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse(
      "capture-pane -p -e -J -S - -t live/branch:1.0",
      { stdout: "hello scrollback\n", stderr: "", exitCode: 0 },
    );

    const s = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner,
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();

    // Must complete without throwing (the bug was EPERM unlinking a directory).
    await s.scrollbackTick();

    // Live session's scrollback is written under a FLAT, encoded dir name.
    expect(
      await fs.readFile("/snap/scrollback/live%2Fbranch/1-0.ansi"),
    ).not.toBeNull();
    // The legacy nested dir was removed recursively.
    expect(
      await fs.readFile("/snap/scrollback/fix/solutions-stack-deploy/1-1.ansi"),
    ).toBeNull();
    // Scrollback health recorded success (no failure).
    expect(s.healthSnapshot().scrollback.lastError).toBeNull();

    await s.stop();
  });
});
