import { describe, test, expect } from "bun:test";
import { parseWindowListOutput } from "../../cli/window";

describe("parseWindowListOutput", () => {
  test("parses list-windows format string output", () => {
    const lines = [
      "@1:0:editor:1:0:0",
      "@2:1:claude:0:1:0",
    ];
    const windows = parseWindowListOutput(lines);
    expect(windows).toEqual([
      { id: "@1", index: 0, name: "editor", active: true, bell: false, zoomed: false },
      { id: "@2", index: 1, name: "claude", active: false, bell: true, zoomed: false },
    ]);
  });

  test("handles empty output", () => {
    expect(parseWindowListOutput([])).toEqual([]);
  });

  test("parses zoomed flag", () => {
    const lines = ["@3:2:scratch:0:0:1"];
    const windows = parseWindowListOutput(lines);
    expect(windows).toEqual([
      { id: "@3", index: 2, name: "scratch", active: false, bell: false, zoomed: true },
    ]);
  });

  test("parses active window with no bell or zoom", () => {
    const lines = ["@5:0:main:1:0:0"];
    const windows = parseWindowListOutput(lines);
    expect(windows[0].active).toBe(true);
    expect(windows[0].bell).toBe(false);
    expect(windows[0].zoomed).toBe(false);
    expect(windows[0].index).toBe(0);
  });

  test("filters blank lines", () => {
    const lines = ["", "@1:0:editor:1:0:0", ""];
    const windows = parseWindowListOutput(lines);
    expect(windows).toHaveLength(1);
  });
});
