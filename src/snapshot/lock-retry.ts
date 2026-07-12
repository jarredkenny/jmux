import type { Clock, FileSystem, Lock } from "./deps";

export interface LockRetrierOptions {
  fs: FileSystem;
  path: string;
  clock: Clock;
  intervalMs: number;
  /** Called once, with the acquired lock, the first time acquisition succeeds. */
  onAcquired: (lock: Lock) => void;
  /** Forwarded to the lock so a later compromise is observable. */
  onCompromised?: (err: Error) => void;
}

/**
 * Repeatedly attempts to acquire a lock until it succeeds, then hands the lock
 * to `onAcquired` and stops.
 *
 * Used when boot found the lock held. Boot decides lock ownership once, but a
 * held lock is not necessarily a live holder: an orphaned lock left by a crashed
 * instance looks "live" until it ages past the lock's stale window. Rather than
 * disable snapshotting for this process's whole lifetime, keep retrying so we
 * reclaim the lock once it goes stale (or a genuinely-live holder exits) and
 * start capturing then.
 */
export class LockRetrier {
  private cancel: (() => void) | null = null;
  private stopped = false;
  private busy = false;

  constructor(private readonly opts: LockRetrierOptions) {}

  start(): void {
    // Attempt immediately, then on the interval until acquired.
    void this.attempt();
    this.cancel = this.opts.clock.setInterval(
      () => void this.attempt(),
      this.opts.intervalMs,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.cancel) {
      this.cancel();
      this.cancel = null;
    }
  }

  private async attempt(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const res = await this.opts.fs.lock(this.opts.path, {
        onCompromised: this.opts.onCompromised,
      });
      if (res.ok) {
        // Stop before handing off so the interval is already cancelled.
        this.stop();
        this.opts.onAcquired(res.lock);
      }
    } finally {
      this.busy = false;
    }
  }
}
