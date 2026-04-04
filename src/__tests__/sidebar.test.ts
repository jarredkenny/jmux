import { describe, test, expect } from "bun:test";
import { Sidebar } from "../sidebar";
import type { SessionInfo } from "../types";

const SIDEBAR_WIDTH = 24;

function makeSessions(
  entries: Array<{ name: string; directory?: string; gitBranch?: string }>,
): SessionInfo[] {
  return entries.map((e, i) => ({
    id: `$${i}`,
    name: e.name,
    attached: i === 0,
    activity: 0,
    attention: false,
    windowCount: 1,
    directory: e.directory,
    gitBranch: e.gitBranch,
  }));
}

describe("Sidebar", () => {
  test("renders header row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    const grid = sidebar.getGrid();
    const headerText = Array.from(
      { length: 4 },
      (_, i) => grid.cells[0][1 + i].char,
    ).join("");
    expect(headerText).toBe("jmux");
  });

  test("renders ungrouped sessions without a group header", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "alpha", directory: "~/one" },
        { name: "beta", directory: "~/two" },
      ]),
    );
    const grid = sidebar.getGrid();
    // No shared parent → ungrouped, sessions start at row 2
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2).toContain("alpha");
  });

  test("groups sessions sharing a parent directory", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "frontend", directory: "~/Code/work/frontend" },
        { name: "scratch", directory: "/tmp" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2: group header "Code/work"
    const headerRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(headerRow).toContain("Code/work");
    // Row 3: spacer, Row 4: first session in group "api"
    const apiRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(apiRow).toContain("api");
  });

  test("solo sessions in a directory are ungrouped", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "only-one", directory: "~/Code/work/only-one" },
        { name: "other", directory: "~/somewhere/other" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Neither has a sibling → no group headers, just sessions
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    // Should contain a session name, not a group header
    expect(row2).toContain("only-one");
  });

  test("grouped sessions show branch on detail line", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        {
          name: "api",
          directory: "~/Code/work/api",
          gitBranch: "main",
        },
        {
          name: "web",
          directory: "~/Code/work/web",
          gitBranch: "feat/x",
        },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2: group header, Row 3: spacer, Row 4: api name, Row 5: api detail
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailRow).toContain("main");
    expect(detailRow).not.toContain("Code/work");
  });

  test("ungrouped sessions show directory on detail line", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "solo", directory: "~/mydir", gitBranch: "dev" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2: session name, Row 3: detail
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailRow).toContain("~/mydir");
    expect(detailRow).toContain("dev");
  });

  test("highlights active session with green marker", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main" }, { name: "dev" }]),
    );
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();
    // Find the active session's name row and check for marker
    let foundMarker = false;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][0].char === "\u258e") {
        foundMarker = true;
        break;
      }
    }
    expect(foundMarker).toBe(true);
  });

  test("shows activity indicator", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setActivity("$0", true);
    const grid = sidebar.getGrid();
    let foundDot = false;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][1].char === "\u25CF") {
        foundDot = true;
        break;
      }
    }
    expect(foundDot).toBe(true);
  });

  test("shows attention flag", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    const sessions = makeSessions([{ name: "main" }]);
    sessions[0].attention = true;
    sidebar.updateSessions(sessions);
    const grid = sidebar.getGrid();
    let foundBang = false;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][1].char === "!") {
        foundBang = true;
        break;
      }
    }
    expect(foundBang).toBe(true);
  });

  test("getDisplayOrderIds returns sessions in grouped display order", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "c" },
        { name: "a" },
        { name: "b" },
      ]),
    );
    const ids = sidebar.getDisplayOrderIds();
    // Ungrouped, sorted alphabetically by name
    expect(ids).toEqual(["$1", "$2", "$0"]); // a, b, c
  });

  test("getSessionByRow returns correct session for click handling", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.getGrid(); // must render to populate row map

    // Row 2: group header → null
    expect(sidebar.getSessionByRow(2)).toBeNull();
    // Row 3: spacer → null
    expect(sidebar.getSessionByRow(3)).toBeNull();
    // Row 4: first session name row → api
    expect(sidebar.getSessionByRow(4)?.name).toBe("api");
    // Row 5: first session detail row → api
    expect(sidebar.getSessionByRow(5)?.name).toBe("api");
  });

  test("shows window count", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    const sessions = makeSessions([{ name: "main" }]);
    sessions[0].windowCount = 5;
    sidebar.updateSessions(sessions);
    const grid = sidebar.getGrid();
    let found = false;
    for (let r = 2; r < 10; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("5w")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test("scrolls to show active session when it overflows", () => {
    // Height 10 = 2 header rows + 8 viewport rows
    // Each session = 2 rows + 1 spacer = 3 rows, so 8 rows fits ~2.6 sessions
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(
      makeSessions([
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
      ]),
    );
    // Activate last session and scroll to it
    sidebar.setActiveSession("$3");
    sidebar.scrollToActive();
    const grid = sidebar.getGrid();
    // "d" should be visible somewhere in the grid
    let found = false;
    for (let r = 2; r < 10; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("d")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test("scrollBy moves viewport and clamps to bounds", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(
      makeSessions([
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
      ]),
    );
    // First session visible at start
    let grid = sidebar.getGrid();
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2).toContain("a");

    // Scroll down
    sidebar.scrollBy(3);
    grid = sidebar.getGrid();
    // "a" should no longer be on row 2
    const row2After = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2After).not.toContain("a");

    // Scroll way past the top — should clamp to 0
    sidebar.scrollBy(-100);
    grid = sidebar.getGrid();
    const row2Reset = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2Reset).toContain("a");
  });

  test("shows scroll indicators when content overflows", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(
      makeSessions([
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
      ]),
    );
    // At top: should show down indicator but not up
    let grid = sidebar.getGrid();
    expect(grid.cells[2][SIDEBAR_WIDTH - 1].char).not.toBe("\u25b2");
    expect(grid.cells[9][SIDEBAR_WIDTH - 1].char).toBe("\u25bc");

    // Scroll to middle: should show both
    sidebar.scrollBy(3);
    grid = sidebar.getGrid();
    expect(grid.cells[2][SIDEBAR_WIDTH - 1].char).toBe("\u25b2");
  });

  test("scrollToActive snaps back after manual scroll", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(
      makeSessions([
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
      ]),
    );
    sidebar.setActiveSession("$0"); // "a" is active
    // Scroll away from active session
    sidebar.scrollBy(6);
    // Snap back
    sidebar.scrollToActive();
    const grid = sidebar.getGrid();
    // "a" should be visible
    let found = false;
    for (let r = 2; r < 10; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("a")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
