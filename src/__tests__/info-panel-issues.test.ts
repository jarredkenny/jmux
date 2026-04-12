import { describe, test, expect } from "bun:test";
import { renderIssuesTab } from "../info-panel-issues";
import type { Issue } from "../adapters/types";

function extractText(grid: { cells: Array<Array<{ char: string }>> }): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

const ISSUE: Issue = {
  id: "issue-1",
  identifier: "ENG-1234",
  title: "Fix auth token refresh",
  status: "In Progress",
  assignee: "Jarred",
  linkedMrUrls: ["https://gitlab.com/org/repo/-/merge_requests/42"],
  webUrl: "https://linear.app/team/issue/ENG-1234",
};

describe("renderIssuesTab", () => {
  test("renders issue identifier and title", () => {
    const grid = renderIssuesTab(ISSUE, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("ENG-1234");
    expect(text).toContain("Fix auth token refresh");
  });

  test("renders status", () => {
    const grid = renderIssuesTab(ISSUE, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("In Progress");
  });

  test("renders assignee", () => {
    const grid = renderIssuesTab(ISSUE, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("Jarred");
  });

  test("renders action hints", () => {
    const grid = renderIssuesTab(ISSUE, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("[o]");
    expect(text).toContain("[s]");
  });

  test("renders null state", () => {
    const grid = renderIssuesTab(null, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("No linked issue");
  });

  test("renders error state", () => {
    const grid = renderIssuesTab(null, 40, 20, "Authentication expired — check $LINEAR_API_KEY");
    const text = extractText(grid);
    expect(text).toContain("Authentication expired");
  });

  test("renders with null assignee", () => {
    const unassigned: Issue = { ...ISSUE, assignee: null };
    const grid = renderIssuesTab(unassigned, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("Unassigned");
  });
});
