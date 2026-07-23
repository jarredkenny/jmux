// Pure column geometry for the whole jmux frame: sidebar │ border │ main │
// divider │ panel, in 0-indexed grid columns. This is the single source of
// truth that main.ts (relayout), InputRouter (hit-testing), and the
// renderer (compositing) all consume — see
// docs/superpowers/plans/2026-07-10-rendering-geometry-seams.md, Seam 2.
//
// No consumers yet; this module is intentionally standalone and pure.

/** A horizontal run of grid columns, 0-indexed, width in columns. */
export type Span = { x: number; w: number };

/** Which layout the diff panel is in: not shown, docked beside main, or covering main. */
export type PanelMode = "single" | "split" | "full";

export interface FrameLayoutInput {
  termCols: number;
  termRows: number;
  sidebarWidth: number;
  /**
   * Width, in columns, of the single-column border/divider gaps in the
   * frame: the gap between the sidebar and main, and the gap between the
   * main/panel divider and the panel. Today this is always 1 (main.ts's
   * BORDER_WIDTH constant) but computeFrameLayout treats it as a caller
   * input rather than hardcoding 1, so there is exactly one place that
   * assumes a border width.
   */
  borderWidth: number;
  toolbarRows: number;
  diffState: "off" | "split" | "full";
  requestedPanelCols: number;
  /** Whether to draw the rule rows (under the toolbar, above the footer). */
  frameRulesEnabled: boolean;
  /** Whether to reserve a footer row at the bottom of the frame. */
  footerEnabled: boolean;
}

/** Which chrome rows are actually shown, after the degradation ladder. */
export interface ChromeVisibility {
  toolbar: boolean;
  topRule: boolean;
  footerRule: boolean;
  footer: boolean;
}

export interface FrameLayout {
  termCols: number;
  termRows: number;
  sidebar: Span | null;
  borderCol: number | null;
  toolbarRows: number;
  /** Row index of the rule under the toolbar, or null when not shown. */
  topRuleRow: number | null;
  /** First row of the content band (the pty). */
  contentTop: number;
  /** Height, in rows, of the content band. Always `=== ptyRows`. */
  contentRows: number;
  /** Row index of the rule above the footer, or null when not shown. */
  footerRuleRow: number | null;
  /** Row index of the footer, or null when not shown. */
  footerRow: number | null;
  /** Which chrome rows resolveChrome decided to actually show. */
  chrome: ChromeVisibility;
  ptyRows: number;
  mode: PanelMode;
  main: Span;
  divider: number | null;
  panel: Span | null;
}

export const SIDEBAR_MIN_TERM_COLS = 80;

const MODE_FOR_DIFF_STATE: Record<FrameLayoutInput["diffState"], PanelMode> = {
  off: "single",
  split: "split",
  full: "full",
};

/**
 * Decides which chrome rows (toolbar, top rule, footer rule, footer) are
 * actually shown, given the caller's requested flags and the terminal's
 * row count. This is the degradation ladder: on short terminals, chrome
 * drops away in a fixed order (footer rule first, then footer, then top
 * rule, then — as an absolute floor — the toolbar itself) so the content
 * band never disappears entirely above 5 rows.
 *
 * Both flags false reproduces today's pre-chrome behaviour exactly: only
 * the toolbar (when toolbarRows > 0) is ever shown.
 */
function resolveChrome(input: FrameLayoutInput): ChromeVisibility {
  const NONE: ChromeVisibility = {
    toolbar: false,
    topRule: false,
    footerRule: false,
    footer: false,
  };
  if (input.toolbarRows === 0) return NONE;
  const rules = input.frameRulesEnabled;
  const footer = input.footerEnabled;
  if (!rules && !footer) {
    return { toolbar: true, topRule: false, footerRule: false, footer: false };
  }
  const r = input.termRows;
  if (r < 6) return NONE;
  if (r < 8) return { toolbar: true, topRule: false, footerRule: false, footer: false };
  if (r < 10) return { toolbar: true, topRule: rules, footerRule: false, footer: false };
  if (r < 12) return { toolbar: true, topRule: rules, footerRule: false, footer };
  return { toolbar: true, topRule: rules, footerRule: rules && footer, footer };
}

export function computeFrameLayout(input: FrameLayoutInput): FrameLayout {
  const {
    termCols,
    termRows,
    sidebarWidth,
    borderWidth,
    toolbarRows: toolbarRowsInput,
    diffState,
    requestedPanelCols,
  } = input;

  const sidebar: Span | null =
    termCols >= SIDEBAR_MIN_TERM_COLS ? { x: 0, w: sidebarWidth } : null;
  const borderCol = sidebar ? sidebar.x + sidebar.w : null;

  const chrome = resolveChrome(input);
  const toolbarRows = chrome.toolbar ? toolbarRowsInput : 0;
  const topRuleRow = chrome.topRule ? toolbarRows : null;
  const contentTop = toolbarRows + (chrome.topRule ? 1 : 0);
  const footerRow = chrome.footer ? termRows - 1 : null;
  const footerRuleRow = chrome.footerRule ? termRows - 2 : null;
  const contentRows = Math.max(
    1,
    termRows - contentTop - (chrome.footer ? 1 : 0) - (chrome.footerRule ? 1 : 0),
  );
  const ptyRows = contentRows;

  const mainStart = sidebar ? (borderCol as number) + borderWidth : 0;
  const available = termCols - mainStart;

  const mode = MODE_FOR_DIFF_STATE[diffState];

  let main: Span;
  let divider: number | null;
  let panel: Span | null;

  switch (mode) {
    case "single": {
      main = { x: mainStart, w: available };
      divider = null;
      panel = null;
      break;
    }
    case "split": {
      const panelW = requestedPanelCols;
      main = { x: mainStart, w: available - panelW - borderWidth };
      divider = main.x + main.w;
      panel = { x: divider + borderWidth, w: panelW };
      break;
    }
    case "full": {
      // The pty is always resized to main.w, so main keeps the full
      // available width even though the panel visually covers it; the
      // panel overlaps main.x rather than sitting after a divider.
      main = { x: mainStart, w: available };
      divider = null;
      panel = { x: mainStart, w: available };
      break;
    }
  }

  return {
    termCols,
    termRows,
    sidebar,
    borderCol,
    toolbarRows,
    topRuleRow,
    contentTop,
    contentRows,
    footerRuleRow,
    footerRow,
    chrome,
    ptyRows,
    mode,
    main,
    divider,
    panel,
  };
}

/**
 * The row just past the sidebar's last usable row — i.e. the height the
 * sidebar must be resized to so its content band ends exactly where the
 * footer chrome begins, never painting into it. Bottom-exclusive: a sidebar
 * of this height occupies rows `[0, sidebarBottomRow)`.
 *
 * Prefers the footer rule row over the footer row over the raw terminal
 * height, since whichever of those is the topmost reserved footer row is
 * the true boundary — when both are null (footer chrome degraded away on a
 * short terminal, see resolveChrome's degradation ladder), the sidebar gets
 * the full terminal height back, matching pre-chrome behaviour.
 *
 * Every call site that sizes the sidebar (construction and relayout()) must
 * go through this helper so they can't drift from one another or from the
 * footer geometry.
 */
export function sidebarBottomRow(layout: Pick<FrameLayout, "footerRuleRow" | "footerRow" | "termRows">): number {
  return layout.footerRuleRow ?? layout.footerRow ?? layout.termRows;
}
