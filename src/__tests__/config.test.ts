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

describe("loadUserConfig adapter config", () => {
  test("parses adapter config from valid JSON", () => {
    const tmpPath = `/tmp/jmux-test-config-${Date.now()}.json`;
    const config = {
      sidebarWidth: 30,
      adapters: {
        codeHost: { type: "gitlab" },
        issueTracker: { type: "linear" },
      },
    };
    require("fs").writeFileSync(tmpPath, JSON.stringify(config));
    const result = loadUserConfig(tmpPath);
    expect(result.adapters).toBeDefined();
    expect(result.adapters!.codeHost!.type).toBe("gitlab");
    expect(result.adapters!.issueTracker!.type).toBe("linear");
    require("fs").unlinkSync(tmpPath);
  });

  test("returns undefined adapters when not configured", () => {
    const tmpPath = `/tmp/jmux-test-config-${Date.now()}.json`;
    require("fs").writeFileSync(tmpPath, JSON.stringify({ sidebarWidth: 26 }));
    const result = loadUserConfig(tmpPath);
    expect(result.adapters).toBeUndefined();
    require("fs").unlinkSync(tmpPath);
  });
});
