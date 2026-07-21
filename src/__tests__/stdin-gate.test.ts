import { describe, test, expect } from "bun:test";
import { StdinGate } from "../stdin-gate";
import type { RGB } from "../theme";

function collector() {
  const backgrounds: RGB[] = [];
  const input: string[] = [];
  const gate = new StdinGate({
    onBackground: (rgb) => backgrounds.push(rgb),
    onInput: (str) => input.push(str),
  });
  return { gate, backgrounds, input };
}

const REPLY = "\x1b]11;rgb:fafa/fafa/fafa\x07";

describe("StdinGate — background detection before the pipeline is ready", () => {
  test("resolves the OSC 11 background even while input is still gated", () => {
    // This is the regression: main.ts resumes stdin before the input handler is
    // ready, so the reply must be caught the moment it arrives, not dropped.
    const { gate, backgrounds } = collector();
    gate.feed(REPLY);
    expect(backgrounds).toEqual([{ r: 0xfa, g: 0xfa, b: 0xfa }]);
  });

  test("fires onBackground exactly once", () => {
    const { gate, backgrounds } = collector();
    gate.feed(REPLY);
    gate.feed(REPLY); // a stray second reply must not re-fire
    expect(backgrounds).toHaveLength(1);
  });

  test("reassembles a reply split across two chunks", () => {
    const { gate, backgrounds } = collector();
    gate.feed("\x1b]11;rgb:1616/1b1b/22");
    expect(backgrounds).toHaveLength(0); // waiting for the rest
    gate.feed("22\x07");
    expect(backgrounds).toEqual([{ r: 0x16, g: 0x1b, b: 0x22 }]);
  });
});

describe("StdinGate — re-arming for live theme changes", () => {
  test("ignores a second reply until re-armed, then captures the new background", () => {
    const { gate, backgrounds } = collector();
    gate.markReady();
    gate.feed(REPLY); // {fa,fa,fa}
    expect(backgrounds).toHaveLength(1);

    // A stray reply without re-arming is treated as ordinary input, not detection.
    gate.feed("\x1b]11;rgb:1111/1111/1111\x07");
    expect(backgrounds).toHaveLength(1);

    // Re-arm (as a live re-query would) and the next reply is detected.
    gate.rearm();
    gate.feed("\x1b]11;rgb:2222/2222/2222\x07");
    expect(backgrounds).toHaveLength(2);
    expect(backgrounds[1]).toEqual({ r: 0x22, g: 0x22, b: 0x22 });
  });

  test("re-arm clears a half-received split reply so it can't corrupt the next scan", () => {
    const { gate, backgrounds } = collector();
    gate.feed("\x1b]11;rgb:1616/1b1b/22"); // partial, held
    gate.rearm();
    gate.feed("\x1b]11;rgb:3030/3030/3030\x07"); // a fresh, complete reply
    expect(backgrounds).toEqual([{ r: 0x30, g: 0x30, b: 0x30 }]);
  });
});

describe("StdinGate — input buffering until ready", () => {
  test("queues keystrokes that arrive before markReady, then flushes in order", () => {
    const { gate, input } = collector();
    gate.feed("ab");
    gate.feed("cd");
    expect(input).toEqual([]); // nothing dispatched yet
    gate.markReady();
    expect(input.join("")).toBe("abcd");
  });

  test("dispatches input immediately once ready", () => {
    const { gate, input } = collector();
    gate.markReady();
    gate.feed("xyz");
    expect(input).toEqual(["xyz"]);
  });

  test("peels the reply out of a chunk and still forwards the surrounding bytes", () => {
    const { gate, backgrounds, input } = collector();
    gate.markReady();
    gate.feed(`before${REPLY}after`);
    expect(backgrounds).toEqual([{ r: 0xfa, g: 0xfa, b: 0xfa }]);
    expect(input.join("")).toBe("beforeafter");
  });

  test("does not forward the reply itself as input", () => {
    const { gate, input } = collector();
    gate.markReady();
    gate.feed(REPLY);
    expect(input.join("")).toBe("");
  });

  test("markReady is idempotent and does not replay the queue twice", () => {
    const { gate, input } = collector();
    gate.feed("hi");
    gate.markReady();
    gate.markReady();
    expect(input.join("")).toBe("hi");
  });
});
