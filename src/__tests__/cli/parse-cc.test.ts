import { describe, test, expect } from "bun:test";
import { parseCtlArgs } from "../../cli";

describe("parseCtlArgs — cc group and --tab flag", () => {
  test("cc tabs parses as group=cc action=tabs", () => {
    expect(parseCtlArgs(["cc", "tabs"])).toEqual({
      group: "cc", action: "tabs", flags: {}, positional: [],
    });
  });

  test("--tab captures a value (not a boolean, no stray positional)", () => {
    const parsed = parseCtlArgs(["pane", "pin", "--tab", "backend", "--target", "%7"]);
    expect(parsed.group).toBe("pane");
    expect(parsed.action).toBe("pin");
    expect(parsed.flags.tab).toBe("backend");
    expect(parsed.flags.target).toBe("%7");
    expect(parsed.positional).toEqual([]);
  });
});
