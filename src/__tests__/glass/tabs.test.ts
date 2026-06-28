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
