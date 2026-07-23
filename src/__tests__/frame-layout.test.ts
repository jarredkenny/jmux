import { describe, test, expect } from "bun:test";
import {
  computeFrameLayout,
  sidebarBottomRow,
  SIDEBAR_MIN_TERM_COLS,
  type FrameLayoutInput,
} from "../frame-layout";

describe("computeFrameLayout — sidebar shown, single mode", () => {
  test("places sidebar, border, and main; no divider/panel", () => {
    const input: FrameLayoutInput = {
      termCols: 120,
      termRows: 40,
      sidebarWidth: 26,
      borderWidth: 1,
      toolbarRows: 1,
      diffState: "off",
      requestedPanelCols: 0,
      frameRulesEnabled: false,
      footerEnabled: false,
    };
    const layout = computeFrameLayout(input);

    expect(layout.termCols).toBe(120);
    expect(layout.termRows).toBe(40);
    expect(layout.sidebar).toEqual({ x: 0, w: 26 });
    expect(layout.borderCol).toBe(26);
    expect(layout.toolbarRows).toBe(1);
    expect(layout.ptyRows).toBe(39);
    expect(layout.mode).toBe("single");
    expect(layout.main).toEqual({ x: 27, w: 93 });
    expect(layout.divider).toBeNull();
    expect(layout.panel).toBeNull();
  });

  test("toolbarRows=2 (window-branches row) changes only ptyRows", () => {
    const layout = computeFrameLayout({
      termCols: 120,
      termRows: 40,
      sidebarWidth: 26,
      borderWidth: 1,
      toolbarRows: 2,
      diffState: "off",
      requestedPanelCols: 0,
      frameRulesEnabled: false,
      footerEnabled: false,
    });
    expect(layout.toolbarRows).toBe(2);
    expect(layout.ptyRows).toBe(38);
    expect(layout.main).toEqual({ x: 27, w: 93 });
  });

  test("sidebar shown at the exact SIDEBAR_MIN_TERM_COLS boundary", () => {
    expect(SIDEBAR_MIN_TERM_COLS).toBe(80);
    const layout = computeFrameLayout({
      termCols: 80,
      termRows: 30,
      sidebarWidth: 26,
      borderWidth: 1,
      toolbarRows: 1,
      diffState: "off",
      requestedPanelCols: 0,
      frameRulesEnabled: false,
      footerEnabled: false,
    });
    expect(layout.sidebar).toEqual({ x: 0, w: 26 });
    expect(layout.borderCol).toBe(26);
    expect(layout.main).toEqual({ x: 27, w: 53 });
  });
});

describe("computeFrameLayout — sidebar shown, split mode", () => {
  test("panel takes requestedPanelCols; main shrinks; divider sits between", () => {
    const layout = computeFrameLayout({
      termCols: 120,
      termRows: 40,
      sidebarWidth: 26,
      borderWidth: 1,
      toolbarRows: 1,
      diffState: "split",
      requestedPanelCols: 30,
      frameRulesEnabled: false,
      footerEnabled: false,
    });

    expect(layout.sidebar).toEqual({ x: 0, w: 26 });
    expect(layout.borderCol).toBe(26);
    expect(layout.ptyRows).toBe(39);
    expect(layout.mode).toBe("split");
    expect(layout.main).toEqual({ x: 27, w: 62 });
    expect(layout.divider).toBe(89);
    expect(layout.panel).toEqual({ x: 90, w: 30 });

    const available = layout.termCols - layout.main.x;
    expect(layout.main.w + 1 + (layout.panel as { x: number; w: number }).w).toBe(available);
  });
});

describe("computeFrameLayout — sidebar shown, full mode", () => {
  test("panel overlaps main fully; divider is null; pty stays sized to main.w", () => {
    const layout = computeFrameLayout({
      termCols: 120,
      termRows: 40,
      sidebarWidth: 26,
      borderWidth: 1,
      toolbarRows: 1,
      diffState: "full",
      // requestedPanelCols is irrelevant in full mode — panel is always
      // forced to the full available width, not the requested value.
      requestedPanelCols: 999,
      frameRulesEnabled: false,
      footerEnabled: false,
    });

    expect(layout.mode).toBe("full");
    expect(layout.main).toEqual({ x: 27, w: 93 });
    expect(layout.divider).toBeNull();
    expect(layout.panel).toEqual({ x: 27, w: 93 });
    // The defining property of full mode: panel overlaps main.x exactly,
    // rather than being requestedPanelCols wide starting after a divider.
    expect((layout.panel as { x: number; w: number }).x).toBe(layout.main.x);
    expect((layout.panel as { x: number; w: number }).w).toBe(layout.main.w);
  });
});

describe("computeFrameLayout — sidebar auto-hidden on narrow terminal", () => {
  test("single mode: sidebar/borderCol null, main starts at 0", () => {
    const layout = computeFrameLayout({
      termCols: 79,
      termRows: 30,
      sidebarWidth: 26,
      borderWidth: 1,
      toolbarRows: 1,
      diffState: "off",
      requestedPanelCols: 0,
      frameRulesEnabled: false,
      footerEnabled: false,
    });

    expect(layout.sidebar).toBeNull();
    expect(layout.borderCol).toBeNull();
    expect(layout.ptyRows).toBe(29);
    expect(layout.mode).toBe("single");
    expect(layout.main).toEqual({ x: 0, w: 79 });
    expect(layout.divider).toBeNull();
    expect(layout.panel).toBeNull();
  });

  test("split mode: main/divider/panel computed against full termCols", () => {
    const layout = computeFrameLayout({
      termCols: 79,
      termRows: 30,
      sidebarWidth: 26,
      borderWidth: 1,
      toolbarRows: 1,
      diffState: "split",
      requestedPanelCols: 25,
      frameRulesEnabled: false,
      footerEnabled: false,
    });

    expect(layout.sidebar).toBeNull();
    expect(layout.borderCol).toBeNull();
    expect(layout.mode).toBe("split");
    expect(layout.main).toEqual({ x: 0, w: 53 });
    expect(layout.divider).toBe(53);
    expect(layout.panel).toEqual({ x: 54, w: 25 });

    const available = layout.termCols - layout.main.x;
    expect(layout.main.w + 1 + (layout.panel as { x: number; w: number }).w).toBe(available);
  });

  test("full mode: panel overlaps main at x=0", () => {
    const layout = computeFrameLayout({
      termCols: 79,
      termRows: 30,
      sidebarWidth: 26,
      borderWidth: 1,
      toolbarRows: 1,
      diffState: "full",
      requestedPanelCols: 0,
      frameRulesEnabled: false,
      footerEnabled: false,
    });

    expect(layout.sidebar).toBeNull();
    expect(layout.mode).toBe("full");
    expect(layout.main).toEqual({ x: 0, w: 79 });
    expect(layout.divider).toBeNull();
    expect(layout.panel).toEqual({ x: 0, w: 79 });
  });

  test("sidebar hidden just below the boundary (79 < 80)", () => {
    const layout = computeFrameLayout({
      termCols: SIDEBAR_MIN_TERM_COLS - 1,
      termRows: 30,
      sidebarWidth: 26,
      borderWidth: 1,
      toolbarRows: 1,
      diffState: "off",
      requestedPanelCols: 0,
      frameRulesEnabled: false,
      footerEnabled: false,
    });
    expect(layout.sidebar).toBeNull();
  });
});

describe("computeFrameLayout — borderWidth is threaded through, not hardcoded", () => {
  // FrameLayoutInput.borderWidth generalizes the single hardcoded "1" that
  // both the sidebar/main border and the main/panel divider use throughout
  // the current main.ts (BORDER_WIDTH). computeFrameLayout must place
  // spans using the caller-supplied borderWidth rather than assuming 1, so
  // that all callers (which today always pass borderWidth: 1) share one
  // source of truth instead of five independent "+1"/"-1" sites.
  test("borderWidth=2 widens the sidebar/main gap and the divider/panel gap", () => {
    const layout = computeFrameLayout({
      termCols: 120,
      termRows: 40,
      sidebarWidth: 26,
      borderWidth: 2,
      toolbarRows: 1,
      diffState: "split",
      requestedPanelCols: 30,
      frameRulesEnabled: false,
      footerEnabled: false,
    });

    expect(layout.sidebar).toEqual({ x: 0, w: 26 });
    expect(layout.borderCol).toBe(26);
    // mainStart = borderCol + borderWidth (28, not 27)
    expect(layout.main.x).toBe(28);
    const available = layout.termCols - layout.main.x; // 92
    expect(layout.main).toEqual({ x: 28, w: 60 });
    expect(layout.divider).toBe(88);
    // panel.x = divider + borderWidth (90, not 89)
    expect(layout.panel).toEqual({ x: 90, w: 30 });
    expect(
      layout.main.w + 2 + (layout.panel as { x: number; w: number }).w,
    ).toBe(available);
  });
});

const chromeInput = (over: Partial<FrameLayoutInput> = {}): FrameLayoutInput => ({
  termCols: 200, termRows: 50, sidebarWidth: 26, borderWidth: 1,
  toolbarRows: 1, diffState: "off", requestedPanelCols: 0,
  frameRulesEnabled: true, footerEnabled: true, ...over,
});

describe("chrome rows", () => {
  test("with both flags false, geometry is byte-identical to pre-chrome", () => {
    const g = computeFrameLayout(chromeInput({ frameRulesEnabled: false, footerEnabled: false }));
    expect(g.toolbarRows).toBe(1);
    expect(g.topRuleRow).toBeNull();
    expect(g.contentTop).toBe(1);
    expect(g.contentRows).toBe(49);
    expect(g.ptyRows).toBe(49);
    expect(g.footerRuleRow).toBeNull();
    expect(g.footerRow).toBeNull();
  });

  test("full chrome reserves four rows", () => {
    const g = computeFrameLayout(chromeInput({ termRows: 50 }));
    expect(g.toolbarRows).toBe(1);
    expect(g.topRuleRow).toBe(1);
    expect(g.contentTop).toBe(2);
    expect(g.contentRows).toBe(46);
    expect(g.ptyRows).toBe(46);
    expect(g.footerRuleRow).toBe(48);
    expect(g.footerRow).toBe(49);
  });

  test("two-row toolbar pushes content to row 3", () => {
    const g = computeFrameLayout(chromeInput({ toolbarRows: 2 }));
    expect(g.topRuleRow).toBe(2);
    expect(g.contentTop).toBe(3);
    expect(g.contentRows).toBe(45);
  });

  test("degradation ladder", () => {
    const at = (termRows: number) => {
      const g = computeFrameLayout(chromeInput({ termRows }));
      return { toolbar: g.chrome.toolbar, topRule: g.chrome.topRule, footerRule: g.chrome.footerRule, footer: g.chrome.footer };
    };
    expect(at(24)).toEqual({ toolbar: true, topRule: true, footerRule: true, footer: true });
    expect(at(11)).toEqual({ toolbar: true, topRule: true, footerRule: false, footer: true });
    expect(at(9)).toEqual({ toolbar: true, topRule: true, footerRule: false, footer: false });
    expect(at(7)).toEqual({ toolbar: true, topRule: false, footerRule: false, footer: false });
    expect(at(5)).toEqual({ toolbar: false, topRule: false, footerRule: false, footer: false });
  });

  test("contentRows never below 1, and row bands are contiguous and cover termRows", () => {
    for (const termRows of [5, 6, 8, 10, 12, 24]) {
      for (const toolbarRows of [1, 2]) {
        const g = computeFrameLayout(chromeInput({ termRows, toolbarRows }));
        expect(g.contentRows).toBeGreaterThanOrEqual(1);
        const rows: number[] = [];
        for (let r = 0; r < g.toolbarRows; r++) rows.push(r);
        if (g.topRuleRow !== null) rows.push(g.topRuleRow);
        for (let r = 0; r < g.contentRows; r++) rows.push(g.contentTop + r);
        if (g.footerRuleRow !== null) rows.push(g.footerRuleRow);
        if (g.footerRow !== null) rows.push(g.footerRow);
        const sorted = [...rows].sort((a, b) => a - b);
        expect(new Set(rows).size).toBe(rows.length);
        expect(sorted[0]).toBe(0);
        expect(sorted[sorted.length - 1]).toBe(termRows - 1);
        for (let i = 1; i < sorted.length; i++) expect(sorted[i]).toBe(sorted[i - 1] + 1);
      }
    }
  });
});

// sidebarBottomRow is the single source of truth every sidebar-sizing call
// site (Sidebar construction, relayout()'s sidebar.resize) must use so the
// sidebar's content band ends exactly where the footer chrome begins,
// rather than painting session rows underneath the footer rule/footer —
// see the chrome-visual-language footer-band bugfix.
describe("sidebarBottomRow", () => {
  test("full chrome: bottom-exclusive row is the footer rule row (not termRows)", () => {
    const layout = computeFrameLayout(chromeInput({ termRows: 50 }));
    expect(layout.footerRuleRow).toBe(48);
    expect(layout.footerRow).toBe(49);
    expect(sidebarBottomRow(layout)).toBe(48);
  });

  test("footer row only (no footer rule): bottom-exclusive row is the footer row", () => {
    // resolveChrome's degradation ladder: 10 <= termRows < 12 keeps the
    // footer but drops the footer rule ahead of it.
    const layout = computeFrameLayout(chromeInput({ termRows: 11 }));
    expect(layout.footerRuleRow).toBeNull();
    expect(layout.footerRow).toBe(10);
    expect(sidebarBottomRow(layout)).toBe(10);
  });

  test("no footer chrome at all: sidebar gets the full terminal height back", () => {
    const layout = computeFrameLayout(chromeInput({ termRows: 9 }));
    expect(layout.footerRuleRow).toBeNull();
    expect(layout.footerRow).toBeNull();
    expect(sidebarBottomRow(layout)).toBe(layout.termRows);
  });

  test("both flags disabled (pre-chrome callers): falls all the way back to termRows", () => {
    const layout = computeFrameLayout(chromeInput({ frameRulesEnabled: false, footerEnabled: false }));
    expect(layout.footerRuleRow).toBeNull();
    expect(layout.footerRow).toBeNull();
    expect(sidebarBottomRow(layout)).toBe(layout.termRows);
  });

  test("bottom-exclusive row equals contentTop + contentRows + reserved footer rows, never overlapping content", () => {
    const layout = computeFrameLayout(chromeInput({ termRows: 50 }));
    // The sidebar's height must not reach into the footer rule/footer rows:
    // sidebarBottomRow sits strictly below the content band's last row and
    // strictly at-or-below the first reserved footer row.
    expect(sidebarBottomRow(layout)).toBe(layout.contentTop + layout.contentRows);
  });
});
