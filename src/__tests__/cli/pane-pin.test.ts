import { describe, test, expect } from "bun:test";
import { buildPinCommands, parsePinnedListOutput } from "../../cli/pane";

describe("buildPinCommands", () => {
  test("pin sets the per-pane @jmux-pinned option", () => {
    expect(buildPinCommands("pin", "%7")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "@jmux-pinned", "1"], required: true },
    ]);
  });

  test("unpin unsets the per-pane option with -u", () => {
    expect(buildPinCommands("unpin", "%7")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "-u", "@jmux-pinned"], required: true },
    ]);
  });
});

describe("parsePinnedListOutput", () => {
  test("returns only pane ids whose value is exactly '1'", () => {
    const lines = ["%1:1", "%2:", "%3:1", "%4:0"];
    expect(parsePinnedListOutput(lines)).toEqual(["%1", "%3"]);
  });

  test("ignores blank lines", () => {
    expect(parsePinnedListOutput(["", "%9:1", ""])).toEqual(["%9"]);
  });
});
