import { describe, test, expect } from "bun:test";
import { buildPainterArgv, detectPaneKind } from "../../snapshot/painter";

describe("buildPainterArgv", () => {
  test("emits sh -c wrapper for claude pane", () => {
    const argv = buildPainterArgv({
      scrollbackPath: "/snap/scrollback/a/0-0.ansi",
      capturedAt: "2026-05-12T18:00:00.000Z",
      kind: "claude",
      claudeCommand: "claude",
      userShell: "/bin/zsh",
    });
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    expect(argv[3]).toBe("jmux-restore");
    expect(argv[4]).toBe("/snap/scrollback/a/0-0.ansi");
    expect(argv[5]).toBe("2026-05-12T18:00:00.000Z");
    // tail
    expect(argv.slice(6)).toEqual(["claude", "--continue"]);
  });

  test("splits multi-word claudeCommand correctly", () => {
    const argv = buildPainterArgv({
      scrollbackPath: "/x",
      capturedAt: "2026-05-12T00:00:00Z",
      kind: "claude",
      claudeCommand: "bun run claude",
      userShell: "/bin/zsh",
    });
    expect(argv.slice(6)).toEqual(["bun", "run", "claude", "--continue"]);
  });

  test("shell pane tail uses userShell -i", () => {
    const argv = buildPainterArgv({
      scrollbackPath: "/x",
      capturedAt: "2026-05-12T00:00:00Z",
      kind: "shell",
      claudeCommand: "claude",
      userShell: "/bin/bash",
    });
    expect(argv.slice(6)).toEqual(["/bin/bash", "-i"]);
  });

  test("other pane tail is same as shell", () => {
    const argv = buildPainterArgv({
      scrollbackPath: "/x",
      capturedAt: "2026-05-12T00:00:00Z",
      kind: "other",
      claudeCommand: "claude",
      userShell: "/bin/zsh",
    });
    expect(argv.slice(6)).toEqual(["/bin/zsh", "-i"]);
  });

  test("script body uses positional args, never interpolates user data", () => {
    const argv = buildPainterArgv({
      scrollbackPath: "/path with spaces; rm -rf /",
      capturedAt: "2026-05-12T00:00:00Z",
      kind: "shell",
      claudeCommand: "claude",
      userShell: "/bin/zsh",
    });
    const body = argv[2];
    expect(body).not.toContain("/path with spaces");
    expect(body).not.toContain("rm -rf");
    expect(body).toContain('"$F"');
  });
});

describe("detectPaneKind", () => {
  test("recognizes plain claude", () => {
    expect(detectPaneKind("claude")).toBe("claude");
  });
  test("recognizes claude with args", () => {
    expect(detectPaneKind("claude --resume foo")).toBe("claude");
  });
  test("recognizes bun run claude", () => {
    expect(detectPaneKind("bun run claude --print")).toBe("claude");
  });
  test("treats shell as shell", () => {
    expect(detectPaneKind("zsh")).toBe("shell");
    expect(detectPaneKind("/bin/bash -i")).toBe("shell");
    expect(detectPaneKind("fish")).toBe("shell");
  });
  test("everything else is other", () => {
    expect(detectPaneKind("bun run dev")).toBe("other");
    expect(detectPaneKind("vim README.md")).toBe("other");
    expect(detectPaneKind("")).toBe("other");
  });
});
