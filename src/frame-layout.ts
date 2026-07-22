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
}

export interface FrameLayout {
  termCols: number;
  termRows: number;
  sidebar: Span | null;
  borderCol: number | null;
  toolbarRows: number;
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

export function computeFrameLayout(input: FrameLayoutInput): FrameLayout {
  const {
    termCols,
    termRows,
    sidebarWidth,
    borderWidth,
    toolbarRows,
    diffState,
    requestedPanelCols,
  } = input;

  const sidebar: Span | null =
    termCols >= SIDEBAR_MIN_TERM_COLS ? { x: 0, w: sidebarWidth } : null;
  const borderCol = sidebar ? sidebar.x + sidebar.w : null;

  const ptyRows = termRows - toolbarRows;

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
    ptyRows,
    mode,
    main,
    divider,
    panel,
  };
}
