import { describe, test, expect } from "bun:test";
import { createAdapters } from "../../adapters/registry";
import type { AdapterConfig } from "../../adapters/types";

describe("createAdapters", () => {
  test("returns null adapters when config is empty", () => {
    const result = createAdapters({});
    expect(result.codeHost).toBeNull();
    expect(result.issueTracker).toBeNull();
  });

  test("returns null adapters when config is undefined", () => {
    const result = createAdapters(undefined);
    expect(result.codeHost).toBeNull();
    expect(result.issueTracker).toBeNull();
  });

  test("creates gitlab code host adapter", () => {
    const result = createAdapters({ codeHost: { type: "gitlab" } });
    expect(result.codeHost).not.toBeNull();
    expect(result.codeHost!.type).toBe("gitlab");
  });

  test("creates linear issue tracker adapter", () => {
    const result = createAdapters({ issueTracker: { type: "linear" } });
    expect(result.issueTracker).not.toBeNull();
    expect(result.issueTracker!.type).toBe("linear");
  });

  test("returns null for unknown adapter type", () => {
    const result = createAdapters({ codeHost: { type: "bitbucket" } });
    expect(result.codeHost).toBeNull();
  });

  test("creates both adapters", () => {
    const result = createAdapters({
      codeHost: { type: "gitlab" },
      issueTracker: { type: "linear" },
    });
    expect(result.codeHost).not.toBeNull();
    expect(result.issueTracker).not.toBeNull();
  });
});
