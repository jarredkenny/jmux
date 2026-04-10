import { describe, test, expect } from "bun:test";
import { validateRunClaude, buildClaudeLaunchCommand } from "../../cli/run-claude";

describe("validateRunClaude", () => {
  test("requires --name", () => {
    expect(() => validateRunClaude({ dir: "/tmp" })).toThrow("--name is required");
  });

  test("requires --dir", () => {
    expect(() => validateRunClaude({ name: "foo" })).toThrow("--dir is required");
  });

  test("sanitizes name", () => {
    const result = validateRunClaude({ name: "foo.bar", dir: "/tmp" });
    expect(result.name).toBe("foo_bar");
  });

  test("sanitizes colons in name", () => {
    const result = validateRunClaude({ name: "foo:bar", dir: "/tmp" });
    expect(result.name).toBe("foo_bar");
  });

  test("returns dir unchanged", () => {
    const result = validateRunClaude({ name: "myname", dir: "/some/path" });
    expect(result.dir).toBe("/some/path");
  });
});

describe("buildClaudeLaunchCommand", () => {
  test("without message", () => {
    const cmd = buildClaudeLaunchCommand("claude", null, "/bin/zsh");
    expect(cmd).toBe("/bin/zsh -c 'claude; exec /bin/zsh'");
  });

  test("with temp file path", () => {
    const cmd = buildClaudeLaunchCommand("claude", "/tmp/jmux-prompt-abc123", "/bin/zsh");
    expect(cmd).toContain("cat /tmp/jmux-prompt-abc123");
    expect(cmd).toContain("rm -f /tmp/jmux-prompt-abc123");
    expect(cmd).toContain("exec /bin/zsh");
    expect(cmd).toContain("claude -p");
  });

  test("uses custom claude command", () => {
    const cmd = buildClaudeLaunchCommand("claude --model opus", null, "/bin/bash");
    expect(cmd).toBe("/bin/bash -c 'claude --model opus; exec /bin/bash'");
  });

  test("with prompt file uses shell to cat and clean up", () => {
    const cmd = buildClaudeLaunchCommand("claude", "/tmp/jmux-prompt-xyz", "/bin/bash");
    expect(cmd).toBe(
      "/bin/bash -c 'claude -p \"$(cat /tmp/jmux-prompt-xyz)\"; rm -f /tmp/jmux-prompt-xyz; exec /bin/bash'",
    );
  });
});
