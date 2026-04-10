import { describe, test, expect } from "bun:test";
import { parseSessionListOutput, validateSessionCreate } from "../../cli/session";

describe("parseSessionListOutput", () => {
  test("parses list-sessions format string output", () => {
    const lines = [
      "$1:my-project:1712678400:1:3:0:/Users/jarred/Code/project",
      "$2:other:1712678300:0:1:1:/Users/jarred/Code/other",
    ];
    const sessions = parseSessionListOutput(lines);
    expect(sessions).toEqual([
      { id: "$1", name: "my-project", activity: 1712678400, attached: true, windows: 3, attention: false, path: "/Users/jarred/Code/project" },
      { id: "$2", name: "other", activity: 1712678300, attached: false, windows: 1, attention: true, path: "/Users/jarred/Code/other" },
    ]);
  });

  test("handles empty output", () => {
    expect(parseSessionListOutput([])).toEqual([]);
  });

  test("handles path with colons", () => {
    const lines = ["$1:test:100:1:1:0:C:\\Users\\test"];
    const sessions = parseSessionListOutput(lines);
    expect(sessions[0].path).toBe("C:\\Users\\test");
  });
});

describe("validateSessionCreate", () => {
  test("requires --name", () => {
    expect(() => validateSessionCreate({ dir: "/tmp" })).toThrow("--name is required");
  });

  test("requires --dir", () => {
    expect(() => validateSessionCreate({ name: "foo" })).toThrow("--dir is required");
  });

  test("returns sanitized name", () => {
    const result = validateSessionCreate({ name: "foo.bar", dir: "/tmp" });
    expect(result.name).toBe("foo_bar");
    expect(result.dir).toBe("/tmp");
  });

  test("passes through command", () => {
    const result = validateSessionCreate({ name: "test", dir: "/tmp", command: "vim" });
    expect(result.command).toBe("vim");
  });
});

describe("validateSessionCreate with worktree", () => {
  test("worktree requires --base-branch", () => {
    expect(() =>
      validateSessionCreate({ name: "foo", dir: "/tmp/repo", worktree: true })
    ).toThrow("--base-branch");
  });

  test("worktree returns baseBranch", () => {
    const result = validateSessionCreate({
      name: "foo",
      dir: "/tmp/repo",
      worktree: true,
      "base-branch": "origin/main",
    });
    expect(result.worktree).toBe(true);
    expect(result.baseBranch).toBe("origin/main");
  });

  test("non-worktree does not require base-branch", () => {
    const result = validateSessionCreate({ name: "foo", dir: "/tmp" });
    expect(result.worktree).toBeUndefined();
    expect(result.baseBranch).toBeUndefined();
  });
});
