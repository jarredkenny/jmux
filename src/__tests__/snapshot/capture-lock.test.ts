import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

describe("Snapshotter lock", () => {
  test("acquires lock on start and releases on stop", async () => {
    const fs = new FakeFs();
    const s = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    expect(fs.locks.has("/snap/.lock")).toBe(true);
    await s.stop();
    expect(fs.locks.has("/snap/.lock")).toBe(false);
  });

  test("second Snapshotter on same dir runs in degraded mode", async () => {
    const fs = new FakeFs();
    const s1 = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s1.start();
    const s2 = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s2.start();
    expect(s2.isDegraded()).toBe(true);
    s2.markDirty();
    await s2.flushNow();
    // No write should have occurred in degraded mode
    expect(fs.writes("/snap/state.json")).toBe(0);
    await s1.stop();
    await s2.stop();
  });

  test("degraded reason is exposed", async () => {
    const fs = new FakeFs();
    fs.locks.add("/snap/.lock");
    const s = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    expect(s.degradedReason()).toBe("lock_held");
    await s.stop();
  });

  test("graceful shutdown flushes pending dirty state", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const s = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    s.markDirty();
    expect(fs.writes("/snap/state.json")).toBe(0);
    // stop() should flush before the debounce fires
    await s.stop();
    expect(fs.writes("/snap/state.json")).toBe(1);
  });

  test("graceful shutdown does NOT flush if not dirty", async () => {
    const fs = new FakeFs();
    const s = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    await s.stop();
    expect(fs.writes("/snap/state.json")).toBe(0);
  });
});
