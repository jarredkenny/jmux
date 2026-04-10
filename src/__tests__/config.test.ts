import { describe, test, expect } from "bun:test";
import { sanitizeTmuxSessionName, buildOtelResourceAttrs, loadUserConfig } from "../config";

describe("sanitizeTmuxSessionName", () => {
  test("replaces dots with underscores", () => {
    expect(sanitizeTmuxSessionName("my.project")).toBe("my_project");
  });

  test("replaces colons with underscores", () => {
    expect(sanitizeTmuxSessionName("my:project")).toBe("my_project");
  });

  test("replaces mixed dots and colons", () => {
    expect(sanitizeTmuxSessionName("a.b:c.d")).toBe("a_b_c_d");
  });

  test("leaves clean names unchanged", () => {
    expect(sanitizeTmuxSessionName("my-project")).toBe("my-project");
    expect(sanitizeTmuxSessionName("myproject")).toBe("myproject");
    expect(sanitizeTmuxSessionName("my_project")).toBe("my_project");
  });

  test("handles empty string", () => {
    expect(sanitizeTmuxSessionName("")).toBe("");
  });
});

describe("buildOtelResourceAttrs", () => {
  test("returns correct format", () => {
    expect(buildOtelResourceAttrs("my-session")).toBe("tmux_session_name=my-session");
  });

  test("includes sanitized session name as-is", () => {
    expect(buildOtelResourceAttrs("my_project")).toBe("tmux_session_name=my_project");
  });
});

describe("loadUserConfig", () => {
  test("returns empty object for nonexistent path", () => {
    expect(loadUserConfig("/nonexistent/path/config.json")).toEqual({});
  });

  test("returns empty object for directory that does not exist", () => {
    expect(loadUserConfig("/tmp/__jmux_does_not_exist__/config.json")).toEqual({});
  });
});
