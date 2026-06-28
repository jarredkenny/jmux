import { describe, test, expect } from "bun:test";
import { US, splitFields } from "../tmux-fields";

describe("splitFields", () => {
  test("splits on the raw US byte (tmux 3.6 passes it through)", () => {
    expect(splitFields(["$1", "name", "running"].join(US))).toEqual([
      "$1",
      "name",
      "running",
    ]);
  });

  test("splits on tmux 3.4's octal-escaped separator (\\037)", () => {
    // tmux 3.4 emits the 4 literal chars `\037` in place of the raw 0x1F byte.
    const line = "$1\\037name\\037running";
    expect(splitFields(line)).toEqual(["$1", "name", "running"]);
  });

  test("handles a line that mixes both forms", () => {
    expect(splitFields("$1\\037name\x1frunning")).toEqual([
      "$1",
      "name",
      "running",
    ]);
  });

  test("preserves empty fields (unset tmux options render as '')", () => {
    expect(splitFields("$1\\037\\037running")).toEqual(["$1", "", "running"]);
    expect(splitFields("$1\x1f\x1frunning")).toEqual(["$1", "", "running"]);
  });

  test("a value with no separator returns a single field", () => {
    expect(splitFields("$1")).toEqual(["$1"]);
  });
});
