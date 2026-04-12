// src/__tests__/adapters/linear.test.ts
import { describe, test, expect } from "bun:test";
import { LinearAdapter, extractIssueIdFromBranch } from "../../adapters/linear";

describe("extractIssueIdFromBranch", () => {
  test("extracts from standard branch name", () => {
    expect(extractIssueIdFromBranch("eng-1234-fix-auth")).toBe("ENG-1234");
  });

  test("extracts from branch with prefix", () => {
    expect(extractIssueIdFromBranch("feature/eng-1234-fix-auth")).toBe("ENG-1234");
  });

  test("extracts from branch with nested prefix", () => {
    expect(extractIssueIdFromBranch("jarred/eng-1234-fix-auth")).toBe("ENG-1234");
  });

  test("extracts multi-letter team prefix", () => {
    expect(extractIssueIdFromBranch("platform-42-refactor")).toBe("PLATFORM-42");
  });

  test("returns null for branch with no issue id", () => {
    expect(extractIssueIdFromBranch("main")).toBeNull();
    expect(extractIssueIdFromBranch("feature/add-login")).toBeNull();
  });
});

describe("LinearAdapter", () => {
  test("starts in unauthenticated state", () => {
    const adapter = new LinearAdapter({ type: "linear" });
    expect(adapter.type).toBe("linear");
    expect(adapter.authState).toBe("unauthenticated");
    expect(adapter.authHint).toBe("$LINEAR_API_KEY");
  });

  test("authenticate succeeds with env var", async () => {
    const orig = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_test_key";
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("ok");
    } finally {
      if (orig === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = orig;
    }
  });

  test("authenticate fails without env var", async () => {
    const orig = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
    } finally {
      if (orig !== undefined) process.env.LINEAR_API_KEY = orig;
    }
  });
});
