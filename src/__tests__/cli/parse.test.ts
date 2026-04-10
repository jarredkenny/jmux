import { describe, test, expect } from "bun:test";
import { parseCtlArgs } from "../../cli";

describe("parseCtlArgs", () => {
  test("parses session list", () => {
    const result = parseCtlArgs(["session", "list"]);
    expect(result.group).toBe("session");
    expect(result.action).toBe("list");
    expect(result.flags).toEqual({});
    expect(result.positional).toEqual([]);
  });

  test("parses global --session flag", () => {
    const result = parseCtlArgs(["--session", "my-proj", "window", "list"]);
    expect(result.group).toBe("window");
    expect(result.action).toBe("list");
    expect(result.flags.session).toBe("my-proj");
  });

  test("parses global -L flag", () => {
    const result = parseCtlArgs(["-L", "work", "session", "list"]);
    expect(result.flags.socket).toBe("work");
  });

  test("parses --socket flag", () => {
    const result = parseCtlArgs(["--socket", "work", "session", "list"]);
    expect(result.flags.socket).toBe("work");
  });

  test("parses action-specific flags", () => {
    const result = parseCtlArgs(["session", "create", "--name", "foo", "--dir", "/tmp"]);
    expect(result.action).toBe("create");
    expect(result.flags.name).toBe("foo");
    expect(result.flags.dir).toBe("/tmp");
  });

  test("parses --target flag", () => {
    const result = parseCtlArgs(["session", "kill", "--target", "my-proj"]);
    expect(result.flags.target).toBe("my-proj");
  });

  test("parses --force flag", () => {
    const result = parseCtlArgs(["session", "kill", "--target", "foo", "--force"]);
    expect(result.flags.force).toBe(true);
  });

  test("parses --no-enter flag", () => {
    const result = parseCtlArgs(["pane", "send-keys", "--target", "%5", "--no-enter"]);
    expect(result.flags["no-enter"]).toBe(true);
  });

  test("collects positional args after flags", () => {
    const result = parseCtlArgs(["pane", "send-keys", "--target", "%5", "ls", "-la"]);
    expect(result.positional).toEqual(["ls", "-la"]);
  });

  test("parses run-claude as standalone group", () => {
    const result = parseCtlArgs(["run-claude", "--name", "fix", "--dir", "/tmp"]);
    expect(result.group).toBe("run-claude");
    expect(result.action).toBeNull();
  });

  test("errors on missing group", () => {
    expect(() => parseCtlArgs([])).toThrow();
  });

  test("errors on unknown group", () => {
    expect(() => parseCtlArgs(["bogus", "list"])).toThrow();
  });
});
