import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

describe("Snapshotter debounce", () => {
  test("50 rapid markDirty calls produce one flush at trailing edge", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const model = new SnapshotModel("test");
    const snap = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await snap.start();

    for (let i = 0; i < 50; i++) snap.markDirty();
    expect(fs.writes("/snap/state.json")).toBe(0);

    clock.advance(199);
    expect(fs.writes("/snap/state.json")).toBe(0);

    clock.advance(1);
    await clock.flushMicrotasks();
    expect(fs.writes("/snap/state.json")).toBe(1);

    await snap.stop();
  });

  test("markDirty after flush schedules a new flush", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const snap = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await snap.start();

    snap.markDirty();
    clock.advance(200);
    await clock.flushMicrotasks();
    expect(fs.writes("/snap/state.json")).toBe(1);

    snap.markDirty();
    clock.advance(200);
    await clock.flushMicrotasks();
    expect(fs.writes("/snap/state.json")).toBe(2);

    await snap.stop();
  });

  test("flushNow bypasses debounce", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const snap = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await snap.start();

    snap.markDirty();
    await snap.flushNow();
    expect(fs.writes("/snap/state.json")).toBe(1);

    await snap.stop();
  });
});
