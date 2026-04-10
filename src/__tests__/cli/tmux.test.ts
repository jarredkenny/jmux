import { describe, test, expect } from "bun:test";
import { parseTmuxSocket } from "../../cli/tmux";

describe("parseTmuxSocket", () => {
  test("parses path from standard $TMUX value", () => {
    expect(parseTmuxSocket("/tmp/tmux-501/default,12345,0")).toBe("/tmp/tmux-501/default");
  });

  test("returns null for undefined", () => {
    expect(parseTmuxSocket(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseTmuxSocket("")).toBeNull();
  });
});
