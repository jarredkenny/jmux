import { describe, test, expect } from "bun:test";
import { buildTmuxArgs, parseTmuxSocket } from "../../cli/tmux";

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

describe("buildTmuxArgs", () => {
  test("basic command without socket", () => {
    expect(buildTmuxArgs("list-sessions", null)).toEqual(["list-sessions"]);
  });

  test("command with socket name uses -L", () => {
    expect(buildTmuxArgs("list-sessions", "work")).toEqual(["-L", "work", "list-sessions"]);
  });

  test("command with socket path uses -S", () => {
    expect(buildTmuxArgs("list-sessions", "/tmp/tmux-501/default")).toEqual([
      "-S",
      "/tmp/tmux-501/default",
      "list-sessions",
    ]);
  });
});
