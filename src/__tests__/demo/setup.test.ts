import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { configFileIn, materializeAssets } from "../../assets";
import { cleanupDemo, reapStaleDemoServers, setupDemo, type DemoContext } from "../../demo/setup";

/**
 * Demo mode is the one path that *starts* the tmux server itself, and tmux
 * honors `-f` only from the process that starts one. When setup skipped it,
 * jmux's later attach silently inherited the user's defaults: tmux drew its own
 * status bar underneath jmux's chrome and windows kept their `zsh` name. These
 * tests spawn a real tmux server because that asymmetry only exists in tmux —
 * there is no logic module to unit-test it against.
 */

const contexts: DemoContext[] = [];

/**
 * `$JMUX_DIR` has to be set, and setting it here is the point.
 *
 * `config/tmux.conf` expands `$JMUX_DIR/config/defaults.conf`, and `main.ts`
 * exports it before spawning tmux. These tests call `setupDemo` directly, so
 * nothing exports it for them — without this, the path resolves to
 * `/config/defaults.conf`, tmux fails to source it, `core.conf` never runs, and
 * `status off` never applies.
 *
 * It passed locally anyway, which is the trap: a developer running the suite
 * from inside jmux already has `JMUX_DIR` in their environment, so the test was
 * quietly reading the ambient value instead of arranging its own. CI has no such
 * environment and caught it. A test that depends on the shell it is run from is
 * not testing what it claims to.
 */
let previousJmuxDir: string | undefined;

beforeAll(() => {
  previousJmuxDir = process.env.JMUX_DIR;
  process.env.JMUX_DIR = materializeAssets();
});

afterAll(() => {
  if (previousJmuxDir === undefined) delete process.env.JMUX_DIR;
  else process.env.JMUX_DIR = previousJmuxDir;
});

function boot(configFile?: string): DemoContext {
  const ctx = setupDemo({ configFile });
  contexts.push(ctx);
  return ctx;
}

function showOption(socketName: string, option: string): string {
  const proc = Bun.spawnSync(["tmux", "-L", socketName, "show-option", "-gv", option], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

afterEach(() => {
  while (contexts.length) cleanupDemo(contexts.pop()!);
});

describe("setupDemo tmux config", () => {
  test("applies jmux's config to the server it starts", () => {
    const ctx = boot(configFileIn(materializeAssets()));

    // core.conf's `set -g status off` — the setting whose absence painted a
    // green tmux status bar across the bottom of every demo frame.
    expect(showOption(ctx.socketName, "status")).toBe("off");
  });

  test("without a config file the server keeps tmux's defaults", () => {
    const ctx = boot();

    // Guards the test above from passing vacuously: if tmux ever shipped
    // `status off` by default, the assertion would prove nothing.
    expect(showOption(ctx.socketName, "status")).not.toBe("off");
  });

  test("reaping leaves a live demo alone", () => {
    const ctx = boot(configFileIn(materializeAssets()));

    // The reaper keys on the pid in the socket name. This process is that pid,
    // so its own server must survive — a reaper that killed live demos would
    // take down the session that just started it, and would do so only when a
    // second jmux happened to be running.
    const reaped = reapStaleDemoServers();

    expect(reaped).not.toContain(ctx.socketName);
    const proc = Bun.spawnSync(["tmux", "-L", ctx.socketName, "list-sessions"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
  });

  test("reaping collects a server whose owner is gone", () => {
    // A socket named for a pid that cannot be running. Nothing needs to have
    // created it — the reaper's decision is made from the name and the pid, and
    // this asserts it acts rather than silently skipping.
    const socketDir = resolve(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`);
    const deadPid = 2 ** 22; // above any real pid on macOS/Linux
    const socketPath = resolve(socketDir, `jmux-demo-${deadPid}`);
    const tmpPath = `/tmp/jmux-demo-${deadPid}`;

    mkdirSync(socketDir, { recursive: true });
    writeFileSync(socketPath, "");
    mkdirSync(tmpPath, { recursive: true });

    try {
      expect(reapStaleDemoServers()).toContain(`jmux-demo-${deadPid}`);
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(tmpPath)).toBe(false);
    } finally {
      rmSync(socketPath, { force: true });
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  test("cleanup kills the server", () => {
    const ctx = boot(configFileIn(materializeAssets()));
    cleanupDemo(contexts.pop()!);

    const proc = Bun.spawnSync(["tmux", "-L", ctx.socketName, "list-sessions"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).not.toBe(0);
  });
});
