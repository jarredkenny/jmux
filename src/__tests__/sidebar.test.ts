import { describe, test, expect } from "bun:test";
import { Sidebar } from "../sidebar";
import type { PinnedPaneEntry } from "../sidebar";
import type { SessionInfo } from "../types";
import { makeSessionOtelState } from "../types";
import type { SessionContext, PipelineStatus } from "../adapters/types";

const SIDEBAR_WIDTH = 24;
const makeBlankOtelState = makeSessionOtelState;

function makeSessions(
  entries: Array<{ name: string; directory?: string; gitBranch?: string; project?: string }>,
): SessionInfo[] {
  return entries.map((e, i) => ({
    id: `$${i}`,
    name: e.name,
    attached: i === 0,
    activity: 0,
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
    // No shared parent → ungrouped. Overview block at rows 2-3, sessions start at row 4.
    const row4 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4).toContain("alpha");
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
    // Row 2: overview, Row 3: spacer, Row 4: group header "Code/work"
    const headerRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(headerRow).toContain("Code/work");
    // Row 5: spacer, Row 6: first session in group "api"
    const apiRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[6][i].char,
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
    // Row 2: overview, Row 3: spacer, Row 4: first group header
    const row4 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4).toContain("Code/work");
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
    // Row 2: overview, Row 3: spacer, Row 4: group header, Row 5: spacer, Row 6: api name, Row 7: api detail
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[7][i].char,
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
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
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
      if (grid.cells[r][0].char === "▎") {
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
      if (grid.cells[r][1].char === "●") {
        foundDot = true;
        break;
      }
    }
    expect(foundDot).toBe(true);
  });

  test("shows waiting glyph when agent state is waiting", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    const sessions = makeSessions([{ name: "main" }]);
    sidebar.updateSessions(sessions);
    sidebar.setAgentStateRecord("$0", { state: "waiting", since: Date.now() });
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

  test("renders red error glyph when lastError is set, overriding agent-state/activity", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setAgentStateRecord("$0", { state: "waiting", since: Date.now() });
    sidebar.setActivity("$0", true);
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      lastError: { type: "api_error", timestamp: Date.now() },
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][1].char).toBe("⨯"); // ⨯
    expect(grid.cells[4][1].fg).toBe(1); // palette red
    expect(grid.cells[4][1].bold).toBe(true);
  });

  test("renders MCP-down glyph when failedMcpServers is non-empty, overriding agent-state", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setAgentStateRecord("$0", { state: "running", since: Date.now() });
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      failedMcpServers: new Set(["linear"]),
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][1].char).toBe("⊘"); // ⊘
    expect(grid.cells[4][1].fg).toBe(1);
    expect(grid.cells[4][1].dim).toBe(true);
  });

  test("error glyph wins over MCP-down", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      lastError: { type: "api_error", timestamp: Date.now() },
      failedMcpServers: new Set(["linear"]),
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][1].char).toBe("⨯"); // ⨯
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

    // Row 2: overview → null
    expect(sidebar.getSessionByRow(2)).toBeNull();
    // Row 3: spacer → null
    expect(sidebar.getSessionByRow(3)).toBeNull();
    // Row 4: group header → null
    expect(sidebar.getSessionByRow(4)).toBeNull();
    // Row 5: spacer → null
    expect(sidebar.getSessionByRow(5)).toBeNull();
    // Row 6: first session name row → api
    expect(sidebar.getSessionByRow(6)?.name).toBe("api");
    // Row 7: first session detail row → api
    expect(sidebar.getSessionByRow(7)?.name).toBe("api");
  });

  test("scrolls to show active session when it overflows", () => {
    // Height 10 = 2 header rows + 8 viewport rows
    // Overview block = 2 rows (overview + spacer), each session = 3 rows + 1 spacer
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
    // Overview at row 2, spacer at row 3, first session "a" at row 4
    let grid = sidebar.getGrid();
    const row4 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4).toContain("a");

    // Scroll down past "a"
    sidebar.scrollBy(3);
    grid = sidebar.getGrid();
    // "a" should no longer be visible on row 4
    const row4After = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4After).not.toContain("a");

    // Scroll way past the top — should clamp to 0
    sidebar.scrollBy(-100);
    grid = sidebar.getGrid();
    const row4Reset = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4Reset).toContain("a");
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
    expect(grid.cells[2][SIDEBAR_WIDTH - 1].char).not.toBe("▲");
    expect(grid.cells[9][SIDEBAR_WIDTH - 1].char).toBe("▼");

    // Scroll to middle: should show both
    sidebar.scrollBy(3);
    grid = sidebar.getGrid();
    expect(grid.cells[2][SIDEBAR_WIDTH - 1].char).toBe("▲");
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
    // Row 2: overview, Row 3: spacer, Row 4: group header — chevron at col 1
    expect(grid.cells[4][1].char).toBe("▾"); // ▾
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
    // Row 2: overview, Row 3: spacer, Row 4: group header
    expect(grid.cells[4][1].char).toBe("▸"); // ▸
    const headerText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
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
    // Row 4 is the group header (rows 2,3 are overview+spacer)
    expect(sidebar.getGroupByRow(4)).toBe("Code/work");
    // Row 6 is a session, not a group header
    expect(sidebar.getGroupByRow(6)).toBeNull();
  });

  test("group header row shows hover highlight", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    sidebar.setHoveredRow(4); // group header row (was row 2, now row 4 after overview block)
    const grid = sidebar.getGrid();
    // The header row should have HOVER_BG applied
    expect(grid.cells[4][0].bg).not.toBe(0);
  });

  test("renders cache timer on detail row when set", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main", directory: "~/mydir", gitBranch: "dev" }]),
    );
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailText).toContain("4:0");
  });

  test("timer shows elapsed text when cache expired", () => {
    // Cache expired (360s > 300s TTL) → falls back to elapsed from lastRequestTime
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 360_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailText).toContain("6m");
  });

  test("no timer rendered when cache timer state is null", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main", directory: "~/mydir", gitBranch: "dev" }]),
    );
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailText).not.toMatch(/\d:\d\d/);
  });

  test("timer uses green color when > 180s remaining", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 30_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const row = grid.cells[5];
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
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 200_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const row = grid.cells[5];
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
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 280_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const row = grid.cells[5];
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

  test("timer uses dim when cache expired (elapsed fallback)", () => {
    // Cache expired (400s > 300s TTL) → elapsed text "6m" rendered with dim styling
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 400_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const row = grid.cells[5];
    const detailText = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => row[i].char).join("");
    expect(detailText).toContain("6m");
    // Find the rightmost dim cell that isn't whitespace — that's the timer.
    let timerCol = -1;
    for (let c = row.length - 1; c >= 0; c--) {
      if (row[c].char.trim() && row[c].dim) {
        timerCol = c;
        break;
      }
    }
    expect(timerCol).toBeGreaterThan(0);
    expect(row[timerCol].dim).toBe(true);
  });

  test("timer truncates branch text when space is tight", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api", gitBranch: "very-long-branch-name-here" },
        { name: "web", directory: "~/Code/work/web", gitBranch: "main" },
      ]),
    );
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: group header, Row 5: spacer, Row 6: api name, Row 7: api detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[7][i].char,
    ).join("");
    expect(detailText).toContain("…");
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
    // Row 2: overview, Row 3: spacer, Row 4: "Pinned" group header
    const row4 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
    ).join("");
    expect(row4).toContain("Pinned");
    // Row 5: spacer, Row 6: pinned session "beta"
    const row6 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[6][i].char,
    ).join("");
    expect(row6).toContain("beta");
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
    // Header should still be visible with count (at row 4 after overview block)
    const headerRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
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

  test("updateSessions prunes otelStates for sessions that no longer exist", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "alpha" }, { name: "beta" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      contextTokens: 100000,
    });
    sidebar.setSessionOtelState("$1", {
      ...makeBlankOtelState(),
      contextTokens: 200000,
    });
    expect(sidebar._otelStateCount()).toBe(2);
    // Now drop beta. Its state should be evicted.
    sidebar.updateSessions(makeSessions([{ name: "alpha" }]));
    expect(sidebar._otelStateCount()).toBe(1);
    // Sanity check: alpha's render shouldn't surface beta's context figure.
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: alpha name, Row 5: alpha detail, Row 6: alpha row3
    const text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[6][i].char).join("");
    expect(text).not.toContain("200k");
  });

  test("cacheTimersEnabled false suppresses timer rendering", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeSessionOtelState(),
      lastRequestTime: Date.now() - 60_000,
      cacheWasHit: true,
    });
    sidebar.cacheTimersEnabled = false;
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail
    const detailText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailText).not.toMatch(/\d:\d\d/);
  });

  // Row layout reminder for ungrouped sessions:
  // row 0: jmux header
  // row 1: separator
  // row 2: overview entry (permanent synthetic block)
  // row 3: spacer (after overview block)
  // row 4: first session name (item starts here; spacer follows each session)
  //
  // Every session is uniformly 3 rows tall:
  //   α: rows 4,5,6
  //   spacer: row 7
  //   β: rows 8,9,10
  //   spacer: row 11
  //   γ: rows 12,13,14

  test("every session is 3 rows tall", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
    ]));
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();

    // alpha at rows 4,5,6; spacer at 7; beta at rows 8,9,10
    const row8Text = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[8][i].char,
    ).join("");
    expect(row8Text).toContain("beta");
  });

  test("hovering row 3 keeps hover styling", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
    ]));
    sidebar.setActiveSession("$0");
    // Layout: overview 2, spacer 3, alpha at 4,5,6; spacer 7; beta at 8,9,10.
    // Hover beta's row 3 (row 10).
    sidebar.setHoveredRow(10);
    const grid = sidebar.getGrid();

    // Beta's name row (row 8) should have hover bg painted.
    expect(grid.cells[8][0].bg).toBe((0x1a << 16) | (0x1f << 8) | 0x26);
    // Row 10 (the third row) should also have hover bg.
    expect(grid.cells[10][0].bg).toBe((0x1a << 16) | (0x1f << 8) | 0x26);
  });

  test("session shows context tokens on row 3", () => {
    const width = 30;
    const sidebar = new Sidebar(width, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setActiveSession("$0");
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      contextTokens: 112000,
    });
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: name, Row 5: detail, Row 6: row3
    const text = Array.from({ length: width }, (_, i) => grid.cells[6][i].char).join("");
    expect(text).toContain("112k");
    expect(text).not.toContain("$");
  });

  test("switching active session does not shift layout", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
      { name: "gamma" },
    ]));
    sidebar.setActiveSession("$0");
    const grid1 = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, alpha at 4,5,6, spacer 7, beta at 8,9,10, spacer 11, gamma at 12,13,14
    const before = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid1.cells[12][i].char).join("");

    sidebar.setActiveSession("$1");
    const grid2 = sidebar.getGrid();
    const after = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid2.cells[12][i].char).join("");

    // Same row should still contain whatever was there before (gamma).
    expect(after).toBe(before);
    expect(before).toContain("gamma");
  });

  test("renders P badge in cyan when permissionMode is plan", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      permissionMode: "plan",
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row — no Linear ID, badge anchors at width - 2
    const badgeCell = grid.cells[4][SIDEBAR_WIDTH - 2];
    expect(badgeCell.char).toBe("P");
    expect(badgeCell.fg).toBe(6); // palette cyan
  });

  test("renders A badge in yellow when permissionMode is accept-edits", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      permissionMode: "accept-edits",
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    const badgeCell = grid.cells[4][SIDEBAR_WIDTH - 2];
    expect(badgeCell.char).toBe("A");
    expect(badgeCell.fg).toBe(3);
  });

  test("default mode renders no badge", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", makeBlankOtelState());
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][SIDEBAR_WIDTH - 2].char).toBe(" ");
  });

  test("session name truncates 2 columns earlier when a mode badge is present", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    // 26-col sidebar, col 3 starts the name. With no badge, name has 22 cols.
    // With badge, name has 20 cols.
    const longName = "a".repeat(40);
    sidebar.updateSessions(makeSessions([{ name: longName }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      permissionMode: "plan",
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    const row = grid.cells[4];
    // Find last 'a' col
    let lastA = -1;
    for (let c = 0; c < SIDEBAR_WIDTH; c++) if (row[c].char === "a") lastA = c;
    // Last char before the badge gap should be the ellipsis
    const ellipsisCol = lastA + 1;
    expect(row[ellipsisCol].char).toBe("…");
  });

  test("renders compaction marker for 30s when no mode badge", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      lastCompactionTime: Date.now() - 5_000,
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][SIDEBAR_WIDTH - 2].char).toBe("⊕");
    expect(grid.cells[4][SIDEBAR_WIDTH - 2].dim).toBe(true);
  });

  test("compaction marker disappears after 30s", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      lastCompactionTime: Date.now() - 31_000,
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][SIDEBAR_WIDTH - 2].char).toBe(" ");
  });

  test("plan mode wins over compaction marker", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      permissionMode: "plan",
      lastCompactionTime: Date.now() - 5_000,
    });
    const grid = sidebar.getGrid();

    // Row 2: overview, Row 3: spacer, Row 4: session name row
    expect(grid.cells[4][SIDEBAR_WIDTH - 2].char).toBe("P");
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
    // Row 2: overview, Row 3: spacer, Row 4: session name row
    const nameRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[4][i].char,
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
    // Row 2: overview, Row 3: spacer, Row 4: session name, Row 5: detail row
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[5][i].char,
    ).join("");
    expect(detailRow).toContain("!1");
    expect(detailRow).toContain("✓");
  });

  test("sessions always take 3 rows", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }, { name: "other" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", issueIds: ["ENG-1234"], mrCount: 2,
    }]));
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: api name, Row 5: api detail, Row 6: api row3, Row 7: spacer, Row 8: other name
    const row8text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[8][i].char).join("");
    expect(row8text).toContain("other");
  });

  test("no link data shows clean 3-row session", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }, { name: "other" }]));
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: api name, Row 5: api detail, Row 6: api row3, Row 7: spacer, Row 8: other name
    const row8text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[8][i].char).join("");
    expect(row8text).toContain("other");
  });
});

describe("Sidebar — agent state rendering", () => {
  function makeSidebarWithAgentState(state: "running" | "waiting" | "complete"): Sidebar {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setAgentStateRecord("$1", { state, since: Date.now() });
    return sb;
  }

  test("col-1 glyph for running is ⏵ in palette green", () => {
    const sb = makeSidebarWithAgentState("running");
    const grid = sb.getGrid();
    // Header takes rows 0+1; overview block at rows 2,3; first session's nameRow is row 4.
    const cell = grid.cells[4][1];
    expect(cell.char).toBe("⏵");
    expect(cell.fg).toBe(2);
  });

  test("col-1 glyph for waiting is ! in orange bold", () => {
    const sb = makeSidebarWithAgentState("waiting");
    const grid = sb.getGrid();
    // Row 4: first session name row
    const cell = grid.cells[4][1];
    expect(cell.char).toBe("!");
    expect(cell.fg).toBe(3);
    expect(cell.bold).toBe(true);
  });

  test("col-1 glyph for complete is ✓ in dim blue", () => {
    const sb = makeSidebarWithAgentState("complete");
    const grid = sb.getGrid();
    // Row 4: first session name row
    const cell = grid.cells[4][1];
    expect(cell.char).toBe("✓");
    expect(cell.fg).toBe(4);
    expect(cell.dim).toBe(true);
  });

  test("indicator priority: mcp-down wins over agent-state", () => {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setAgentStateRecord("$1", { state: "running", since: Date.now() });
    const otel = makeSessionOtelState();
    otel.failedMcpServers = new Set(["server-a"]);
    sb.setSessionOtelState("$1", otel);
    const grid = sb.getGrid();
    // Row 4: first session name row
    expect(grid.cells[4][1].char).toBe("⊘");
  });

  test("indicator priority: agent-state wins over activity", () => {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setAgentStateRecord("$1", { state: "complete", since: Date.now() });
    sb.setActivity("$1", true);
    const grid = sb.getGrid();
    // Row 4: first session name row
    expect(grid.cells[4][1].char).toBe("✓");  // not the activity dot
  });

  test("setAgentStateRecord(id, null) clears the record", () => {
    const sb = makeSidebarWithAgentState("running");
    sb.setAgentStateRecord("$1", null);
    sb.setActivity("$1", true);
    const grid = sb.getGrid();
    // Row 4: first session name row
    expect(grid.cells[4][1].char).toBe("●");  // falls back to activity dot
  });

  test("updateSessions prunes orphaned agent-state records", () => {
    const sb = makeSidebarWithAgentState("running");
    sb.updateSessions([]);  // remove the session
    // Indirect assertion: no error, and re-adding the session doesn't show the old state.
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      windowCount: 1,
    };
    sb.updateSessions([session]);
    const grid = sb.getGrid();
    // Row 4: first session name row. No agent state and no activity → indicator column should be empty (space).
    expect(grid.cells[4][1].char).toBe(" ");
  });

  test("row-2 state label appears with the matching color", () => {
    const sb = makeSidebarWithAgentState("running");
    sb.setSessionOtelState("$1", makeSessionOtelState());
    const grid = sb.getGrid();
    // Row 2 of the session (nameRow + 2) is at grid row 6 (header rows 0+1, overview+spacer 2+3, nameRow=4, row3=4+2=6).
    // Find the "RUNNING" label by scanning the row for the first non-space cell
    // that has fg=2 (palette green).
    const row = grid.cells[6];
    let found = "";
    for (const cell of row) {
      if (cell.char !== " " && cell.fg === 2) found += cell.char;
    }
    expect(found).toBe("RUNNING");
  });

  test("row-2 state label preserves the active-row background", () => {
    const sb = new Sidebar(26, 24);
    const session: SessionInfo = {
      id: "$1", name: "alpha", attached: false, activity: 0,
      windowCount: 1,
    };
    sb.updateSessions([session]);
    sb.setActiveSession("$1");
    sb.setAgentStateRecord("$1", { state: "running", since: Date.now() });

    const grid = sb.getGrid();
    // Row 2 of the session (nameRow + 2) is at grid row 6 (header rows 0+1, overview+spacer rows 2+3, nameRow=4).
    const row = grid.cells[6];
    // Find a cell that has fg=2 (green) — that's a RUNNING label cell.
    const labelCell = row.find((cell) => cell.fg === 2 && cell.char !== " ");
    expect(labelCell).toBeDefined();
    if (labelCell) {
      // Active background is 0x1e2a35 packed as RGB.
      expect(labelCell.bg).toBe((0x1e << 16) | (0x2a << 8) | 0x35);
    }
  });
});

describe("Overview entry", () => {
  test("overview row is at the very top (row 2, first content row)", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2).toContain("Command Center");
  });

  test("empty state: zero pinned panes, row 2 still contains 'Command Center'", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    // No setPinnedPanes call — default is empty
    const grid = sidebar.getGrid();
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2).toContain("Command Center");
  });

  test("command center shows a colored agent-state breakdown row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([
      { paneId: "%1", label: "api › claude", homeSessionName: "api", agentState: "running" },
      { paneId: "%2", label: "web › claude", homeSessionName: "web", agentState: "running" },
      { paneId: "%3", label: "db › claude", homeSessionName: "db", agentState: "waiting" },
    ]);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();
    // Header at row 2, breakdown at row 3.
    const row3 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(row3).toContain("2 RUN");
    expect(row3).toContain("1 WAIT");
    expect(row3).not.toContain("DONE"); // no complete panes → omitted
  });

  test("two pinned panes render their labels as nested children", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([
      { paneId: "%1", label: "api › claude", homeSessionName: "api" },
      { paneId: "%2", label: "api › npm test", homeSessionName: "api" },
    ]);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();

    // Overview at row 2, pane entries at rows 3 and 4, spacer at row 5
    let allText = "";
    for (let r = 0; r < 30; r++) {
      allText += Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("") + "\n";
    }
    expect(allText).toContain("claude");
    expect(allText).toContain("npm test");
  });

  test("session that owns a pinned pane shows '(N pinned)' marker", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([
      { paneId: "%1", label: "api › claude", homeSessionName: "api" },
    ]);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();

    let allText = "";
    for (let r = 0; r < 30; r++) {
      allText += Array.from(
        { length: SIDEBAR_WIDTH },
        (_, i) => grid.cells[r][i].char,
      ).join("") + "\n";
    }
    expect(allText).toMatch(/1 pinned/);
  });

  test("getSelectionByRow(2) returns {type:'overview'} after getGrid()", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.getGrid(); // populate row map
    const sel = sidebar.getSelectionByRow(2);
    expect(sel).not.toBeNull();
    expect(sel?.type).toBe("overview");
  });

  test("overview shows pane count when panes are present", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([
      { paneId: "%1", label: "api › claude", homeSessionName: "api" },
      { paneId: "%2", label: "api › npm test", homeSessionName: "api" },
    ]);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const grid = sidebar.getGrid();
    const row2 = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(row2).toContain("2");
    expect(row2).toContain("Command Center");
  });
});
