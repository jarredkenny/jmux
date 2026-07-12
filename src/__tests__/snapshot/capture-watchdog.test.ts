import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

describe("Snapshotter watchdog", () => {
  test("persists health.json and emits transitions", async () => {
    const runner = new FakeRunner();
    runner.defaultResponse = { stdout: "", stderr: "boom", exitCode: 1 };
    const fs = new FakeFs();
    const clock = new FakeClock();
    const transitions: string[] = [];
    const s = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
      staleMs: 10_000,
      captureIntervalMs: 15_000,
      healthPersistPath: "/snap/health.json",
      onHealthChange: (h) => transitions.push(h),
    });
    await s.start();
    // Topology keeps failing across watchdog ticks -> eventually derives error.
    clock.advance(15_000);
    await clock.flushMicrotasks();
    clock.advance(15_000);
    await clock.flushMicrotasks();
    clock.advance(15_000);
    await clock.flushMicrotasks();
    expect(transitions.length).toBeGreaterThan(0);
    expect(await fs.readFile("/snap/health.json")).not.toBeNull();
    await s.stop();
  });

  test("onCompromised stops capture and reports error", async () => {
    const s = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    s.handleCompromised(new Error("stolen"));
    expect(s.getHealth(0)).toBe("error");
    await s.stop();
  });
});
