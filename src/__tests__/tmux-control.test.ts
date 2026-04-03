import { describe, test, expect } from "bun:test";
import { ControlParser, type ControlEvent } from "../tmux-control";

describe("ControlParser", () => {
  test("emits sessions-changed notification", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%sessions-changed\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("sessions-changed");
  });

  test("emits session-changed notification", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%session-changed $3\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("session-changed");
    expect(events[0].args).toBe("$3");
  });

  test("collects response block between %begin and %end", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%begin 1234 1 0\n");
    parser.feed("line one\n");
    parser.feed("line two\n");
    parser.feed("%end 1234 1 0\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("response");
    expect(events[0].commandNumber).toBe(1);
    expect(events[0].lines).toEqual(["line one", "line two"]);
  });

  test("emits error response on %error", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%begin 1234 2 0\n");
    parser.feed("something bad\n");
    parser.feed("%error 1234 2 0\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    expect(events[0].commandNumber).toBe(2);
    expect(events[0].lines).toEqual(["something bad"]);
  });

  test("emits subscription-changed notification", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%subscription-changed attention main=1 dev=\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("subscription-changed");
    expect(events[0].name).toBe("attention");
    expect(events[0].value).toBe("main=1 dev=");
  });

  test("handles partial lines across multiple feeds", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%sessions");
    expect(events.length).toBe(0);
    parser.feed("-changed\n");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("sessions-changed");
  });

  test("handles multiple lines in single feed", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%sessions-changed\n%session-changed $1\n");

    expect(events.length).toBe(2);
    expect(events[0].type).toBe("sessions-changed");
    expect(events[1].type).toBe("session-changed");
  });

  test("emits window-renamed notification", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%window-renamed @0 bash\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("window-renamed");
    expect(events[0].args).toBe("@0 bash");
  });
});
