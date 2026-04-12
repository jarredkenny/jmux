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
    const grid = renderMrTab(MR, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("Fix auth token refresh");
  });

  test("renders branch info", () => {
    const grid = renderMrTab(MR, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("fix/auth");
    expect(text).toContain("main");
  });

  test("renders pipeline status", () => {
    const grid = renderMrTab(MR, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("passed");
  });

  test("renders approval state", () => {
    const grid = renderMrTab(MR, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("1/2");
  });

  test("renders action hints", () => {
    const grid = renderMrTab(MR, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("[o]");
  });

  test("renders null state", () => {
    const grid = renderMrTab(null, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("No merge request");
  });

  test("renders error state", () => {
    const grid = renderMrTab(null, 40, 20, "Authentication expired — check $GITLAB_TOKEN");
    const text = extractText(grid);
    expect(text).toContain("Authentication expired");
  });

  test("renders draft status indicator", () => {
    const draft: MergeRequest = { ...MR, status: "draft" };
    const grid = renderMrTab(draft, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("Draft");
  });
});
