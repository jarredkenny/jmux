import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { sanitizeTmuxSessionName, buildOtelResourceAttrs, loadUserConfig, ConfigStore, defaultConfig } from "../config";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { PinnedPaneRecord } from "../glass/types";

describe("sanitizeTmuxSessionName", () => {
  test("replaces dots with underscores", () => {
    expect(sanitizeTmuxSessionName("my.project")).toBe("my_project");
  });

  test("replaces colons with underscores", () => {
    expect(sanitizeTmuxSessionName("my:project")).toBe("my_project");
  });

  test("replaces mixed dots and colons", () => {
    expect(sanitizeTmuxSessionName("a.b:c.d")).toBe("a_b_c_d");
  });

  test("leaves clean names unchanged", () => {
    expect(sanitizeTmuxSessionName("my-project")).toBe("my-project");
    expect(sanitizeTmuxSessionName("myproject")).toBe("myproject");
    expect(sanitizeTmuxSessionName("my_project")).toBe("my_project");
  });

  test("handles empty string", () => {
    expect(sanitizeTmuxSessionName("")).toBe("");
  });
});

describe("buildOtelResourceAttrs", () => {
  test("returns correct format", () => {
    expect(buildOtelResourceAttrs("my-session")).toBe("tmux_session_name=my-session");
  });

  test("includes sanitized session name as-is", () => {
    expect(buildOtelResourceAttrs("my_project")).toBe("tmux_session_name=my_project");
  });
});

describe("loadUserConfig", () => {
  test("returns defaults for nonexistent path", () => {
    const result = loadUserConfig("/nonexistent/path/config.json");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot?.enabled).toBe(true);
  });

  test("returns defaults for directory that does not exist", () => {
    const result = loadUserConfig("/tmp/__jmux_does_not_exist__/config.json");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot?.enabled).toBe(true);
  });
});

describe("loadUserConfig adapter config", () => {
  test("parses adapter config from valid JSON", () => {
    const tmpPath = `/tmp/jmux-test-config-${Date.now()}.json`;
    const config = {
      sidebarWidth: 30,
      adapters: {
        codeHost: { type: "gitlab" },
        issueTracker: { type: "linear" },
      },
    };
    writeFileSync(tmpPath, JSON.stringify(config));
    const result = loadUserConfig(tmpPath);
    expect(result.adapters).toBeDefined();
    expect(result.adapters!.codeHost!.type).toBe("gitlab");
    expect(result.adapters!.issueTracker!.type).toBe("linear");
    unlinkSync(tmpPath);
  });

  test("returns undefined adapters when not configured", () => {
    const tmpPath = `/tmp/jmux-test-config-${Date.now()}.json`;
    writeFileSync(tmpPath, JSON.stringify({ sidebarWidth: 26 }));
    const result = loadUserConfig(tmpPath);
    expect(result.adapters).toBeUndefined();
    unlinkSync(tmpPath);
  });
});

describe("ConfigStore", () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `jmux-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    cfgPath = join(tmpDir, "config.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("initializes with defaults when file missing", () => {
    const store = new ConfigStore(cfgPath);
    expect(store.config.snapshot?.enabled).toBe(true);
    expect(store.config.snapshot?.scrollbackIntervalMs).toBe(5000);
  });

  test("loads existing config from disk", () => {
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 30, claudeCommand: "cc" }));
    const store = new ConfigStore(cfgPath);
    expect(store.config.sidebarWidth).toBe(30);
    expect(store.config.claudeCommand).toBe("cc");
  });

  test("set persists to disk and updates in-memory", () => {
    const store = new ConfigStore(cfgPath);
    store.set("sidebarWidth", 40);
    expect(store.config.sidebarWidth).toBe(40);

    // Verify on disk
    const fromDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
    expect(fromDisk.sidebarWidth).toBe(40);
  });

  test("set preserves other keys", () => {
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 30, claudeCommand: "cc" }));
    const store = new ConfigStore(cfgPath);
    store.set("sidebarWidth", 40);
    expect(store.config.claudeCommand).toBe("cc");
  });

  test("delete removes key and persists", () => {
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 30, claudeCommand: "cc" }));
    const store = new ConfigStore(cfgPath);
    store.delete("claudeCommand");
    expect(store.config.claudeCommand).toBeUndefined();

    const fromDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
    expect(fromDisk.claudeCommand).toBeUndefined();
  });

  test("merge shallow-merges and persists", () => {
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 30 }));
    const store = new ConfigStore(cfgPath);
    store.merge({ claudeCommand: "cc", cacheTimers: false });
    expect(store.config.sidebarWidth).toBe(30);
    expect(store.config.claudeCommand).toBe("cc");
    expect(store.config.cacheTimers).toBe(false);
  });

  test("setWorkflow creates issueWorkflow if missing", () => {
    const store = new ConfigStore(cfgPath);
    store.setWorkflow("defaultBaseBranch", "develop");
    expect(store.config.issueWorkflow?.defaultBaseBranch).toBe("develop");

    const fromDisk = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
    expect(fromDisk.issueWorkflow.defaultBaseBranch).toBe("develop");
  });

  test("setWorkflow preserves other workflow keys", () => {
    writeFileSync(cfgPath, JSON.stringify({
      issueWorkflow: { defaultBaseBranch: "main", autoCreateWorktree: true },
    }));
    const store = new ConfigStore(cfgPath);
    store.setWorkflow("sessionNameTemplate", "{identifier}-wt");
    expect(store.config.issueWorkflow?.defaultBaseBranch).toBe("main");
    expect(store.config.issueWorkflow?.autoCreateWorktree).toBe(true);
    expect(store.config.issueWorkflow?.sessionNameTemplate).toBe("{identifier}-wt");
  });

  test("setTeamRepo adds and removes mappings", () => {
    const store = new ConfigStore(cfgPath);
    store.setTeamRepo("frontend", "/code/frontend");
    expect(store.config.issueWorkflow?.teamRepoMap?.frontend).toBe("/code/frontend");

    store.setTeamRepo("backend", "/code/backend");
    expect(store.config.issueWorkflow?.teamRepoMap?.backend).toBe("/code/backend");

    store.setTeamRepo("frontend", null);
    expect(store.config.issueWorkflow?.teamRepoMap?.frontend).toBeUndefined();
    expect(store.config.issueWorkflow?.teamRepoMap?.backend).toBe("/code/backend");
  });

  test("setAdapter sets and removes adapter config", () => {
    const store = new ConfigStore(cfgPath);
    store.setAdapter("codeHost", { type: "gitlab" });
    expect(store.config.adapters?.codeHost?.type).toBe("gitlab");

    store.setAdapter("issueTracker", { type: "linear" });
    expect(store.config.adapters?.issueTracker?.type).toBe("linear");

    store.setAdapter("codeHost", null);
    expect(store.config.adapters?.codeHost).toBeUndefined();
    expect(store.config.adapters?.issueTracker?.type).toBe("linear");
  });

  test("setAdapter cleans up empty adapters object", () => {
    const store = new ConfigStore(cfgPath);
    store.setAdapter("codeHost", { type: "gitlab" });
    store.setAdapter("codeHost", null);
    expect(store.config.adapters).toBeUndefined();
  });

  test("saveView upserts panel views", () => {
    const store = new ConfigStore(cfgPath);
    const view = {
      id: "v1", label: "Test", source: "issues" as const,
      filter: { scope: "assigned" as const },
      groupBy: "team" as const, subGroupBy: "status" as const,
      sortBy: "priority" as const, sortOrder: "asc" as const,
      sessionLinkedFirst: true,
    };
    store.saveView(view);
    expect(store.config.panelViews).toHaveLength(1);
    expect(store.config.panelViews![0].label).toBe("Test");

    // Update existing
    store.saveView({ ...view, label: "Updated" });
    expect(store.config.panelViews).toHaveLength(1);
    expect(store.config.panelViews![0].label).toBe("Updated");

    // Add second
    store.saveView({ ...view, id: "v2", label: "Second" });
    expect(store.config.panelViews).toHaveLength(2);
  });

  test("reload picks up external changes", () => {
    const store = new ConfigStore(cfgPath);
    store.set("sidebarWidth", 30);

    // External write
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 50, claudeCommand: "external" }));
    const reloaded = store.reload();
    expect(reloaded.sidebarWidth).toBe(50);
    expect(store.config.claudeCommand).toBe("external");
  });

  test("ensureExists creates file when missing", () => {
    const newPath = join(tmpDir, "sub", "config.json");
    const store = new ConfigStore(newPath);
    const created = store.ensureExists();
    expect(created).toBe(true);
    expect(existsSync(newPath)).toBe(true);

    const again = store.ensureExists();
    expect(again).toBe(false);
  });

  test("configPath returns the path", () => {
    const store = new ConfigStore(cfgPath);
    expect(store.configPath).toBe(cfgPath);
  });

  test("round-trips pinnedPanes home records", () => {
    const records: PinnedPaneRecord[] = [
      {
        paneId: "%7",
        homeSessionId: "$2",
        homeWindowId: "@5",
        homeLayout: "bb62,159x48,0,0,3",
        displaySessionName: "api",
        displayWindowName: "tests",
      },
    ];
    const store = new ConfigStore(cfgPath);
    store.set("pinnedPanes", records);

    const reloaded = new ConfigStore(cfgPath);
    expect(reloaded.config.pinnedPanes).toEqual(records);
  });
});

describe("snapshot config defaults", () => {
  test("snapshot.enabled defaults to true", () => {
    expect(defaultConfig.snapshot?.enabled).toBe(true);
  });

  test("snapshot.scrollbackIntervalMs defaults to 5000", () => {
    expect(defaultConfig.snapshot?.scrollbackIntervalMs).toBe(5000);
  });

  test("snapshot.scrollbackMaxBytes defaults to 2 MiB", () => {
    expect(defaultConfig.snapshot?.scrollbackMaxBytes).toBe(2 * 1024 * 1024);
  });

  test("snapshot.dir defaults to null", () => {
    expect(defaultConfig.snapshot?.dir).toBeNull();
  });
});

describe("snapshot config merging", () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `jmux-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    cfgPath = join(tmpDir, "config.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loadUserConfig merges partial snapshot config with defaults", () => {
    writeFileSync(cfgPath, JSON.stringify({
      snapshot: {
        scrollbackIntervalMs: 10000,
      },
    }));
    const loaded = loadUserConfig(cfgPath);
    expect(loaded.snapshot?.enabled).toBe(true);
    expect(loaded.snapshot?.scrollbackIntervalMs).toBe(10000);
    expect(loaded.snapshot?.scrollbackMaxBytes).toBe(2 * 1024 * 1024);
    expect(loaded.snapshot?.dir).toBeNull();
  });

  test("loadUserConfig applies snapshot defaults when omitted", () => {
    writeFileSync(cfgPath, JSON.stringify({ sidebarWidth: 30 }));
    const loaded = loadUserConfig(cfgPath);
    expect(loaded.snapshot?.enabled).toBe(true);
    expect(loaded.snapshot?.scrollbackIntervalMs).toBe(5000);
    expect(loaded.snapshot?.scrollbackMaxBytes).toBe(2 * 1024 * 1024);
    expect(loaded.snapshot?.dir).toBeNull();
  });

  test("loadUserConfig merges all snapshot fields", () => {
    writeFileSync(cfgPath, JSON.stringify({
      snapshot: {
        enabled: false,
        scrollbackIntervalMs: 3000,
        scrollbackMaxBytes: 1024 * 1024,
        dir: "/custom/path",
      },
    }));
    const loaded = loadUserConfig(cfgPath);
    expect(loaded.snapshot?.enabled).toBe(false);
    expect(loaded.snapshot?.scrollbackIntervalMs).toBe(3000);
    expect(loaded.snapshot?.scrollbackMaxBytes).toBe(1024 * 1024);
    expect(loaded.snapshot?.dir).toBe("/custom/path");
  });

  test("ConfigStore persists and loads snapshot config", () => {
    const store = new ConfigStore(cfgPath);
    store.set("snapshot", {
      enabled: false,
      scrollbackIntervalMs: 8000,
      scrollbackMaxBytes: 3 * 1024 * 1024,
      dir: "/data",
    });
    expect(store.config.snapshot?.enabled).toBe(false);
    expect(store.config.snapshot?.scrollbackIntervalMs).toBe(8000);

    const reloaded = new ConfigStore(cfgPath);
    expect(reloaded.config.snapshot?.enabled).toBe(false);
    expect(reloaded.config.snapshot?.scrollbackIntervalMs).toBe(8000);
    expect(reloaded.config.snapshot?.scrollbackMaxBytes).toBe(3 * 1024 * 1024);
    expect(reloaded.config.snapshot?.dir).toBe("/data");
  });
});
