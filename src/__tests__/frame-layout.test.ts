import { describe, test, expect } from "bun:test";
import {
  computeFrameLayout,
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
