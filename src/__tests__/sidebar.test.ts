import { describe, test, expect } from "bun:test";
import { Sidebar } from "../sidebar";
import type { SessionInfo } from "../types";
import type { SessionContext, PipelineStatus } from "../adapters/types";

const SIDEBAR_WIDTH = 24;

function makeSessions(
  entries: Array<{ name: string; directory?: string; gitBranch?: string; project?: string }>,
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
    project: e.project,
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

  test("solo sessions in a directory still show group header", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "only-one", directory: "~/Code/work/only-one" },
        { name: "other", directory: "~/somewhere/other" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Both have valid group labels → both get group headers
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2).toContain("Code/work");
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

  test("ungrouped sessions show branch on detail line", () => {
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

  test("collapsed group hides its sessions from render", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
        { name: "solo", directory: "~" },
      ]),
    );
    sidebar.toggleGroup("Code/work");
    const grid = sidebar.getGrid();
    let foundApi = false;
    let foundWeb = false;
    for (let r = 0; r < 30; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("api")) foundApi = true;
      if (text.includes("web")) foundWeb = true;
    }
    expect(foundApi).toBe(false);
    expect(foundWeb).toBe(false);
    let foundHeader = false;
    for (let r = 0; r < 30; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("Code/work")) foundHeader = true;
    }
    expect(foundHeader).toBe(true);
  });

  test("collapsed group excludes sessions from displayOrder", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
        { name: "solo", directory: "~" },
      ]),
    );
    sidebar.toggleGroup("Code/work");
    const ids = sidebar.getDisplayOrderIds();
    expect(ids).toEqual(["$2"]);
  });

  test("toggleGroup expands a collapsed group", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.toggleGroup("Code/work"); // collapse
    sidebar.toggleGroup("Code/work"); // expand
    const ids = sidebar.getDisplayOrderIds();
    expect(ids).toEqual(["$0", "$1"]);
  });

  test("expanded group header shows down chevron", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Group header is at row 2, chevron at col 1
    expect(grid.cells[2][1].char).toBe("\u25be"); // ▾
  });

  test("collapsed group header shows right chevron and session count", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.toggleGroup("Code/work");
    const grid = sidebar.getGrid();
    // Group header is at row 2
    expect(grid.cells[2][1].char).toBe("\u25b8"); // ▸
    const headerText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(headerText).toContain("(2)");
  });

  test("getGroupByRow returns group label for header rows", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.getGrid(); // populate row maps
    // Row 2 is the group header
    expect(sidebar.getGroupByRow(2)).toBe("Code/work");
    // Row 4 is a session, not a group header
    expect(sidebar.getGroupByRow(4)).toBeNull();
  });

  test("group header row shows hover highlight", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.setHoveredRow(2); // group header row
    const grid = sidebar.getGrid();
    // The header row should have HOVER_BG applied
    expect(grid.cells[2][0].bg).not.toBe(0);
  });

  test("renders cache timer on detail row when set", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main", directory: "~/mydir", gitBranch: "dev" }]),
    );
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailText).toContain("4:0");
  });

  test("timer shows 0:00 when cache expired", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 360_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailText).toContain("0:00");
  });

  test("no timer rendered when cache timer state is null", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main", directory: "~/mydir", gitBranch: "dev" }]),
    );
    const grid = sidebar.getGrid();
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailText).not.toMatch(/\d:\d\d/);
  });

  test("timer uses green color when > 180s remaining", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 30_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    const row = grid.cells[3];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].fg).toBe(2);
  });

  test("timer uses yellow color when 30-180s remaining", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 200_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    const row = grid.cells[3];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].fg).toBe(3);
  });

  test("timer uses red color when < 30s remaining", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 280_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    const row = grid.cells[3];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].fg).toBe(1);
  });

  test("timer uses dim when expired at 0:00", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 400_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    const row = grid.cells[3];
    let timerColStart = -1;
    for (let c = SIDEBAR_WIDTH - 1; c >= 0; c--) {
      if (row[c].char === ":") {
        timerColStart = c - 1;
        break;
      }
    }
    expect(timerColStart).toBeGreaterThan(0);
    expect(row[timerColStart].dim).toBe(true);
  });

  test("timer truncates branch text when space is tight", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api", gitBranch: "very-long-branch-name-here" },
        { name: "web", directory: "~/Code/work/web", gitBranch: "main" },
      ]),
    );
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row layout: row 2 = group header, row 3 = spacer, row 4 = api name, row 5 = api detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailText).toContain("\u2026");
    expect(detailText).toContain("4:0");
  });

  test("pinned sessions appear in Pinned group at the top", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedSessions(new Set(["beta"]));
    sidebar.updateSessions(
      makeSessions([
        { name: "alpha", directory: "~/Code/work/alpha" },
        { name: "beta", directory: "~/Code/work/beta" },
        { name: "gamma" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2 should be the "Pinned" group header
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2).toContain("Pinned");
    // Row 4 should be the pinned session "beta"
    const row4 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4).toContain("beta");
  });

  test("pinned sessions are excluded from their normal group", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedSessions(new Set(["api"]));
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/server" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Collect all rendered text
    let allText = "";
    for (let r = 0; r < 30; r++) {
      const rowText = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      allText += rowText + "\n";
    }
    // "api" session name should appear once (in Pinned), not also in Code/work
    const apiMatches = allText.split("api").length - 1;
    expect(apiMatches).toBe(1);
    // "Code/work" group should still exist with "web"
    expect(allText).toContain("Code/work");
    expect(allText).toContain("web");
  });

  test("isPinned returns correct state", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedSessions(new Set(["main"]));
    expect(sidebar.isPinned("main")).toBe(true);
    expect(sidebar.isPinned("other")).toBe(false);
  });

  test("Pinned group can be collapsed", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedSessions(new Set(["alpha"]));
    sidebar.updateSessions(
      makeSessions([
        { name: "alpha" },
        { name: "beta" },
      ]),
    );
    sidebar.toggleGroup("Pinned");
    const grid = sidebar.getGrid();
    let foundAlpha = false;
    for (let r = 0; r < 30; r++) {
      const text = Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
      if (text.includes("alpha")) foundAlpha = true;
    }
    expect(foundAlpha).toBe(false);
    // Header should still be visible with count
    const headerRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(headerRow).toContain("Pinned");
    expect(headerRow).toContain("(1)");
  });

  test("no Pinned group when no sessions are pinned", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "alpha" },
        { name: "beta" },
      ]),
    );
    const grid = sidebar.getGrid();
    let allText = "";
    for (let r = 0; r < 30; r++) {
      allText += Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("");
    }
    expect(allText).not.toContain("Pinned");
  });

  test("cacheTimersEnabled false suppresses timer rendering", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setCacheTimer("$0", {
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    sidebar.cacheTimersEnabled = false;
    const grid = sidebar.getGrid();
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailText).not.toMatch(/\d:\d\d/);
  });

  // Row layout reminder for ungrouped sessions:
  // row 0: jmux header
  // row 1: separator
  // row 2: first session name (item starts here; spacer follows each session)
  //
  // So two ungrouped sessions α, β with α expanded (h=3):
  //   α: rows 2,3,4
  //   spacer: row 5
  //   β: rows 6,7
  // With α not expanded (h=2):
  //   α: rows 2,3
  //   spacer: row 4
  //   β: rows 5,6

  test("active session expands to 3 rows", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
    ]));
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();

    // alpha at rows 2,3,4 (expanded); spacer at 5; beta at rows 6,7
    const row6Text = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[6][i].char,
    ).join("");
    expect(row6Text).toContain("beta");
  });

  test("inactive sessions stay at 2 rows", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
      { name: "gamma" },
    ]));
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();

    // alpha (rows 2,3,4) — expanded
    // spacer at 5
    // beta (rows 6,7) — not expanded
    // spacer at 8
    // gamma name at row 9
    const row9Text = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[9][i].char,
    ).join("");
    expect(row9Text).toContain("gamma");
  });

  test("hover overrides active for expansion", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
    ]));
    sidebar.setActiveSession("$0");
    // First render: alpha expanded at 2,3,4; spacer 5; beta name at row 6.
    sidebar.getGrid(); // populate rowToSessionIndex
    sidebar.setHoveredRow(6); // hover beta's name row
    const grid = sidebar.getGrid();

    // Now beta is the expanded session: alpha collapses to 2 rows (2,3),
    // spacer at 4, beta expanded at 5,6,7.
    const row5Text = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(row5Text).toContain("beta");
  });

  test("hovering a group header does not trigger expansion", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "a", project: "proj1" },
      { name: "b", project: "proj1" },
    ]));
    sidebar.setActiveSession("$0");
    // Layout with group + active 'a' (expanded):
    //   row 2: group header
    //   row 3: spacer
    //   rows 4,5,6: 'a' (expanded)
    //   row 7: spacer
    //   rows 8,9: 'b'
    sidebar.getGrid(); // populate rowToSessionIndex with group header at 2
    sidebar.setHoveredRow(2); // hovering group header — should be a no-op for expansion
    const grid = sidebar.getGrid();

    // 'a' should remain expanded. 'b' name still at row 8.
    const row8 = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[8][i].char).join("");
    expect(row8).toContain("b");
  });
});

function makeContexts(
  entries: Array<{ name: string; pipelineState?: PipelineStatus["state"]; issueIds?: string[]; mrCount?: number }>,
): Map<string, SessionContext> {
  const map = new Map<string, SessionContext>();
  for (const e of entries) {
    const mrs: Array<import("../adapters/types").MergeRequest & { source: import("../adapters/types").LinkSource }> = [];
    const now = Date.now();
    if (e.pipelineState) {
      mrs.push({
        id: "proj:1", title: "Test", status: "open",
        sourceBranch: "main", targetBranch: "main",
        pipeline: { state: e.pipelineState, webUrl: "" },
        approvals: { required: 0, current: 0 },
        webUrl: "", source: "branch",
        createdAt: now,
      });
    }
    for (let i = 0; i < (e.mrCount ?? 0); i++) {
      mrs.push({
        id: `proj:mr-${i}`, title: `MR ${i}`, status: "open",
        sourceBranch: "feat", targetBranch: "main",
        pipeline: null, approvals: { required: 0, current: 0 },
        webUrl: "", source: "manual",
        createdAt: now - (e.mrCount! - i) * 1000,
      });
    }
    map.set(e.name, {
      sessionName: e.name,
      dir: "/tmp",
      branch: "main",
      remote: null,
      mrs,
      issues: (e.issueIds ?? []).map((id) => ({
        id, identifier: id, title: "Test", status: "In Progress",
        assignee: null, linkedMrUrls: [], webUrl: "", source: "manual" as import("../adapters/types").LinkSource,
      })),
      resolvedAt: Date.now(),
    });
  }
  return map;
}

describe("Sidebar pipeline glyphs", () => {
  test("renders pipeline passed glyph", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api", pipelineState: "passed" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("✓");
  });

  test("renders pipeline failed glyph", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api", pipelineState: "failed" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("✗");
  });

  test("renders pipeline running glyph", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api", pipelineState: "running" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("⟳");
  });

  test("no glyph when no session context", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).not.toContain("✓");
    expect(allChars).not.toContain("✗");
    expect(allChars).not.toContain("⟳");
  });

  test("no glyph when session has no MR", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).not.toContain("✓");
    expect(allChars).not.toContain("✗");
  });

  test("pipeline glyph shows state of latest MR", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const ctx = makeContexts([{ name: "api", pipelineState: "running" }]);
    const existing = ctx.get("api")!;
    // Add an older MR with failed pipeline
    existing.mrs.push({
      id: "proj:2", title: "Second", status: "open",
      sourceBranch: "feat", targetBranch: "main",
      pipeline: { state: "failed", webUrl: "" },
      approvals: { required: 0, current: 0 },
      webUrl: "", source: "manual",
      createdAt: Date.now() - 10000, // older
    });
    sidebar.setSessionContexts(ctx);
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    // Latest MR (proj:1 with createdAt: now) has running pipeline
    expect(allChars).toContain("⟳");
  });
});

describe("Sidebar inline link data", () => {
  test("renders linear ID on name row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", issueIds: ["ENG-1234"],
    }]));
    const grid = sidebar.getGrid();
    const nameRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(nameRow).toContain("ENG-1234");
    expect(nameRow).toContain("api");
  });

  test("renders MR ID on detail row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api", gitBranch: "feat/x" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", pipelineState: "passed",
    }]));
    const grid = sidebar.getGrid();
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailRow).toContain("!1");
    expect(detailRow).toContain("✓");
  });

  test("sessions always take 2 rows regardless of link data", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }, { name: "other" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", issueIds: ["ENG-1234"], mrCount: 2,
    }]));
    const grid = sidebar.getGrid();
    // Row 2: api name, Row 3: api detail, Row 4: spacer, Row 5: other name
    const row5text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[5][i].char).join("");
    expect(row5text).toContain("other");
  });

  test("no link data shows clean 2-row session", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }, { name: "other" }]));
    const grid = sidebar.getGrid();
    // Row 2: api name, Row 3: api detail, Row 4: spacer, Row 5: other name
    const row5text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[5][i].char).join("");
    expect(row5text).toContain("other");
  });
});
