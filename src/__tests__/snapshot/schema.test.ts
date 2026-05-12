import { describe, test, expect } from "bun:test";
import {
  SNAPSHOT_FORMAT_VERSION,
  validateSnapshot,
  type SnapshotFile,
} from "../../snapshot/schema";

const good: SnapshotFile = {
  formatVersion: 1,
  jmuxVersion: "0.16.0",
  capturedAt: "2026-05-12T18:00:00.000Z",
  tmuxSocket: "",
  lastFocusedSession: "feature-x",
  sessions: [
    {
      name: "feature-x",
      cwd: "/repos/foo",
      worktreePath: null,
      projectGroup: null,
      pinned: false,
      attention: false,
      permissionMode: "default",
      otel: null,
      links: [],
      windows: [
        {
          index: 0,
          name: "main",
          layout: "b46c,200x50,0,0,0",
          active: true,
          panes: [
            {
              index: 0,
              cwd: "/repos/foo",
              command: "zsh",
              kind: "shell",
              scrollbackFile: null,
            },
          ],
        },
      ],
    },
  ],
};

describe("snapshot schema", () => {
  test("format version is 1", () => {
    expect(SNAPSHOT_FORMAT_VERSION).toBe(1);
  });

  test("validateSnapshot accepts a well-formed object", () => {
    const result = validateSnapshot(good);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot rejects unknown formatVersion", () => {
    const bad = { ...good, formatVersion: 999 } as unknown;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("formatVersion");
  });

  test("validateSnapshot rejects malformed pane.kind", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].panes[0].kind = "wrong";
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
  });

  test("validateSnapshot rejects non-ISO capturedAt", () => {
    const bad = { ...good, capturedAt: "yesterday" };
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
  });

  test("validateSnapshot rejects missing sessions array", () => {
    const bad = { ...good, sessions: undefined } as unknown;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
  });

  test("validateSnapshot round-trips via JSON", () => {
    const json = JSON.stringify(good);
    const parsed = JSON.parse(json);
    const result = validateSnapshot(parsed);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot accepts permissionMode 'accept-edits'", () => {
    const variant = JSON.parse(JSON.stringify(good));
    variant.sessions[0].permissionMode = "accept-edits";
    const result = validateSnapshot(variant);
    expect(result.ok).toBe(true);
  });
});
