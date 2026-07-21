// Stdin capture gate.
//
// jmux enters raw mode and resumes stdin early in startup (see main.ts), but the
// interactive input pipeline (InputRouter) isn't constructed until well after an
// `await performBoot`. Bun discards data that arrives on a resumed stream with no
// `data` listener, so a fast-replying terminal's OSC 11 background answer — sent
// in response to the startup query — was lost in that window, leaving chrome on
// the hardcoded dark fallback theme.
//
// StdinGate closes that window: a single listener is attached before the query,
// so nothing is dropped. The terminal background is resolved the instant its
// reply arrives (even before the pipeline is ready), while ordinary keystrokes
// are buffered and replayed in order once markReady() is called.

import { scanForOsc11, type RGB } from "./theme";

export interface StdinGateHooks {
  /** Called once, when the terminal's OSC 11 background reply is resolved. */
  onBackground: (rgb: RGB) => void;
  /** Forwarded input bytes (reply peeled off). Only called once ready. */
  onInput: (str: string) => void;
}

export class StdinGate {
  private pending = ""; // carry-over for an OSC 11 reply split across chunks
  private resolved = false;
  private ready = false;
  private queue: string[] = [];

  constructor(private readonly hooks: StdinGateHooks) {}

  /** Feed one raw stdin chunk. */
  feed(chunk: string): void {
    let str = chunk;
    if (!this.resolved) {
      const scan = scanForOsc11(this.pending, str);
      this.pending = scan.pending;
      if (scan.rgb) {
        this.resolved = true;
        this.hooks.onBackground(scan.rgb);
      }
      if (scan.forward === null) return; // holding a split reply
      str = scan.forward;
    }
    if (str.length === 0) return;
    if (this.ready) {
      this.hooks.onInput(str);
    } else {
      this.queue.push(str);
    }
  }

  /**
   * Re-arm background detection so the next OSC 11 reply is captured again.
   * Used for live theme changes: jmux re-queries the terminal, and the reply
   * to that fresh query must be resolved even though one was already resolved
   * at startup. Discards any half-received split reply from the previous scan.
   */
  rearm(): void {
    this.resolved = false;
    this.pending = "";
  }

  /** Open the gate: flush buffered input and forward everything from now on. */
  markReady(): void {
    if (this.ready) return;
    this.ready = true;
    if (this.queue.length > 0) {
      const buffered = this.queue.join("");
      this.queue.length = 0;
      if (buffered.length > 0) this.hooks.onInput(buffered);
    }
  }
}
