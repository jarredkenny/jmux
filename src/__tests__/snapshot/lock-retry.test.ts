import { describe, test, expect } from "bun:test";
import { LockRetrier } from "../../snapshot/lock-retry";
import { FakeClock, FakeFs } from "./helpers";
import type { Lock } from "../../snapshot/deps";

describe("LockRetrier", () => {
  test("acquires immediately when the lock is free", async () => {
    const fs = new FakeFs();
    const clock = new FakeClock();
    let acquired: Lock | null = null;
    const r = new LockRetrier({
      fs,
      path: "/snap/.lock",
      clock,
      intervalMs: 5000,
      onAcquired: (l) => {
        acquired = l;
      },
    });
    r.start();
    await clock.flushMicrotasks();
    expect(acquired).not.toBeNull();
  });

  test("retries until the holder releases, then acquires", async () => {
    const fs = new FakeFs();
    fs.locks.add("/snap/.lock"); // held by someone else at boot
    const clock = new FakeClock();
    let acquired: Lock | null = null;
    const r = new LockRetrier({
      fs,
      path: "/snap/.lock",
      clock,
      intervalMs: 5000,
      onAcquired: (l) => {
        acquired = l;
      },
    });
    r.start();
    await clock.flushMicrotasks();
    expect(acquired).toBeNull(); // still held

    clock.advance(5000);
    await clock.flushMicrotasks();
    expect(acquired).toBeNull(); // still held

    fs.locks.delete("/snap/.lock"); // holder exits / lock goes stale
    clock.advance(5000);
    await clock.flushMicrotasks();
    expect(acquired).not.toBeNull(); // reclaimed
  });

  test("stop() halts further retries", async () => {
    const fs = new FakeFs();
    fs.locks.add("/snap/.lock");
    const clock = new FakeClock();
    let attempts = 0;
    const orig = fs.lock.bind(fs);
    fs.lock = async (p, o) => {
      attempts++;
      return orig(p, o);
    };
    const r = new LockRetrier({
      fs,
      path: "/snap/.lock",
      clock,
      intervalMs: 5000,
      onAcquired: () => {},
    });
    r.start();
    await clock.flushMicrotasks();
    const after1 = attempts;
    r.stop();
    clock.advance(20000);
    await clock.flushMicrotasks();
    expect(attempts).toBe(after1); // no attempts after stop
  });

  test("stops retrying once acquired (no further lock attempts)", async () => {
    const fs = new FakeFs();
    const clock = new FakeClock();
    let attempts = 0;
    const orig = fs.lock.bind(fs);
    fs.lock = async (p, o) => {
      attempts++;
      return orig(p, o);
    };
    const r = new LockRetrier({
      fs,
      path: "/snap/.lock",
      clock,
      intervalMs: 5000,
      onAcquired: () => {},
    });
    r.start();
    await clock.flushMicrotasks();
    expect(attempts).toBe(1);
    clock.advance(20000);
    await clock.flushMicrotasks();
    expect(attempts).toBe(1); // acquired on first try -> interval cancelled
  });
});
