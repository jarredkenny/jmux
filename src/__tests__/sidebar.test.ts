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
  }));
}

describe("Sidebar", () => {
  test("renders header row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions(["main"]));
    const grid = sidebar.getGrid();
    const headerText = Array.from({ length: 4 }, (_, i) => grid.cells[0][i].char).join("");
    expect(headerText).toBe("jmux");
  });

  test("renders session names starting at row 2", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions(["main", "dev"]));
    const grid = sidebar.getGrid();
    const name = Array.from({ length: 4 }, (_, i) => grid.cells[2][i].char).join("");
    expect(name).toBe("main");
    const name2 = Array.from({ length: 3 }, (_, i) => grid.cells[3][i].char).join("");
    expect(name2).toBe("dev");
  });

  test("highlights active session", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    const sessions = makeSessions(["main", "dev"]);
    sidebar.updateSessions(sessions);
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();
    expect(grid.cells[2][0].bgMode).not.toBe(0);
  });

  test("truncates long session names with ellipsis", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions(["my-very-long-session-name-here"]));
    const grid = sidebar.getGrid();
    const row = grid.cells[2];
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => row[i].char).join("").trimEnd();
    expect(text.length).toBeLessThanOrEqual(SIDEBAR_WIDTH);
    expect(text).toContain("\u2026");
  });

  test("shows git branch right-aligned and dimmed", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    const sessions = makeSessions(["main"]);
    sessions[0].gitBranch = "feat/x";
    sidebar.updateSessions(sessions);
    const grid = sidebar.getGrid();
    const row = grid.cells[2];
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => row[i].char).join("");
    expect(text).toContain("feat/x");
    const branchStart = text.indexOf("feat/x");
    expect(row[branchStart].dim).toBe(true);
  });

  test("shows activity indicator", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    const sessions = makeSessions(["main", "dev"]);
    sidebar.updateSessions(sessions);
    sidebar.setActivity("$1", true);
    const grid = sidebar.getGrid();
    const row = grid.cells[3];
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => row[i].char).join("");
    expect(text).toContain("\u25CF");
  });

  test("shows attention flag", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    const sessions = makeSessions(["main"]);
    sessions[0].attention = true;
    sidebar.updateSessions(sessions);
    const grid = sidebar.getGrid();
    const row = grid.cells[2];
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => row[i].char).join("");
    expect(text).toContain("!");
  });

  test("keyboard navigation moves highlight", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
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
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions(["a", "b"]));
    sidebar.setActiveSession("$0");
    sidebar.moveHighlight(-1);
    expect(sidebar.getHighlightedSessionId()).toBe("$1");
  });
});
