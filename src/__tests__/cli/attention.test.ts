import { describe, test, expect } from "bun:test";
import { buildAttentionCommands } from "../../cli/session";

describe("buildAttentionCommands", () => {
  test("set with a reason sets both options as required", () => {
    const cmds = buildAttentionCommands("set", "TRA-1", "ci failed");
    expect(cmds).toEqual([
      { args: ["set-option", "-t", "TRA-1", "@jmux-attention", "1"], required: true },
      {
        args: ["set-option", "-t", "TRA-1", "@jmux-attention-reason", "ci failed"],
        required: true,
      },
    ]);
  });

  test("set without a reason clears any stale reason (optional)", () => {
    const cmds = buildAttentionCommands("set", "TRA-1", null);
    expect(cmds[0].args).toEqual(["set-option", "-t", "TRA-1", "@jmux-attention", "1"]);
    expect(cmds[1]).toEqual({
      args: ["set-option", "-t", "TRA-1", "-u", "@jmux-attention-reason"],
      required: false,
    });
  });

  test("clear unsets both options; only the flag itself is required", () => {
    const cmds = buildAttentionCommands("clear", "TRA-1", null);
    expect(cmds).toEqual([
      { args: ["set-option", "-t", "TRA-1", "-u", "@jmux-attention"], required: true },
      {
        args: ["set-option", "-t", "TRA-1", "-u", "@jmux-attention-reason"],
        required: false,
      },
    ]);
  });

  test("rejects an unknown verb", () => {
    expect(() => buildAttentionCommands("bogus", "TRA-1", null)).toThrow();
  });
});
