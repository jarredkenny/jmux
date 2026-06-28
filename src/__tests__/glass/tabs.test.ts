import { describe, test, expect } from "bun:test";
import {
  normalizeTabs, defaultTabId, resolveTabId,
  DEFAULT_TAB_SEED_ID, DEFAULT_TAB_SEED_NAME,
  type TabEntry,
} from "../../glass/tabs";

describe("normalizeTabs", () => {
  test("empty/undefined synthesizes the seed default at index 0", () => {
    for (const raw of [undefined, null, [], "bad", {}]) {
      const tabs = normalizeTabs(raw);
      expect(tabs).toEqual([{ id: DEFAULT_TAB_SEED_ID, name: DEFAULT_TAB_SEED_NAME }]);
    }
  });

  test("keeps valid entries in order", () => {
    const raw = [
      { id: "default", name: "Main" },
      { id: "backend", name: "Backend" },
    ];
    expect(normalizeTabs(raw)).toEqual(raw);
  });

  test("drops malformed entries (missing id/name, wrong types)", () => {
    const raw = [
      { id: "default", name: "Main" },
      { id: "", name: "Empty" },
      { name: "NoId" },
      { id: "x" },
      "nope",
      { id: "backend", name: "Backend" },
    ];
    expect(normalizeTabs(raw)).toEqual([
      { id: "default", name: "Main" },
      { id: "backend", name: "Backend" },
    ]);
  });

  test("dedups ids, first occurrence wins", () => {
    const raw = [
      { id: "default", name: "Main" },
      { id: "backend", name: "Backend" },
      { id: "backend", name: "Backend Dupe" },
    ];
    expect(normalizeTabs(raw)).toEqual([
      { id: "default", name: "Main" },
      { id: "backend", name: "Backend" },
    ]);
  });

  test("if all entries are dropped, falls back to the seed default", () => {
    expect(normalizeTabs([{ id: "" }, "x"])).toEqual([
      { id: DEFAULT_TAB_SEED_ID, name: DEFAULT_TAB_SEED_NAME },
    ]);
  });
});

describe("defaultTabId", () => {
  test("is the id at index 0", () => {
    expect(defaultTabId([{ id: "home", name: "Home" }, { id: "b", name: "B" }])).toBe("home");
  });
});

describe("resolveTabId", () => {
  const tabs: TabEntry[] = [
    { id: "default", name: "Main" },
    { id: "backend", name: "Backend" },
  ];
  test("known id resolves to itself", () => {
    expect(resolveTabId("backend", tabs)).toBe("backend");
  });
  test("legacy '1' resolves to the default", () => {
    expect(resolveTabId("1", tabs)).toBe("default");
  });
  test("unknown id resolves to the default", () => {
    expect(resolveTabId("ghost", tabs)).toBe("default");
  });
  test("empty / null / undefined resolves to the default", () => {
    expect(resolveTabId("", tabs)).toBe("default");
    expect(resolveTabId(null, tabs)).toBe("default");
    expect(resolveTabId(undefined, tabs)).toBe("default");
  });
});

import {
  slugifyTabName, validateTabName, addTab, renameTab, deleteTab, moveTab,
} from "../../glass/tabs";

describe("slugifyTabName", () => {
  test("lowercases and dashes non-alphanumerics", () => {
    expect(slugifyTabName("Code Review!", [])).toBe("code-review");
  });
  test("dedups against existing ids", () => {
    expect(slugifyTabName("Backend", ["backend"])).toBe("backend-2");
    expect(slugifyTabName("Backend", ["backend", "backend-2"])).toBe("backend-3");
  });
  test("falls back to 'tab' when empty after slugify", () => {
    expect(slugifyTabName("!!!", [])).toBe("tab");
    expect(slugifyTabName("!!!", ["tab"])).toBe("tab-2");
  });
});

describe("validateTabName", () => {
  const tabs: TabEntry[] = [
    { id: "default", name: "Main" },
    { id: "backend", name: "Backend" },
  ];
  test("trims and accepts a fresh name", () => {
    expect(validateTabName("  Review  ", tabs)).toEqual({ ok: true, name: "Review" });
  });
  test("rejects empty/whitespace", () => {
    expect(validateTabName("   ", tabs)).toEqual({ ok: false, error: "Tab name cannot be empty" });
  });
  test("rejects > 24 chars", () => {
    const long = "x".repeat(25);
    expect(validateTabName(long, tabs)).toEqual({ ok: false, error: "Tab name too long (max 24)" });
  });
  test("rejects case-insensitive duplicates", () => {
    expect(validateTabName("backend", tabs)).toEqual({
      ok: false, error: 'A tab named "backend" already exists',
    });
  });
  test("allows renaming a tab to its own current name (excludeId)", () => {
    expect(validateTabName("Backend", tabs, { excludeId: "backend" })).toEqual({
      ok: true, name: "Backend",
    });
  });
});

describe("addTab", () => {
  test("appends a validated tab with a slug id", () => {
    const tabs: TabEntry[] = [{ id: "default", name: "Main" }];
    const r = addTab(tabs, "Code Review");
    expect(r).toEqual({ ok: true, tabs: [
      { id: "default", name: "Main" },
      { id: "code-review", name: "Code Review" },
    ]});
  });
  test("propagates validation errors", () => {
    expect(addTab([{ id: "default", name: "Main" }], "  ")).toEqual({
      ok: false, error: "Tab name cannot be empty",
    });
  });
});

describe("renameTab", () => {
  const tabs: TabEntry[] = [{ id: "default", name: "Main" }, { id: "backend", name: "Backend" }];
  test("changes only the name, keeps the id", () => {
    expect(renameTab(tabs, "backend", "API")).toEqual({ ok: true, tabs: [
      { id: "default", name: "Main" }, { id: "backend", name: "API" },
    ]});
  });
  test("unknown id errors", () => {
    expect(renameTab(tabs, "ghost", "X")).toEqual({ ok: false, error: "Unknown tab" });
  });
});

describe("deleteTab", () => {
  const tabs: TabEntry[] = [{ id: "default", name: "Main" }, { id: "backend", name: "Backend" }];
  test("removes an empty non-default tab", () => {
    expect(deleteTab(tabs, "backend", 0)).toEqual({ ok: true, tabs: [{ id: "default", name: "Main" }] });
  });
  test("blocks deleting the default tab", () => {
    expect(deleteTab(tabs, "default", 0)).toEqual({ ok: false, error: "Cannot delete the default tab" });
  });
  test("blocks deleting a non-empty tab", () => {
    expect(deleteTab(tabs, "backend", 3)).toEqual({ ok: false, error: "Tab is not empty" });
  });
  test("unknown id errors", () => {
    expect(deleteTab(tabs, "ghost", 0)).toEqual({ ok: false, error: "Unknown tab" });
  });
});

describe("moveTab", () => {
  const tabs: TabEntry[] = [
    { id: "default", name: "Main" },
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  test("right swaps with the next neighbor", () => {
    expect(moveTab(tabs, "a", "right").map(t => t.id)).toEqual(["default", "b", "a"]);
  });
  test("left swaps with the previous neighbor (but never index 0)", () => {
    expect(moveTab(tabs, "b", "left").map(t => t.id)).toEqual(["default", "b", "a"]);
  });
  test("left at index 1 is a no-op (cannot cross the default)", () => {
    expect(moveTab(tabs, "a", "left").map(t => t.id)).toEqual(["default", "a", "b"]);
  });
  test("the default tab never moves", () => {
    expect(moveTab(tabs, "default", "right").map(t => t.id)).toEqual(["default", "a", "b"]);
  });
  test("unknown id is a no-op", () => {
    expect(moveTab(tabs, "ghost", "right").map(t => t.id)).toEqual(["default", "a", "b"]);
  });
});
