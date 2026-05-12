import { describe, test, expect } from "bun:test";
import { TmuxControl, type ControlSpawner, type ControlProcess } from "../../tmux-control";
import { FakeClock } from "./helpers";

class FakeProcess implements ControlProcess {
  private dataListeners: Array<(s: string) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];
  alive = true;

  onData(fn: (s: string) => void): void {
    this.dataListeners.push(fn);
  }

  onExit(fn: (code: number) => void): void {
    this.exitListeners.push(fn);
  }

  emitData(s: string): void {
    for (const l of this.dataListeners) l(s);
  }

  emitExit(code = 0): void {
    this.alive = false;
    for (const l of this.exitListeners) l(code);
  }

  write(_: string): void {}
  kill(): void {
    this.emitExit(0);
  }
}

class FakeSpawner implements ControlSpawner {
  spawned: FakeProcess[] = [];
  spawn(): ControlProcess {
    const p = new FakeProcess();
    this.spawned.push(p);
    return p;
  }
}

describe("TmuxControl reconnect", () => {
  test("EOF triggers backoff reconnect via Clock", async () => {
    const clock = new FakeClock();
    const spawner = new FakeSpawner();
    const ctrl = new TmuxControl({
      socketName: "",
      spawner,
      clock,
      reconnectInitialMs: 250,
      reconnectMaxMs: 5000,
      reconnectGiveUpMs: 30000,
    });
    let reconnected = 0;
    ctrl.onReconnected(() => reconnected++);
    await ctrl.start();
    expect(spawner.spawned.length).toBe(1);

    spawner.spawned[0].emitExit();
    clock.advance(250);
    await clock.flushMicrotasks();
    expect(spawner.spawned.length).toBe(2);
    expect(reconnected).toBe(1);
  });

  test("backoff doubles up to cap", async () => {
    const clock = new FakeClock();
    const spawner = new FakeSpawner();
    const ctrl = new TmuxControl({
      socketName: "",
      spawner,
      clock,
      reconnectInitialMs: 100,
      reconnectMaxMs: 400,
      reconnectGiveUpMs: 30000,
    });
    await ctrl.start();

    spawner.spawned[0].emitExit();
    clock.advance(100);
    await clock.flushMicrotasks();
    expect(spawner.spawned.length).toBe(2);
    spawner.spawned[1].emitExit();
    clock.advance(200);
    await clock.flushMicrotasks();
    expect(spawner.spawned.length).toBe(3);
    spawner.spawned[2].emitExit();
    clock.advance(400);
    await clock.flushMicrotasks();
    expect(spawner.spawned.length).toBe(4);
    spawner.spawned[3].emitExit();
    clock.advance(400);
    await clock.flushMicrotasks();
    expect(spawner.spawned.length).toBe(5);
  });

  test("give-up fires lost event after total elapsed > giveUpMs", async () => {
    const clock = new FakeClock();
    const spawner = new FakeSpawner();
    const ctrl = new TmuxControl({
      socketName: "",
      spawner,
      clock,
      reconnectInitialMs: 100,
      reconnectMaxMs: 100,
      reconnectGiveUpMs: 500,
    });
    let lost = false;
    ctrl.onLost(() => {
      lost = true;
    });
    await ctrl.start();

    // Drive reconnects until lost fires or we run out of patience.
    // With giveUpMs=500 and 100ms intervals, lost fires after ~6 exits.
    for (let i = 0; i < 20; i++) {
      if (lost) break;
      const proc = spawner.spawned[i];
      if (!proc) break;
      proc.emitExit();
      clock.advance(100);
      await clock.flushMicrotasks();
    }
    expect(lost).toBe(true);
  });
});
