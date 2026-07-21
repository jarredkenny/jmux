import { describe, test, expect, afterEach } from "bun:test";
import { Sidebar, rebuildSidebarColors } from "../sidebar";
import { setTheme, deriveTheme, DEFAULT_THEME } from "../theme";
import { ColorMode } from "../types";
import type { SessionInfo } from "../types";

const STALE_DARK_SELECTED = 0x1e2a35; // DEFAULT_THEME.selected

function activeSessionList(): SessionInfo[] {
  return [
    { id: "$0", name: "alpha", attached: true, activity: 0, windowCount: 1, directory: "~/one" },
    { id: "$1", name: "beta", attached: false, activity: 0, windowCount: 1, directory: "~/two" },
  ];
}

// Global theme is module-level singleton state; restore it so other suites that
// render the sidebar aren't affected by the light theme applied here.
afterEach(() => {
  setTheme(DEFAULT_THEME);
  rebuildSidebarColors();
});

describe("Sidebar theming — rebuildSidebarColors re-themes the active row", () => {
  test("no cell keeps the stale dark selection background after a light theme is applied", () => {
    const sidebar = new Sidebar(24, 30);
    sidebar.updateSessions(activeSessionList());
    sidebar.setActiveSession("$0"); // drives the active-row highlight

    // Adopt a light terminal background and re-sync sidebar colors.
    setTheme(deriveTheme({ r: 0xfa, g: 0xfa, b: 0xfa }));
    rebuildSidebarColors();
    sidebar.updateSessions(activeSessionList()); // force a fresh render plan

    const grid = sidebar.getGrid();
    const stale: string[] = [];
    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++) {
        const cell = grid.cells[y][x];
        if (cell.bgMode === ColorMode.RGB && cell.bg === STALE_DARK_SELECTED) {
          stale.push(`(${y},${x})='${cell.char}'`);
        }
      }
    }
    expect(stale).toEqual([]);
  });
});
