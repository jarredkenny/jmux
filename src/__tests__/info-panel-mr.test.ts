import { describe, test, expect } from "bun:test";
import { renderMrTab } from "../info-panel-mr";
import type { MergeRequest } from "../adapters/types";

function extractText(grid: { cells: Array<Array<{ char: string }>> }): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

const MR: MergeRequest = {
  id: "123:42",
  title: "Fix auth token refresh",
  status: "open",
  sourceBranch: "fix/auth",
  targetBranch: "main",
  pipeline: { state: "passed", webUrl: "https://example.com" },
  approvals: { required: 2, current: 1 },
  webUrl: "https://example.com/mr/42",
};

describe("renderMrTab", () => {
  test("renders MR title", () => {
    const grid = renderMrTab([{ ...MR, source: "branch" as const }], 40, 20, 0);
    const text = extractText(grid);
    expect(text).toContain("Fix auth token refresh");
  });

  test("renders branch info", () => {
    const grid = renderMrTab([{ ...MR, source: "branch" as const }], 40, 20, 0);
    const text = extractText(grid);
    expect(text).toContain("fix/auth");
    expect(text).toContain("main");
  });

  test("renders pipeline status", () => {
    const grid = renderMrTab([{ ...MR, source: "branch" as const }], 40, 20, 0);
    const text = extractText(grid);
    expect(text).toContain("passed");
  });

  test("renders approval state", () => {
    const grid = renderMrTab([{ ...MR, source: "branch" as const }], 40, 20, 0);
    const text = extractText(grid);
    expect(text).toContain("1/2");
  });

  test("renders action hints", () => {
    const grid = renderMrTab([{ ...MR, source: "branch" as const }], 40, 20, 0);
    const text = extractText(grid);
    expect(text).toContain("[o]");
  });

  test("renders null state", () => {
    const grid = renderMrTab([], 40, 20, 0);
    const text = extractText(grid);
    expect(text).toContain("No merge request");
  });

  test("renders error state", () => {
    const grid = renderMrTab([], 40, 20, 0, "Authentication expired — check $GITLAB_TOKEN");
    const text = extractText(grid);
    expect(text).toContain("Authentication expired");
  });

  test("renders draft status indicator", () => {
    const draft: MergeRequest = { ...MR, status: "draft" };
    const grid = renderMrTab([{ ...draft, source: "branch" as const }], 40, 20, 0);
    const text = extractText(grid);
    expect(text).toContain("Draft");
  });

  test("renders multiple MRs with selection cursor", () => {
    const mr2 = { ...MR, id: "456:2", title: "Second MR" };
    const grid = renderMrTab(
      [{ ...MR, source: "branch" as const }, { ...mr2, source: "manual" as const }],
      40, 30, 1,
    );
    const text = extractText(grid);
    expect(text).toContain("Fix auth token refresh");
    expect(text).toContain("Second MR");
  });

  test("shows auto badge for non-manual source", () => {
    const grid = renderMrTab([{ ...MR, source: "transitive" as const }], 40, 20, 0);
    const text = extractText(grid);
    expect(text).toContain("auto");
  });
});
