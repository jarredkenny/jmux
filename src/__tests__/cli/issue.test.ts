import { describe, test, expect } from "bun:test";
import { US } from "../../tmux-fields";
import {
  parseIssueLinkRow,
  findSessionForIssue,
  decideIssueLink,
  slugify,
  computeBranchName,
  computeWorktreePath,
  resolveRepoForIssue,
  expandTilde,
  type IssueLinkRow,
} from "../../cli/issue";
import type { Issue } from "../../adapters/types";
import type { JmuxConfig } from "../../config";
import { homedir } from "os";

const issue = (o: Partial<Issue>): Issue => ({
  id: "uuid",
  identifier: "TRA-123",
  title: "Fix the thing",
  status: "In Progress",
  assignee: null,
  linkedMrUrls: [],
  webUrl: "https://linear.app/x",
  ...o,
});

const linkRow = (o: Partial<IssueLinkRow>): IssueLinkRow => ({
  id: "$1",
  name: "TRA-123",
  issue: "",
  path: "/repo/wt",
  ...o,
});

describe("parseIssueLinkRow", () => {
  test("parses session id, name, issue and path", () => {
    expect(parseIssueLinkRow(["$1", "TRA-1", "TRA-1", "/p"].join(US))).toEqual({
      id: "$1",
      name: "TRA-1",
      issue: "TRA-1",
      path: "/p",
    });
  });

  test("returns null on a short line", () => {
    expect(parseIssueLinkRow("$1\x1fname")).toBeNull();
  });

  test("parses tmux 3.4 output where the separator is octal-escaped (issue #7)", () => {
    expect(parseIssueLinkRow(["$1", "TRA-1", "TRA-1", "/p"].join("\\037"))).toEqual({
      id: "$1",
      name: "TRA-1",
      issue: "TRA-1",
      path: "/p",
    });
  });
});

describe("findSessionForIssue", () => {
  test("finds the session linked to an issue", () => {
    const rows = [linkRow({ name: "a", issue: "" }), linkRow({ name: "b", issue: "TRA-9" })];
    expect(findSessionForIssue(rows, "TRA-9")?.name).toBe("b");
  });

  test("returns null when no session is linked", () => {
    expect(findSessionForIssue([linkRow({ issue: "" })], "TRA-9")).toBeNull();
  });
});

describe("decideIssueLink (strict 1:1 invariant)", () => {
  test("errors when the session does not exist", () => {
    const d = decideIssueLink([], "ghost", "TRA-1");
    expect(d).toEqual({ kind: "error", message: 'session "ghost" not found' });
  });

  test("errors when the issue is already linked to another session", () => {
    const rows = [linkRow({ name: "a", issue: "" }), linkRow({ name: "b", issue: "TRA-1" })];
    const d = decideIssueLink(rows, "a", "TRA-1");
    expect(d.kind).toBe("error");
  });

  test("errors when the session is already linked to a different issue", () => {
    const rows = [linkRow({ name: "a", issue: "TRA-2" })];
    const d = decideIssueLink(rows, "a", "TRA-1");
    expect(d.kind).toBe("error");
  });

  test("is a no-op when re-linking the same pair (idempotent)", () => {
    const rows = [linkRow({ name: "a", issue: "TRA-1" })];
    expect(decideIssueLink(rows, "a", "TRA-1")).toEqual({ kind: "noop" });
  });

  test("is ok for an unlinked session and a free issue", () => {
    const rows = [linkRow({ name: "a", issue: "" })];
    expect(decideIssueLink(rows, "a", "TRA-1")).toEqual({ kind: "ok" });
  });
});

describe("slugify", () => {
  test("lowercases, collapses non-alphanumerics, trims dashes", () => {
    expect(slugify("Fix the Auth! Bug")).toBe("fix-the-auth-bug");
  });

  test("truncates long titles without a trailing dash", () => {
    const s = slugify("a".repeat(30) + " " + "b".repeat(30));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("computeBranchName", () => {
  test("prefers the tracker's branchName, sanitized", () => {
    expect(computeBranchName("TRA-1", issue({ branchName: "jarred/tra-1.fix" }))).toBe(
      "jarred/tra-1_fix",
    );
  });

  test("falls back to <issueId>-<slug>", () => {
    expect(computeBranchName("TRA-1", issue({ title: "Fix Auth", branchName: undefined }))).toBe(
      "TRA-1-fix-auth",
    );
  });

  test("falls back to the bare id with no issue", () => {
    expect(computeBranchName("TRA-1", null)).toBe("TRA-1");
  });
});

describe("computeWorktreePath", () => {
  test("places the worktree in a sibling -worktrees directory", () => {
    expect(computeWorktreePath("/Users/j/code/webapp", "TRA-1-fix")).toBe(
      "/Users/j/code/webapp-worktrees/TRA-1-fix",
    );
  });
});

describe("expandTilde", () => {
  test("expands ~ and ~/", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/code")).toBe(`${homedir()}/code`);
  });

  test("leaves absolute paths untouched", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path");
  });
});

describe("resolveRepoForIssue", () => {
  const config: JmuxConfig = {
    issueWorkflow: { teamRepoMap: { Platform: "/repos/backend" } },
  };

  test("prefers an explicit --repo flag", () => {
    expect(resolveRepoForIssue({ repo: "/explicit" }, issue({ team: "Platform" }), config)).toBe(
      "/explicit",
    );
  });

  test("falls back to teamRepoMap by the issue's team", () => {
    expect(resolveRepoForIssue({}, issue({ team: "Platform" }), config)).toBe("/repos/backend");
  });

  test("returns null when nothing resolves", () => {
    expect(resolveRepoForIssue({}, issue({ team: "Unknown" }), config)).toBeNull();
    expect(resolveRepoForIssue({}, null, config)).toBeNull();
  });
});
