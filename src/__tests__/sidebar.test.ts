import { describe, test, expect } from "bun:test";
import { Sidebar } from "../sidebar";
import type { PinnedPaneEntry } from "../sidebar";
import type { SessionInfo } from "../types";
import { makeSessionOtelState } from "../types";
import type { SessionContext, PipelineStatus } from "../adapters/types";
import { tokens, frame } from "../chrome-tokens";
import { resolveStateColors } from "../state-colors";

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
      { length: 8 },
      (_, i) => grid.cells[0][1 + i].char,
    ).join("");
    expect(headerText).toBe("Sessions");
  });

  test("header shows a right-aligned agent-state rollup", () => {
    // Wide enough for the label + sort control + the full three-segment tally.
    const sidebar = new Sidebar(40, 30);
    sidebar.updateSessions(makeSessions([
      { name: "a" }, { name: "b" }, { name: "c" }, { name: "d" },
    ]));
    const now = Date.now();
    sidebar.setAgentStateRecord("$0", { state: "running", since: now });
    sidebar.setAgentStateRecord("$1", { state: "running", since: now });
    sidebar.setAgentStateRecord("$2", { state: "waiting", since: now });
    sidebar.setAgentStateRecord("$3", { state: "complete", since: now });
    const grid = sidebar.getGrid();
    const header = Array.from({ length: 40 }, (_, i) => grid.cells[0][i].char).join("");
    // running / waiting / complete counts with the row indicators' glyphs.
    expect(header).toContain("2⏵");
    expect(header).toContain("1!");
    expect(header).toContain("1✓");
    // The label is untouched on the left.
    expect(header).toContain("Sessions");
  });

  test("header rollup omits states with no sessions, and vanishes when none are promoted", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "a" }, { name: "b" }]));
    // Nothing promoted → no rollup; header is the label plus the ⇅ sort icon.
    let header = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => sidebar.getGrid().cells[0][i].char).join("");
    expect(header).toContain("Sessions");
    expect(header).toContain("⇅");
    expect(header).not.toContain("⏵"); // no rollup counts
    expect(header).not.toContain("✓");

    // Only running present → only the running segment appears.
    sidebar.setAgentStateRecord("$0", { state: "running", since: Date.now() });
    header = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => sidebar.getGrid().cells[0][i].char).join("");
    expect(header).toContain("1⏵");
    expect(header).not.toContain("!");
    expect(header).not.toContain("✓");
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

  test("highlights active session with an accent marker", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([{ name: "main" }, { name: "dev" }]),
    );
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();
    // Find the active session's name row and check for marker
    let marker: (typeof grid.cells)[number][number] | null = null;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][0].char === "▎") {
        marker = grid.cells[r][0];
        break;
      }
    }
    expect(marker).not.toBeNull();
    // The rail is the accent, not palette-2 green.
    expect(marker!.fg).toBe(tokens.accent.fg!);
    expect(marker!.fgMode).toBe(tokens.accent.fgMode!);
    expect(marker!.fg).not.toBe(2);
  });

  test("selected row's name renders textPrimary bold, not palette-2 green", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    // Ungrouped sessions render alphabetically ("alpha" before "bravo"), so
    // "alpha" (id $0) is the first session row.
    sidebar.updateSessions(
      makeSessions([{ name: "alpha" }, { name: "bravo" }]),
    );
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();
    // Row 4: first session's name row; name text starts at col 3.
    const cell = grid.cells[4][3];
    expect(cell.char).toBe("a"); // sanity: this is "alpha"'s name row
    expect(cell.fg).toBe(tokens.textPrimary.fg!);
    expect(cell.fgMode).toBe(tokens.textPrimary.fgMode!);
    expect(cell.fg).not.toBe(2);
    expect(cell.bold).toBe(true);
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

  test("activity indicator is neutral (tokens.textTertiary), not green", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setActivity("$0", true);
    const grid = sidebar.getGrid();
    let cell: (typeof grid.cells)[number][number] | null = null;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][1].char === "●") {
        cell = grid.cells[r][1];
        break;
      }
    }
    expect(cell).not.toBeNull();
    expect(cell!.fg).toBe(tokens.textTertiary.fg!);
    expect(cell!.fgMode).toBe(tokens.textTertiary.fgMode!);
    expect(cell!.fg).not.toBe(2);
    expect(cell!.dim).toBe(tokens.textTertiary.dim!);
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

  test("applies configured state color to the waiting indicator, preserving bold", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setStateColors({
      running: { kind: "palette", index: 6 },
      waiting: { kind: "palette", index: 9 },
      complete: { kind: "palette", index: 7 },
    });
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setAgentStateRecord("$0", { state: "waiting", since: Date.now() });
    const grid = sidebar.getGrid();
    let cell: (typeof grid.cells)[number][number] | null = null;
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][1].char === "!") {
        cell = grid.cells[r][1];
        break;
      }
    }
    expect(cell).not.toBeNull();
    expect(cell!.fg).toBe(9); // configured brightred
    expect(cell!.bold).toBe(true); // emphasis preserved
  });

  test("defaults waiting indicator to palette yellow when unconfigured", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setAgentStateRecord("$0", { state: "waiting", since: Date.now() });
    const grid = sidebar.getGrid();
    for (let r = 2; r < 20; r++) {
      if (grid.cells[r][1].char === "!") {
        expect(grid.cells[r][1].fg).toBe(3); // yellow default
        return;
      }
    }
    throw new Error("waiting indicator not found");
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

  test("renders the version on the sidebar's last row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setVersion("1.2.3");
    const grid = sidebar.getGrid();
    const lastRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[9][i].char,
    ).join("");
    expect(lastRow).toContain("v1.2.3");
    expect(sidebar.isVersionRow(9)).toBe(true);
    expect(sidebar.isVersionRow(8)).toBe(false);
  });

  test("isVersionRow is false when no version has been set", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    expect(sidebar.isVersionRow(9)).toBe(false);
  });

  test("plain version text renders in the textTertiary token", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setVersion("1.2.3");
    const grid = sidebar.getGrid();
    const cell = grid.cells[9][1];
    expect(cell.fg).toBe(tokens.textTertiary.fg!);
    expect(cell.fgMode).toBe(tokens.textTertiary.fgMode!);
  });

  test("update-available version text renders in the attention token", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setVersion("1.2.3", "1.3.0");
    const grid = sidebar.getGrid();
    const lastRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[9][i].char,
    ).join("");
    expect(lastRow).toContain("v1.3.0 avail");
    const cell = grid.cells[9][1];
    expect(cell.fg).toBe(tokens.attention.fg!);
    expect(cell.fgMode).toBe(tokens.attention.fgMode!);
  });

  test("the footer version row reserves a row from the viewport, moving the scroll indicator up", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 10);
    sidebar.updateSessions(
      makeSessions([
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
      ]),
    );
    sidebar.setVersion("1.2.3");
    const grid = sidebar.getGrid();
    // Version row occupies the last row (9); the ▼ indicator must move to
    // the row above it rather than colliding with the version text.
    expect(grid.cells[8][SIDEBAR_WIDTH - 1].char).toBe("▼");
    const lastRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[9][i].char,
    ).join("");
    expect(lastRow).toContain("v1.2.3");
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

  test("expanded group header renders 'label ────' hairline, not a chevron", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "api", directory: "~/Code/work/api" },
        { name: "web", directory: "~/Code/work/web" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2: overview, Row 3: spacer, Row 4: group header.
    const row = grid.cells[4];
    // Label starts at col 1 in tokens.textSecondary — no disclosure chevron.
    const label = Array.from({ length: "Code/work".length }, (_, i) => row[1 + i].char).join("");
    expect(label).toBe("Code/work");
    expect(row[1].fg).toBe(tokens.textSecondary.fg!);
    expect(row[1].fgMode).toBe(tokens.textSecondary.fgMode!);
    expect(row.some((c) => c.char === "▾" || c.char === "▸")).toBe(false);
    // After the label + a one-space gap, the rest of the row fills with the
    // hairline rule glyph in the hairline tone, out to the inner edge.
    const fillStart = 1 + label.length + 1;
    expect(row[fillStart].char).toBe(frame.ruleLight);
    expect(row[fillStart].fg).toBe(tokens.ruleHairline.fg!);
    expect(row[SIDEBAR_WIDTH - 1].char).toBe(frame.ruleLight);
  });

  test("collapsed group header keeps the hairline and shows a small count cue", () => {
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
    const row = grid.cells[4];
    const headerText = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => row[i].char,
    ).join("");
    expect(headerText).toContain("Code/work");
    expect(headerText).toContain("(2)");
    expect(headerText).not.toContain("▸");
    expect(headerText).not.toContain("▾");
    // The hairline is still present between the label and the count cue.
    expect(headerText).toContain(frame.ruleLight);
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
  // row 0: "Sessions" header
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

  // Row 3 (context + agent-state label) only exists once a session is
  // promoted; before that it would render blank, which is what made a list of
  // un-promoted sessions look ragged. So height is 2 or 3 by promotion.
  test("a non-promoted session is 2 rows tall", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
    ]));
    sidebar.setActiveSession("$0");
    const grid = sidebar.getGrid();

    // alpha at rows 4,5; spacer at 6; beta at rows 7,8
    const rowText = (r: number) =>
      Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[r][i].char).join("");
    expect(rowText(7)).toContain("beta");
    // The row the old fixed-height layout would have put it on is now blank.
    expect(rowText(8)).not.toContain("beta");
  });

  test("a promoted session is 3 rows tall — the state row reappears", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
    ]));
    sidebar.setActiveSession("$0");
    sidebar.setAgentStateRecord("$0", { state: "running", since: Date.now() });
    const grid = sidebar.getGrid();

    // alpha now occupies 4,5,6; spacer at 7; beta starts at 8 again.
    const rowText = (r: number) =>
      Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[r][i].char).join("");
    expect(rowText(6)).toContain("RUNNING");
    expect(rowText(8)).toContain("beta");
  });

  test("hovering row 3 keeps hover styling", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([
      { name: "alpha" },
      { name: "beta" },
    ]));
    sidebar.setActiveSession("$0");
    // Promote beta so it actually HAS a third row to hover.
    sidebar.setAgentStateRecord("$1", { state: "running", since: Date.now() });
    // Layout: overview 2, spacer 3, alpha (non-promoted, 2 rows) at 4,5;
    // spacer 6; beta (promoted, 3 rows) at 7,8,9. Hover beta's third row.
    sidebar.setHoveredRow(9);
    const grid = sidebar.getGrid();

    // Beta's name row (row 7) should have hover bg painted.
    expect(grid.cells[7][0].bg).toBe((0x1a << 16) | (0x1f << 8) | 0x26);
    // Its third row should too — hovering any row highlights the whole slot.
    expect(grid.cells[9][0].bg).toBe((0x1a << 16) | (0x1f << 8) | 0x26);
  });

  test("a promoted session shows context tokens on row 3", () => {
    const width = 30;
    const sidebar = new Sidebar(width, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setActiveSession("$0");
    sidebar.setAgentStateRecord("$0", { state: "running", since: Date.now() });
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

  // A non-promoted session has no row 3, so its context figure moves into
  // row 2's right cluster rather than being lost.
  test("a non-promoted session shows context tokens on row 2", () => {
    const width = 30;
    const sidebar = new Sidebar(width, 30);
    sidebar.updateSessions(makeSessions([{ name: "main" }]));
    sidebar.setActiveSession("$0");
    sidebar.setSessionOtelState("$0", {
      ...makeBlankOtelState(),
      contextTokens: 112000,
    });
    const grid = sidebar.getGrid();
    const rowText = (r: number) =>
      Array.from({ length: width }, (_, i) => grid.cells[r][i].char).join("");
    expect(rowText(5)).toContain("112k");
    // Row 6 belongs to the next item now — nothing of this session is there.
    expect(rowText(6)).not.toContain("112k");
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
    // All three are non-promoted (2 rows each): overview 2, spacer 3,
    // alpha 4,5, spacer 6, beta 7,8, spacer 9, gamma 10,11.
    const before = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid1.cells[10][i].char).join("");

    sidebar.setActiveSession("$1");
    const grid2 = sidebar.getGrid();
    const after = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid2.cells[10][i].char).join("");

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

  test("a non-promoted session with link data still takes 2 rows", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }, { name: "other" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", issueIds: ["ENG-1234"], mrCount: 2,
    }]));
    const grid = sidebar.getGrid();
    // Neither session is promoted, so each is 2 rows: overview 2, spacer 3,
    // api 4,5, spacer 6, other 7.
    const rowText = (r: number) =>
      Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[r][i].char).join("");
    expect(rowText(7)).toContain("other");
  });

  test("no link data shows a clean 2-row session", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }, { name: "other" }]));
    const grid = sidebar.getGrid();
    // Neither session is promoted, so each is 2 rows: overview 2, spacer 3,
    // api 4,5, spacer 6, other 7.
    const rowText = (r: number) =>
      Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[r][i].char).join("");
    expect(rowText(7)).toContain("other");
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

  test("col-1 glyph for complete resolves to the neutral token tone (not palette 8) via the app's default state colors", () => {
    // End-to-end through setStateColors(resolveStateColors(...)) — the same
    // path main.ts drives — rather than the sidebar's raw bootstrap default.
    const sb = makeSidebarWithAgentState("complete");
    sb.setStateColors(resolveStateColors(undefined));
    const grid = sb.getGrid();
    const cell = grid.cells[4][1];
    expect(cell.char).toBe("✓");
    expect(cell.fg).toBe(tokens.textTertiary.fg!);
    expect(cell.fgMode).toBe(tokens.textTertiary.fgMode!);
    expect(cell.dim).toBe(true); // complete's fixed emphasis is preserved
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

  test("pinned panes are NOT listed individually — only the count/breakdown", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.setPinnedPanes([
      { paneId: "%1", label: "api › claude", homeSessionName: "api" },
      { paneId: "%2", label: "api › npm test", homeSessionName: "api" },
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
    // The individual pane labels must NOT appear in the sidebar anymore.
    expect(allText).not.toContain("npm test");
    // But the count is present in the Command Center header.
    expect(allText).toContain("Command Center · 2");
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

describe("Sidebar — sort & filter", () => {
  const WIDTH = 30;

  // Two projects, mixed statuses, so we can prove flat status sort crosses
  // project boundaries and pulls waiting to the very top.
  function seeded(): Sidebar {
    const sb = new Sidebar(WIDTH, 40);
    sb.updateSessions(makeSessions([
      { name: "alpha", project: "proj-a" },   // $0 running
      { name: "bravo", project: "proj-a" },    // $1 waiting
      { name: "charlie", project: "proj-b" },  // $2 idle
      { name: "delta", project: "proj-b" },    // $3 waiting
    ]));
    const now = Date.now();
    sb.setAgentStateRecord("$0", { state: "running", since: now });
    sb.setAgentStateRecord("$1", { state: "waiting", since: now });
    sb.setAgentStateRecord("$3", { state: "waiting", since: now });
    return sb;
  }

  const linesWith = (sb: Sidebar, needle: string): number => {
    const g = sb.getGrid();
    let row = -1;
    for (let r = 0; r < g.rows; r++) {
      const t = Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("");
      if (t.includes(needle)) { row = r; break; }
    }
    return row;
  };

  test("status sort pulls waiting to the top across projects, dropping group headers", () => {
    const sb = seeded();
    sb.setSortMode("status");
    const g = sb.getGrid();
    const all = Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("")).join("\n");
    // No project group headers in a flat mode.
    expect(all).not.toContain("proj-a");
    expect(all).not.toContain("proj-b");
    // Both waiting sessions appear above both non-waiting ones.
    const bravo = linesWith(sb, "bravo");   // waiting
    const delta = linesWith(sb, "delta");   // waiting
    const alpha = linesWith(sb, "alpha");   // running
    const charlie = linesWith(sb, "charlie"); // idle
    expect(Math.max(bravo, delta)).toBeLessThan(Math.min(alpha, charlie));
  });

  test("attention filter hides non-waiting sessions; Command Center stays", () => {
    const sb = seeded();
    sb.setFilterMode("attention");
    const g = sb.getGrid();
    const all = Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("")).join("\n");
    expect(all).toContain("Command Center");
    expect(all).toContain("bravo");   // waiting → shown
    expect(all).toContain("delta");   // waiting → shown
    expect(all).not.toContain("alpha");   // running → hidden
    expect(all).not.toContain("charlie"); // idle → hidden
  });

  test("project mode + attention filter hides a fully-filtered group", () => {
    const sb = seeded();
    // proj-b: charlie (idle, hidden) + delta (waiting, shown) → group stays.
    // Make a third project entirely non-waiting to prove it vanishes.
    sb.updateSessions(makeSessions([
      { name: "alpha", project: "proj-a" },
      { name: "bravo", project: "proj-a" },
      { name: "solo", project: "proj-c" },
    ]));
    sb.setAgentStateRecord("$1", { state: "waiting", since: Date.now() });
    // proj-c/solo has no waiting → whole group hidden under attention filter.
    sb.setFilterMode("attention");
    const g = sb.getGrid();
    const all = Array.from({ length: g.rows }, (_, r) =>
      Array.from({ length: WIDTH }, (_, i) => g.cells[r][i].char).join("")).join("\n");
    expect(all).toContain("proj-a");    // has a waiting session
    expect(all).toContain("bravo");
    expect(all).not.toContain("proj-c"); // fully filtered → header gone
    expect(all).not.toContain("solo");
  });

  test("header names the active sort and filter", () => {
    const sb = new Sidebar(40, 40); // wide enough for label + control + filter
    sb.updateSessions(makeSessions([{ name: "alpha" }]));
    sb.setAgentStateRecord("$0", { state: "waiting", since: Date.now() });
    const header = () => Array.from({ length: 40 }, (_, i) => sb.getGrid().cells[0][i].char).join("");
    expect(header()).toContain("Sessions");
    expect(header()).toContain("⇅ Project");
    sb.setSortMode("status");
    expect(header()).toContain("⇅ Status");
    sb.setFilterMode("attention");
    expect(header()).toContain("· Needs you");
  });

  test("cycle helpers return and apply the next mode", () => {
    const sb = seeded();
    expect(sb.getSortMode()).toBe("project");
    expect(sb.cycleSortMode()).toBe("status");
    expect(sb.getSortMode()).toBe("status");
    expect(sb.cycleFilterMode()).toBe("attention");
    expect(sb.getFilterMode()).toBe("attention");
  });

  test("header shows Sessions + a clickable ⇅ sort control naming the mode", () => {
    const sb = seeded();
    const header = () => Array.from({ length: WIDTH }, (_, i) => sb.getGrid().cells[0][i].char).join("");
    sb.getGrid();
    expect(header()).toContain("Sessions");
    expect(header()).toContain("⇅ Project"); // icon + current mode name
    sb.setSortMode("status");
    expect(header()).toContain("⇅ Status");

    // The control's own columns are the click target; the label and separator
    // rows are not. Find the ⇅ column and assert the hit-test brackets it.
    const row0 = header();
    const iconCol = [...row0].findIndex((c) => c === "⇅");
    expect(sb.headerSortToggleHit(0, iconCol)).toBe(true);         // the icon
    expect(sb.headerSortToggleHit(0, iconCol + 2)).toBe(true);     // the mode name
    expect(sb.headerSortToggleHit(0, 1)).toBe(false);              // "Sessions" label
    expect(sb.headerSortToggleHit(1, iconCol)).toBe(false);        // separator row
    expect(sb.headerSortToggleHit(4, iconCol)).toBe(false);        // a session row
  });

  test("switching sort resets the scroll to the top (no bleed into the header)", () => {
    const sb = new Sidebar(WIDTH, 12); // short viewport so the list overflows
    sb.updateSessions(makeSessions(
      Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, project: "p" })),
    ));
    sb.setAgentStateRecord("$11", { state: "waiting", since: Date.now() });
    sb.scrollBy(20); // scroll far down
    sb.setSortMode("status");
    // Row 1 is the header separator — it must be only rule chars, never a
    // session name bled up from a stale scroll offset.
    const sep = Array.from({ length: WIDTH }, (_, i) => sb.getGrid().cells[1][i].char).join("");
    expect(sep.replace(/[─\s]/g, "")).toBe("");
  });
});
