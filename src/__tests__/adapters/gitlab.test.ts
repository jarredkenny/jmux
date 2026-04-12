import { describe, test, expect, mock, beforeEach } from "bun:test";
import { GitLabAdapter, extractProjectPath } from "../../adapters/gitlab";

describe("extractProjectPath", () => {
  test("extracts from HTTPS URL", () => {
    expect(extractProjectPath("https://gitlab.com/org/repo.git")).toBe("org/repo");
  });

  test("extracts from HTTPS URL without .git", () => {
    expect(extractProjectPath("https://gitlab.com/org/repo")).toBe("org/repo");
  });

  test("extracts from SSH URL", () => {
    expect(extractProjectPath("git@gitlab.com:org/repo.git")).toBe("org/repo");
  });

  test("extracts nested group paths", () => {
    expect(extractProjectPath("https://gitlab.com/org/sub/repo.git")).toBe("org/sub/repo");
  });

  test("returns null for invalid URL", () => {
    expect(extractProjectPath("not-a-url")).toBeNull();
  });
});

describe("GitLabAdapter", () => {
  test("starts in unauthenticated state", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    expect(adapter.type).toBe("gitlab");
    expect(adapter.authState).toBe("unauthenticated");
    expect(adapter.authHint).toBe("$GITLAB_TOKEN or $GITLAB_PRIVATE_TOKEN");
  });

  test("authenticate succeeds with env var", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    process.env.GITLAB_TOKEN = "test-token";
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("ok");
    } finally {
      if (origToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = origToken;
    }
  });

  test("authenticate fails without env var", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    const origPrivate = process.env.GITLAB_PRIVATE_TOKEN;
    const origPersonal = process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
    } finally {
      if (origToken !== undefined) process.env.GITLAB_TOKEN = origToken;
      if (origPersonal !== undefined) process.env.GITLAB_PERSONAL_ACCESS_TOKEN = origPersonal;
      if (origPrivate !== undefined) process.env.GITLAB_PRIVATE_TOKEN = origPrivate;
    }
  });
});
