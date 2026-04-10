import { describe, test, expect } from "bun:test";
import { InputLine } from "../agent-tab";

describe("InputLine", () => {
  test("starts empty", () => {
    const line = new InputLine();
    expect(line.text).toBe("");
    expect(line.cursor).toBe(0);
  });

  test("insert adds characters at cursor", () => {
    const line = new InputLine();
    line.insert("h");
    line.insert("i");
    expect(line.text).toBe("hi");
    expect(line.cursor).toBe(2);
  });

  test("backspace deletes before cursor", () => {
    const line = new InputLine();
    line.insert("abc");
    line.backspace();
    expect(line.text).toBe("ab");
    expect(line.cursor).toBe(2);
  });

  test("backspace at start does nothing", () => {
    const line = new InputLine();
    line.backspace();
    expect(line.text).toBe("");
  });

  test("left/right move cursor", () => {
    const line = new InputLine();
    line.insert("abc");
    line.left();
    expect(line.cursor).toBe(2);
    line.left();
    expect(line.cursor).toBe(1);
    line.right();
    expect(line.cursor).toBe(2);
  });

  test("home/end move to boundaries", () => {
    const line = new InputLine();
    line.insert("abc");
    line.home();
    expect(line.cursor).toBe(0);
    line.end();
    expect(line.cursor).toBe(3);
  });

  test("submit returns text and clears", () => {
    const line = new InputLine();
    line.insert("hello world");
    const text = line.submit();
    expect(text).toBe("hello world");
    expect(line.text).toBe("");
    expect(line.cursor).toBe(0);
  });

  test("delete removes character at cursor", () => {
    const line = new InputLine();
    line.insert("abc");
    line.home();
    line.del();
    expect(line.text).toBe("bc");
    expect(line.cursor).toBe(0);
  });

  test("insert in middle pushes text right", () => {
    const line = new InputLine();
    line.insert("ac");
    line.left();
    line.insert("b");
    expect(line.text).toBe("abc");
    expect(line.cursor).toBe(2);
  });
});

import { ScrollbackBuffer, type ChatMessage } from "../agent-tab";

describe("ScrollbackBuffer", () => {
  test("starts empty", () => {
    const buf = new ScrollbackBuffer();
    expect(buf.messages).toEqual([]);
  });

  test("addUserMessage appends user message", () => {
    const buf = new ScrollbackBuffer();
    buf.addUserMessage("hello");
    expect(buf.messages).toHaveLength(1);
    expect(buf.messages[0]).toEqual({ role: "user", content: "hello" });
  });

  test("addAssistantMessage appends assistant message", () => {
    const buf = new ScrollbackBuffer();
    buf.addAssistantMessage("hi back");
    expect(buf.messages).toHaveLength(1);
    expect(buf.messages[0]).toEqual({ role: "assistant", content: "hi back" });
  });

  test("addToolUse appends tool indicator", () => {
    const buf = new ScrollbackBuffer();
    buf.addToolUse("jmux ctl task create --ticket X-1");
    expect(buf.messages).toHaveLength(1);
    expect(buf.messages[0]).toEqual({ role: "tool", content: "jmux ctl task create --ticket X-1" });
  });

  test("appendToLast extends last assistant message", () => {
    const buf = new ScrollbackBuffer();
    buf.addAssistantMessage("hel");
    buf.appendToLast("lo");
    expect(buf.messages[0].content).toBe("hello");
  });

  test("getContextSummary returns last N exchanges", () => {
    const buf = new ScrollbackBuffer();
    buf.addUserMessage("msg1");
    buf.addAssistantMessage("resp1");
    buf.addUserMessage("msg2");
    buf.addAssistantMessage("resp2");
    buf.addUserMessage("msg3");
    buf.addAssistantMessage("resp3");
    const summary = buf.getContextSummary(2); // last 2 exchanges
    expect(summary).toHaveLength(4); // 2 user + 2 assistant
    expect(summary[0].content).toBe("msg2");
  });

  test("renderToLines wraps text to width", () => {
    const buf = new ScrollbackBuffer();
    buf.addUserMessage("hello world this is a long message");
    const lines = buf.renderToLines(20);
    // "you: " prefix + text = wrapping at 20 cols
    expect(lines.length).toBeGreaterThan(1);
  });
});
