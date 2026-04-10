import { describe, test, expect } from "bun:test";
import { resolveContext } from "../../cli/context";

describe("resolveContext", () => {
  test("inside jmux: sets insideJmux, socket, and paneId", () => {
    const ctx = resolveContext({
      env: {
        JMUX: "1",
        TMUX: "/tmp/tmux-501/default,12345,0",
        TMUX_PANE: "%1",
      },
      flags: {},
    });

    expect(ctx.insideJmux).toBe(true);
    expect(ctx.insideTmux).toBe(true);
    expect(ctx.socket).toBe("/tmp/tmux-501/default");
    expect(ctx.paneId).toBe("%1");
    expect(ctx.sessionOverride).toBeNull();
  });

  test("flags.socket overrides TMUX-derived socket", () => {
    const ctx = resolveContext({
      env: {
        TMUX: "/tmp/tmux-501/default,12345,0",
        TMUX_PANE: "%2",
      },
      flags: { socket: "/tmp/custom.sock" },
    });

    expect(ctx.socket).toBe("/tmp/custom.sock");
  });

  test("flags.session sets sessionOverride", () => {
    const ctx = resolveContext({
      env: {
        TMUX: "/tmp/tmux-501/default,12345,0",
        TMUX_PANE: "%3",
      },
      flags: { session: "my-project" },
    });

    expect(ctx.sessionOverride).toBe("my-project");
  });

  test("outside tmux: insideTmux false, socket null, paneId null", () => {
    const ctx = resolveContext({
      env: {},
      flags: {},
    });

    expect(ctx.insideTmux).toBe(false);
    expect(ctx.insideJmux).toBe(false);
    expect(ctx.socket).toBeNull();
    expect(ctx.paneId).toBeNull();
    expect(ctx.sessionOverride).toBeNull();
  });

  test("inside tmux but not jmux: insideTmux true, insideJmux false", () => {
    const ctx = resolveContext({
      env: {
        TMUX: "/tmp/tmux-501/default,12345,0",
        TMUX_PANE: "%4",
      },
      flags: {},
    });

    expect(ctx.insideTmux).toBe(true);
    expect(ctx.insideJmux).toBe(false);
    expect(ctx.socket).toBe("/tmp/tmux-501/default");
    expect(ctx.paneId).toBe("%4");
  });
});
