import { describe, test, expect } from "bun:test";
import { buildTmuxPtyArgs } from "../../tmux-pty";

describe("buildTmuxPtyArgs", () => {
  test("createOrAttach emits new-session -A with name", () => {
    const args = buildTmuxPtyArgs({
      attachMode: "createOrAttach",
      sessionName: "alpha",
      socketName: "default",
      configFile: "/cfg",
    });
    expect(args).toEqual([
      "-f",
      "/cfg",
      "-L",
      "default",
      "new-session",
      "-A",
      "-s",
      "alpha",
    ]);
  });

  test("createOrAttach without sessionName omits -s", () => {
    const args = buildTmuxPtyArgs({
      attachMode: "createOrAttach",
      sessionName: undefined,
    });
    expect(args).toContain("new-session");
    expect(args).toContain("-A");
    expect(args).not.toContain("-s");
  });

  test("strictAttach emits attach-session -t name", () => {
    const args = buildTmuxPtyArgs({
      attachMode: "strictAttach",
      sessionName: "alpha",
      socketName: "default",
      configFile: "/cfg",
    });
    expect(args).toEqual([
      "-f",
      "/cfg",
      "-L",
      "default",
      "attach-session",
      "-t",
      "alpha",
    ]);
  });

  test("strictAttach without sessionName throws", () => {
    expect(() =>
      buildTmuxPtyArgs({ attachMode: "strictAttach", sessionName: undefined }),
    ).toThrow("strictAttach requires sessionName");
  });
});
