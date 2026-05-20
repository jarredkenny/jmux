import { describe, test, expect } from "bun:test";
import {
  buildHookBlock,
  detectInstalledKind,
  installHooks,
  type InstallOutcome,
} from "../hook-installer";

describe("buildHookBlock", () => {
  test("returns the four-hook spec verbatim", () => {
    const block = buildHookBlock();
    expect(Object.keys(block).sort()).toEqual([
      "PermissionRequest",
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
    for (const [, entries] of Object.entries(block)) {
      const cmd = entries[0].hooks[0].command;
      expect(cmd).toContain("@jmux-agent-state");
      expect(cmd).toContain("@jmux-agent-state-since");
    }
    // PreToolUse must be idempotent — only writes when state != running.
    expect(block.PreToolUse[0].hooks[0].command).toContain(
      'show-option -qv @jmux-agent-state',
    );
  });
});

describe("detectInstalledKind", () => {
  test("empty settings → none", () => {
    expect(detectInstalledKind({})).toBe("none");
    expect(detectInstalledKind({ hooks: {} })).toBe("none");
  });

  test("legacy @jmux-attention Stop hook → legacy", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command" as const, command: "tmux set-option @jmux-attention 1 2>/dev/null || true", timeout: 5 },
            ],
          },
        ],
      },
    };
    expect(detectInstalledKind(settings)).toBe("legacy");
  });

  test("new four-hook block → current", () => {
    const settings = { hooks: buildHookBlock() };
    expect(detectInstalledKind(settings)).toBe("current");
  });

  test("partial new install (some hooks present, some missing) → partial", () => {
    const block = buildHookBlock();
    const settings = {
      hooks: {
        Stop: block.Stop,
        UserPromptSubmit: block.UserPromptSubmit,
        // missing PermissionRequest and PreToolUse
      },
    };
    expect(detectInstalledKind(settings)).toBe("partial");
  });
});

describe("installHooks", () => {
  test("none → installs all four", () => {
    const settings = {};
    const out: InstallOutcome = installHooks(settings);
    expect(out.kind).toBe("installed");
    expect(detectInstalledKind(out.settings)).toBe("current");
  });

  test("legacy → removes legacy entry and installs all four", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command" as const, command: "tmux set-option @jmux-attention 1 2>/dev/null || true", timeout: 5 },
            ],
          },
        ],
      },
    };
    const out = installHooks(settings);
    expect(out.kind).toBe("migrated");
    expect(detectInstalledKind(out.settings)).toBe("current");
    const stopCommands = (out.settings.hooks!.Stop as any[]).flatMap((e) =>
      e.hooks.map((h: any) => h.command),
    );
    expect(stopCommands.every((c: string) => !c.includes("@jmux-attention"))).toBe(true);
  });

  test("current → noop", () => {
    const settings = { hooks: buildHookBlock() };
    const out = installHooks(settings);
    expect(out.kind).toBe("noop");
    expect(out.settings).toEqual(settings);
  });

  test("partial → fills in missing hooks, leaves existing in place", () => {
    const block = buildHookBlock();
    const settings = { hooks: { Stop: block.Stop } };
    const out = installHooks(settings);
    expect(out.kind).toBe("installed");
    expect(detectInstalledKind(out.settings)).toBe("current");
  });

  test("preserves unrelated Stop entries", () => {
    const unrelated = {
      hooks: [
        { type: "command" as const, command: "echo unrelated", timeout: 5 },
      ],
    };
    const settings = { hooks: { Stop: [unrelated] } };
    const out = installHooks(settings);
    expect(out.kind).toBe("installed");
    // Both unrelated entry AND the jmux Stop entry should be present.
    const stop = out.settings.hooks!.Stop as any[];
    expect(stop).toContainEqual(unrelated);
    expect(stop.some((e) =>
      e.hooks.some((h: any) => h.command.includes("@jmux-agent-state")),
    )).toBe(true);
  });
});
