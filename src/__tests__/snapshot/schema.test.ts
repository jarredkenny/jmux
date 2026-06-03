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
    if (!result.ok) expect(result.error).toContain("kind");
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

  test("validateSnapshot rejects non-object root", () => {
    const result = validateSnapshot("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("root");
  });

  test("validateSnapshot rejects non-string jmuxVersion", () => {
    const bad = { ...good, jmuxVersion: 42 } as unknown;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("jmuxVersion");
  });

  test("validateSnapshot rejects non-string tmuxSocket", () => {
    const bad = { ...good, tmuxSocket: null } as unknown;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("tmuxSocket");
  });

  test("validateSnapshot rejects non-null non-string lastFocusedSession", () => {
    const bad = { ...good, lastFocusedSession: 42 } as unknown;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("lastFocusedSession");
  });

  test("validateSnapshot rejects non-object session", () => {
    const bad = { ...good, sessions: [42] } as unknown;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("sessions[0]");
  });

  test("validateSnapshot rejects session with non-string cwd", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].cwd = 99;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cwd");
  });

  test("validateSnapshot rejects session with non-null non-string worktreePath", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].worktreePath = 0;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("worktreePath");
  });

  test("validateSnapshot rejects session with non-null non-string projectGroup", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].projectGroup = true;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("projectGroup");
  });

  test("validateSnapshot rejects session with non-boolean pinned", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].pinned = "yes";
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pinned");
  });

  test("validateSnapshot rejects session with non-boolean attention", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].attention = 1;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("attention");
  });

  test("validateSnapshot accepts session with attention omitted", () => {
    const noAttention = JSON.parse(JSON.stringify(good));
    delete noAttention.sessions[0].attention;
    const result = validateSnapshot(noAttention);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot rejects session with invalid permissionMode", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].permissionMode = "superuser";
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("permissionMode");
  });

  test("validateSnapshot rejects session with non-array links", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].links = "none";
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("links");
  });

  test("validateSnapshot rejects non-object link", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].links = [42];
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("links[0]");
  });

  test("validateSnapshot rejects link with invalid type", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].links = [{ type: "pr", id: "123" }];
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("type");
  });

  test("validateSnapshot rejects link with non-string id", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].links = [{ type: "issue", id: 999 }];
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("id");
  });

  test("validateSnapshot rejects session with non-array windows", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows = "main";
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("windows");
  });

  test("validateSnapshot rejects non-object window", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows = ["bad"];
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("windows[0]");
  });

  test("validateSnapshot rejects window with non-number index", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].index = "0";
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("index");
  });

  test("validateSnapshot rejects window with non-string name", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].name = null;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("name");
  });

  test("validateSnapshot rejects window with non-string layout", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].layout = 42;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("layout");
  });

  test("validateSnapshot rejects window with non-boolean active", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].active = "yes";
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("active");
  });

  test("validateSnapshot rejects window with non-array panes", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].panes = null;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("panes");
  });

  test("validateSnapshot rejects pane with non-number index", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].panes[0].index = "zero";
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("index");
  });

  test("validateSnapshot rejects pane with non-string cwd", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].panes[0].cwd = true;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cwd");
  });

  test("validateSnapshot rejects pane with non-string command", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].panes[0].command = 0;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("command");
  });

  test("validateSnapshot rejects pane with non-null non-string scrollbackFile", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].panes[0].scrollbackFile = 123;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("scrollbackFile");
  });

  // OTEL validation paths
  test("validateSnapshot rejects non-object non-null otel", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].otel = "some-string";
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("otel");
  });

  test("validateSnapshot rejects otel with non-number contextTokens", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].otel = { contextTokens: "lots", cacheWasHit: null, lastRequestTime: null, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: [] };
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("contextTokens");
  });

  test("validateSnapshot accepts otel without contextTokens (back-compat)", () => {
    const variant = JSON.parse(JSON.stringify(good));
    variant.sessions[0].otel = { cacheWasHit: true, lastRequestTime: null, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: [] };
    const result = validateSnapshot(variant);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot rejects otel with invalid cacheWasHit", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].otel = { cacheWasHit: "yes", lastRequestTime: null, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: [] };
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cacheWasHit");
  });

  test("validateSnapshot rejects otel with invalid nullable string field", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].otel = { cacheWasHit: null, lastRequestTime: 42, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: [] };
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("lastRequestTime");
  });

  test("validateSnapshot rejects otel with non-array failedMcpServers", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].otel = { cacheWasHit: null, lastRequestTime: null, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: "none" };
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("failedMcpServers");
  });

  test("validateSnapshot rejects otel with non-string failedMcpServers entry", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].otel = { cacheWasHit: null, lastRequestTime: null, lastCompactionTime: null, lastUserPromptTime: null, lastError: null, failedMcpServers: [42] };
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("failedMcpServers[0]");
  });

  test("validateSnapshot accepts full valid otel object", () => {
    const variant = JSON.parse(JSON.stringify(good));
    variant.sessions[0].otel = {
      contextTokens: 112000,
      cacheWasHit: true,
      lastRequestTime: "2026-05-12T18:00:00.000Z",
      lastCompactionTime: null,
      lastUserPromptTime: "2026-05-12T17:00:00.000Z",
      lastError: null,
      failedMcpServers: ["linear", "slack"],
    };
    const result = validateSnapshot(variant);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot rejects otel with unknown lastError type string", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].otel = {
      cacheWasHit: null,
      lastRequestTime: null,
      lastCompactionTime: null,
      lastUserPromptTime: null,
      lastError: "some_unknown_error",
      failedMcpServers: [],
    };
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("lastError");
  });

  test("validateSnapshot accepts lastFocusedSession as null", () => {
    const variant = { ...good, lastFocusedSession: null };
    const result = validateSnapshot(variant);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot accepts permissionMode as null", () => {
    const variant = JSON.parse(JSON.stringify(good));
    variant.sessions[0].permissionMode = null;
    const result = validateSnapshot(variant);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot accepts pane with non-null scrollbackFile", () => {
    const variant = JSON.parse(JSON.stringify(good));
    variant.sessions[0].windows[0].panes[0].scrollbackFile = "scrollback/alpha/0-0.ansi";
    const result = validateSnapshot(variant);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot accepts link with type 'mr'", () => {
    const variant = JSON.parse(JSON.stringify(good));
    variant.sessions[0].links = [{ type: "mr", id: "42" }];
    const result = validateSnapshot(variant);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot accepts a session with agentState absent (v1 back-compat)", () => {
    // `good` does not include agentState; this is the v1 back-compat case.
    const result = validateSnapshot(good);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot accepts agentState: null", () => {
    const snap = { ...good, sessions: [{ ...good.sessions[0], agentState: null }] };
    const result = validateSnapshot(snap);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot accepts a well-formed agentState object", () => {
    const snap = {
      ...good,
      sessions: [
        {
          ...good.sessions[0],
          agentState: { state: "running", since: "2026-05-20T12:00:00.000Z" },
        },
      ],
    };
    const result = validateSnapshot(snap);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot rejects an invalid agentState.state", () => {
    const snap = {
      ...good,
      sessions: [
        {
          ...good.sessions[0],
          agentState: { state: "bogus", since: "2026-05-20T12:00:00.000Z" },
        },
      ],
    };
    const result = validateSnapshot(snap);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("agentState.state");
  });

  test("validateSnapshot rejects an agentState with non-string since", () => {
    const snap = {
      ...good,
      sessions: [
        {
          ...good.sessions[0],
          agentState: { state: "running", since: 12345 },
        },
      ],
    };
    const result = validateSnapshot(snap);
    expect(result.ok).toBe(false);
  });

  test("validateSnapshot rejects an agentState with non-ISO since", () => {
    const snap = {
      ...good,
      sessions: [
        {
          ...good.sessions[0],
          agentState: { state: "running", since: "not-an-iso-string" },
        },
      ],
    };
    const result = validateSnapshot(snap);
    expect(result.ok).toBe(false);
  });

  test("validateSnapshot rejects an agentState with since: null", () => {
    const snap = {
      ...good,
      sessions: [
        {
          ...good.sessions[0],
          agentState: { state: "running", since: null },
        },
      ],
    };
    const result = validateSnapshot(snap as unknown);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("agentState.since");
  });
});
