import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs } from "./helpers";
import type { TmuxRunResult, TmuxRunner } from "../../snapshot/deps";

// A runner whose FIRST list-sessions call blocks on a gate we open manually,
// so we can deterministically drive a re-entrant onSessionsChanged() and prove
// the two calls never run the derive body concurrently.
class GatedRunner implements TmuxRunner {
  invocations: string[][] = [];
  private concurrent = 0;
  maxConcurrent = 0;
  private gate: Promise<void>;
  private release!: () => void;
  private gateActive = true;

  constructor() {
    this.gate = new Promise<void>((r) => (this.release = r));
  }
  openGate(): void {
    this.release();
  }
  listSessionCalls(): number {
    return this.invocations.filter((a) => a[0] === "list-sessions").length;
  }

  async run(args: string[]): Promise<TmuxRunResult> {
    this.invocations.push([...args]);
    if (args[0] === "list-sessions" && this.gateActive) {
      this.concurrent++;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
      await this.gate;
      this.concurrent--;
      this.gateActive = false; // only the first wave is gated
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("Snapshotter onSessionsChanged reentrancy", () => {
  test("a concurrent call coalesces into a trailing re-run, never interleaves", async () => {
    const runner = new GatedRunner();
    const s = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs: new FakeFs(),
      runner,
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();

    // p1 runs synchronously up to `await gate` inside list-sessions.
    const p1 = s.onSessionsChanged();
    // p2 sees topologyBusy and must return immediately (coalesced, not concurrent).
    const p2 = s.onSessionsChanged();
    await p2;
    expect(runner.maxConcurrent).toBe(1);

    runner.openGate();
    await p1;

    // The coalesced call triggers exactly one trailing re-run: 2 list-sessions total.
    expect(runner.listSessionCalls()).toBe(2);
    expect(runner.maxConcurrent).toBe(1);
    await s.stop();
  });
});
