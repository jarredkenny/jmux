import { describe, test, expect } from "bun:test";
import { Snapshotter, resolveSnapshotDir } from "../../snapshot";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

describe("snapshot multi-socket isolation", () => {
  test("two Snapshotters with different dirs operate independently", async () => {
    const fs = new FakeFs();
    const s1 = new Snapshotter({
      dir: "/snap/work",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 100,
      scrollbackIntervalMs: 5000,
    });
    const s2 = new Snapshotter({
      dir: "/snap/play",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 100,
      scrollbackIntervalMs: 5000,
    });
    await s1.start();
    await s2.start();
    expect(s1.isDegraded()).toBe(false);
    expect(s2.isDegraded()).toBe(false);
    expect(fs.locks.has("/snap/work/.lock")).toBe(true);
    expect(fs.locks.has("/snap/play/.lock")).toBe(true);
    await s1.stop();
    await s2.stop();
  });
});

describe("resolveSnapshotDir", () => {
  test("uses override when provided", () => {
    expect(
      resolveSnapshotDir({
        override: "/custom",
        socketName: null,
        xdgDataHome: null,
        home: "/home/u",
      }),
    ).toBe("/custom");
  });

  test("uses XDG_DATA_HOME with socket name", () => {
    expect(
      resolveSnapshotDir({
        override: null,
        socketName: "work",
        xdgDataHome: "/home/u/.local/share",
        home: "/home/u",
      }),
    ).toBe("/home/u/.local/share/jmux/snapshot/work");
  });

  test("default socket gets 'default' subdir", () => {
    expect(
      resolveSnapshotDir({
        override: null,
        socketName: null,
        xdgDataHome: null,
        home: "/home/u",
      }),
    ).toBe("/home/u/.local/share/jmux/snapshot/default");
  });

  test("empty string socket name treated as default", () => {
    expect(
      resolveSnapshotDir({
        override: null,
        socketName: "",
        xdgDataHome: null,
        home: "/home/u",
      }),
    ).toBe("/home/u/.local/share/jmux/snapshot/default");
  });
});
