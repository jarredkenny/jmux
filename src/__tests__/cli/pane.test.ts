import { describe, test, expect } from "bun:test";
import { parsePaneListOutput } from "../../cli/pane";

describe("parsePaneListOutput", () => {
  test("parses list-panes format string output", () => {
    const lines = [
      "%5:@1:1:120:40:claude:/Users/jarred/Code/project",
      "%6:@1:0:120:40:zsh:/Users/jarred/Code/project",
    ];
    const panes = parsePaneListOutput(lines);
    expect(panes).toEqual([
      { id: "%5", window: "@1", active: true, width: 120, height: 40, command: "claude", path: "/Users/jarred/Code/project" },
      { id: "%6", window: "@1", active: false, width: 120, height: 40, command: "zsh", path: "/Users/jarred/Code/project" },
    ]);
  });

  test("handles empty output", () => {
    expect(parsePaneListOutput([])).toEqual([]);
  });

  test("handles path with colons", () => {
    const lines = ["%1:@1:1:80:24:bash:C:\\Users\\test"];
    const panes = parsePaneListOutput(lines);
    expect(panes[0].path).toBe("C:\\Users\\test");
  });

  test("filters blank lines", () => {
    const lines = ["", "%2:@2:0:80:24:zsh:/home/user", ""];
    const panes = parsePaneListOutput(lines);
    expect(panes).toHaveLength(1);
  });

  test("active flag is false when field is 0", () => {
    const lines = ["%3:@1:0:80:24:vim:/tmp"];
    const panes = parsePaneListOutput(lines);
    expect(panes[0].active).toBe(false);
  });

  test("parses width and height as integers", () => {
    const lines = ["%4:@3:1:200:50:bash:/var"];
    const panes = parsePaneListOutput(lines);
    expect(panes[0].width).toBe(200);
    expect(panes[0].height).toBe(50);
  });

  test("handles unix path that starts with colon-less root", () => {
    const lines = ["%7:@2:1:120:40:node:/project/src"];
    const panes = parsePaneListOutput(lines);
    expect(panes[0].id).toBe("%7");
    expect(panes[0].command).toBe("node");
    expect(panes[0].path).toBe("/project/src");
  });
});
