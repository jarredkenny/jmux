import { describe, test, expect } from "bun:test";
import {
  buildPinCommands, parsePinnedListOutput, parsePinnedListWithTab,
} from "../../cli/pane";

describe("buildPinCommands", () => {
  test("pin with no tab writes the legacy default value '1'", () => {
    expect(buildPinCommands("pin", "%7")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "@jmux-pinned", "1"], required: true },
    ]);
  });

  test("pin with a tab id writes that id", () => {
    expect(buildPinCommands("pin", "%7", "backend")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "@jmux-pinned", "backend"], required: true },
    ]);
  });

  test("unpin unsets the per-pane option with -u", () => {
    expect(buildPinCommands("unpin", "%7")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "-u", "@jmux-pinned"], required: true },
    ]);
  });
});

describe("parsePinnedListOutput", () => {
  test("returns pane ids with any non-empty value", () => {
    const lines = ["%1:1", "%2:", "%3:backend"];
    expect(parsePinnedListOutput(lines)).toEqual(["%1", "%3"]);
  });
  test("ignores blank lines", () => {
    expect(parsePinnedListOutput(["", "%9:1", ""])).toEqual(["%9"]);
  });
});

describe("parsePinnedListWithTab", () => {
  test("returns pane id + raw tab value for non-empty entries", () => {
    const lines = ["%1:1", "%2:", "%3:backend"];
    expect(parsePinnedListWithTab(lines)).toEqual([
      { id: "%1", tab: "1" },
      { id: "%3", tab: "backend" },
    ]);
  });
});
