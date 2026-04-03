import { describe, test, expect } from "bun:test";
import { Sidebar } from "../sidebar";
import type { SessionInfo } from "../types";

const SIDEBAR_WIDTH = 24;

function makeSessions(names: string[]): SessionInfo[] {
  return names.map((name, i) => ({
    id: `$${i}`,
    name,
    attached: i === 0,
    activity: 0,
    attention: false,
    windowCount: 1,
  }));
}

describe("Sidebar", () => {
  test("renders header row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    sidebar.updateSessions(makeSessions(["main"]));
    const grid = sidebar.getGrid();
    const headerText = Array.from({ length: 4 }, (_, i) => grid.cells[0][i].char).join("");
    expect(headerText).toBe("jmux");
  });

  test("renders session names starting at row 2", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    sidebar.updateSessions(makeSessions(["main", "dev"]));
    const grid = sidebar.getGrid();
    // First session: name row is row 2, name starts at col 3
    const name = Array.from({ length: 4 }, (_, i) => grid.cells[2][3 + i].char).join("");
    expect(name).toBe("main");
    // Second session: name row is row 5 (HEADER_ROWS + 1*ROWS_PER_SESSION)
    const name2 = Array.from({ length: 3 }, (_, i) => grid.cells[5][3 + i].char).join("");
    expect(name2).toBe("dev");
  });

  test("highlights active session", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    const sessions = makeSessions(["main", "dev"]);
    sidebar.updateSessions(sessions);
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();
    // Both name row (2) and detail row (3) should have bg set
    expect(grid.cells[2][0].bgMode).not.toBe(0);
    expect(grid.cells[3][0].bgMode).not.toBe(0);
  });

  test("truncates long session names with ellipsis", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    sidebar.updateSessions(makeSessions(["my-very-long-session-name-here"]));
    const grid = sidebar.getGrid();
    const row = grid.cells[2];
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => row[i].char).join("").trimEnd();
    expect(text.length).toBeLessThanOrEqual(SIDEBAR_WIDTH);
    expect(text).toContain("\u2026");
  });

  test("shows git branch right-aligned and dimmed on detail line", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    const sessions = makeSessions(["main"]);
    sessions[0].gitBranch = "feat/x";
    sessions[0].directory = "~/Code/api";
    sidebar.updateSessions(sessions);
    const grid = sidebar.getGrid();
    // Detail line is row 3 (HEADER_ROWS + 0*ROWS_PER_SESSION + 1)
    const row = grid.cells[3];
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => row[i].char).join("");
    expect(text).toContain("feat/x");
    const branchStart = text.indexOf("feat/x");
    expect(row[branchStart].dim).toBe(true);
  });

  test("shows activity indicator at col 1 on name row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    const sessions = makeSessions(["main", "dev"]);
    sidebar.updateSessions(sessions);
    sidebar.setActivity("$0", true);
    sidebar.setActivity("$1", true);
    const grid = sidebar.getGrid();
    // First session: name row 2, indicator at col 1
    expect(grid.cells[2][1].char).toBe("\u25CF");
    // Second session: name row 5, indicator at col 1
    expect(grid.cells[5][1].char).toBe("\u25CF");
  });

  test("shows attention flag at col 1 on name row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    const sessions = makeSessions(["main"]);
    sessions[0].attention = true;
    sidebar.updateSessions(sessions);
    const grid = sidebar.getGrid();
    // Name row 2, indicator at col 1
    expect(grid.cells[2][1].char).toBe("!");
  });

  test("shows window count right-aligned on name line", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    const sessions = makeSessions(["main"]);
    sessions[0].windowCount = 3;
    sidebar.updateSessions(sessions);
    const grid = sidebar.getGrid();
    const row = grid.cells[2];
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => row[i].char).join("");
    expect(text).toContain("3w");
    // Should be right-aligned (last chars)
    const windowCountStr = "3w";
    const lastChars = text.slice(SIDEBAR_WIDTH - windowCountStr.length);
    expect(lastChars).toBe(windowCountStr);
    // Should be dimmed
    const wcStart = SIDEBAR_WIDTH - windowCountStr.length;
    expect(row[wcStart].dim).toBe(true);
  });

  test("shows directory on detail line", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    const sessions = makeSessions(["main"]);
    sessions[0].directory = "~/Code/api";
    sidebar.updateSessions(sessions);
    const grid = sidebar.getGrid();
    // Detail line is row 3
    const row = grid.cells[3];
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => row[i].char).join("");
    expect(text).toContain("~/Code/api");
    const dirStart = text.indexOf("~/Code/api");
    expect(row[dirStart].dim).toBe(true);
  });

  test("keyboard navigation moves highlight", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    sidebar.updateSessions(makeSessions(["a", "b", "c"]));
    sidebar.setActiveSession("$0");
    sidebar.moveHighlight(1);
    expect(sidebar.getHighlightedSessionId()).toBe("$1");
    sidebar.moveHighlight(1);
    expect(sidebar.getHighlightedSessionId()).toBe("$2");
    sidebar.moveHighlight(-1);
    expect(sidebar.getHighlightedSessionId()).toBe("$1");
  });

  test("highlight wraps around", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    sidebar.updateSessions(makeSessions(["a", "b"]));
    sidebar.setActiveSession("$0");
    sidebar.moveHighlight(-1);
    expect(sidebar.getHighlightedSessionId()).toBe("$1");
  });

  test("getSessionByRow maps rows to sessions correctly", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 20);
    sidebar.updateSessions(makeSessions(["a", "b"]));
    // Row 2 = name row of session 0
    expect(sidebar.getSessionByRow(2)?.id).toBe("$0");
    // Row 3 = detail row of session 0
    expect(sidebar.getSessionByRow(3)?.id).toBe("$0");
    // Row 5 = name row of session 1
    expect(sidebar.getSessionByRow(5)?.id).toBe("$1");
    // Row 1 = separator (before sessions)
    expect(sidebar.getSessionByRow(1)).toBeNull();
  });
});
