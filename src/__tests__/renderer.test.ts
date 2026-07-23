import { describe, test, expect } from "bun:test";
import { sgrForCell, compositeGrids, getModalPosition, getToolbarTabRanges, getToolbarButtonRanges, getToolbarStatusChipRange, buildToolbarButtons, BORDER_CHAR } from "../renderer";
import { createGrid, writeString, textCols } from "../cell-grid";
import { ColorMode } from "../types";
import type { Cell } from "../types";
import type { FrameLayout, PanelMode, Span } from "../frame-layout";
import { tokens, frame } from "../chrome-tokens";

// Hand-rolled FrameLayout fixtures for compositeGrids unit tests. These tests
// use small grid sizes well below frame-layout's SIDEBAR_MIN_TERM_COLS gate
// (80 cols), so computeFrameLayout itself would collapse the sidebar to
// null — this mirrors computeFrameLayout's own arithmetic (border width
// fixed at 1) without that production-only gate, so the geometry stays
// faithful to the real invariants relayout() guarantees.
function makeLayout(opts: {
  sidebarCols?: number | null; // null => no sidebar (narrow terminal)
  mainCols: number;
  toolbarRows?: number;
  panel?: { cols: number; mode: "split" | "full" } | null;
  termRows: number;
  /** Turns on the top rule row (Task 5). */
  frameRulesEnabled?: boolean;
  /** Turns on the footer row + footer rule row (Task 6) — requires frameRulesEnabled. */
  footerEnabled?: boolean;
}): FrameLayout {
  const { sidebarCols = null, mainCols, toolbarRows = 0, panel = null, termRows, frameRulesEnabled = false, footerEnabled = false } = opts;
  const sidebar: Span | null = sidebarCols != null ? { x: 0, w: sidebarCols } : null;
  const borderCol = sidebar ? sidebar.w : null;
  const mainX = sidebar ? sidebar.w + 1 : 0;
  const main: Span = { x: mainX, w: mainCols };

  let divider: number | null = null;
  let panelSpan: Span | null = null;
  let mode: PanelMode = "single";
  if (panel) {
    mode = panel.mode;
    if (panel.mode === "split") {
      divider = mainX + mainCols;
      panelSpan = { x: divider + 1, w: panel.cols };
    } else {
      // Full mode forces panel.w === main.w === available (see
      // computeFrameLayout, frame-layout.ts) — derive from mainCols rather
      // than trusting a caller-supplied width so this helper can't build a
      // layout the real geometry could never produce.
      panelSpan = { x: mainX, w: mainCols };
    }
  }

  const termCols = sidebar
    ? sidebar.w + 1 + mainCols + (mode === "split" ? 1 + (panelSpan?.w ?? 0) : 0)
    : mainCols;

  // These fixtures bypass computeFrameLayout's degradation ladder — callers
  // opt into the footer rows directly via footerEnabled rather than via
  // termRows thresholds, mirroring computeFrameLayout's own arithmetic
  // (frame-layout.ts's resolveChrome) without that production-only gate.
  const topRuleRow = frameRulesEnabled ? toolbarRows : null;
  const contentTop = toolbarRows + (frameRulesEnabled ? 1 : 0);
  const footerRuleRow = footerEnabled ? termRows - 2 : null;
  const footerRow = footerEnabled ? termRows - 1 : null;
  const contentRows = termRows - contentTop - (footerEnabled ? 2 : 0);
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
    chrome: { toolbar: toolbarRows > 0, topRule: frameRulesEnabled, footerRule: footerEnabled, footer: footerEnabled },
    ptyRows: contentRows,
    mode,
    main,
    divider,
    panel: panelSpan,
  };
}

describe("sgrForCell", () => {
  test("returns reset only for default cell", () => {
    const cell: Cell = {
      char: " ",
      width: 1, fg: 0, bg: 0,
      fgMode: ColorMode.Default, bgMode: ColorMode.Default,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0m");
  });

  test("includes bold attribute", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 0, bg: 0,
      fgMode: ColorMode.Default, bgMode: ColorMode.Default,
      bold: true, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;1m");
  });

  test("encodes standard ANSI foreground color 0-7", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 1, bg: 0,
      fgMode: ColorMode.Palette, bgMode: ColorMode.Default,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;31m");
  });

  test("encodes bright ANSI foreground color 8-15", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 9, bg: 0,
      fgMode: ColorMode.Palette, bgMode: ColorMode.Default,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;91m");
  });

  test("encodes 256-color foreground", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 200, bg: 0,
      fgMode: ColorMode.Palette, bgMode: ColorMode.Default,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;38;5;200m");
  });

  test("encodes RGB foreground", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 0xFF8800, bg: 0,
      fgMode: ColorMode.RGB, bgMode: ColorMode.Default,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;38;2;255;136;0m");
  });

  test("encodes background color", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 0, bg: 4,
      fgMode: ColorMode.Default, bgMode: ColorMode.Palette,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;44m");
  });

  test("encodes combined attributes and colors", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 2, bg: 0,
      fgMode: ColorMode.Palette, bgMode: ColorMode.Default,
      bold: true, italic: true, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;1;3;32m");
  });
});

describe("compositeGrids", () => {
  test("returns main grid only when no sidebar", () => {
    const main = createGrid(10, 3);
    writeString(main, 0, 0, "hello");
    const layout = makeLayout({ mainCols: 10, termRows: 3 });
    const result = compositeGrids(layout, main, null);
    expect(result.cols).toBe(10);
    expect(result.cells[0][0].char).toBe("h");
  });

  test("composites sidebar + border + main", () => {
    const sidebar = createGrid(4, 2);
    writeString(sidebar, 0, 0, "side");
    const main = createGrid(6, 2);
    writeString(main, 0, 0, "main!!");
    const layout = makeLayout({ sidebarCols: 4, mainCols: 6, termRows: 2 });
    const result = compositeGrids(layout, main, sidebar);
    // sidebar: 4 cols + border: 1 col + main: 6 cols = 11 cols
    expect(result.cols).toBe(11);
    expect(result.cells[0][0].char).toBe("s");
    expect(result.cells[0][3].char).toBe("e");
    expect(result.cells[0][4].char).toBe(BORDER_CHAR);
    expect(result.cells[0][5].char).toBe("m");
    expect(result.cells[0][10].char).toBe("!");
  });
});

describe("getModalPosition", () => {
  test("centers modal horizontally over entire terminal", () => {
    const pos = getModalPosition(100, 30, 60, 6);
    // totalW = 63, startCol = max(2, floor((100-63)/2) + 1) = max(2, 18+1) = 19
    expect(pos.startCol).toBe(19);
  });

  test("positions modal in upper third vertically", () => {
    const pos = getModalPosition(100, 30, 60, 6);
    // totalH = 9, startRow = max(2, floor((30-9)/3)+1) = max(2, 7+1) = 8
    expect(pos.startRow).toBe(8);
  });

  test("minimum startRow and startCol leave room for border", () => {
    const pos = getModalPosition(20, 6, 18, 5);
    // Very tight — startCol = max(2, ...) = 2, startRow = max(2, ...) = 2
    expect(pos.startCol).toBeGreaterThanOrEqual(2);
    expect(pos.startRow).toBeGreaterThanOrEqual(2);
  });
});

describe("compositeGrids window branch row", () => {
  const tab = (over: Record<string, unknown> = {}) => ({
    windowId: "@1", index: 0, name: "window", active: true,
    bell: false, zoomed: false, ...over,
  });

  test("toolbarRows=2 renders the branch under the tab and offsets main by 2", () => {
    const sidebar = createGrid(6, 6);
    const main = createGrid(20, 4);
    writeString(main, 0, 0, "MAINROW0");
    const toolbar = {
      buttons: [], mainCols: 20, tabs: [tab({ branch: "main" })],
    };
    const layout = makeLayout({ sidebarCols: 6, mainCols: 20, toolbarRows: 2, termRows: 6 });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    expect(result.rows).toBe(6); // main(4) + 2 toolbar rows
    const row1 = result.cells[1].map((c) => c.char).join("");
    expect(row1).toContain("⎇");
    expect(row1).toContain("main");
    // main content shifted down by the 2-row toolbar
    expect(result.cells[2].map((c) => c.char).join("")).toContain("MAINROW0");
  });

  test("layout.toolbarRows=1 renders no branch row, main offset by 1", () => {
    const sidebar = createGrid(6, 4);
    const main = createGrid(20, 3);
    writeString(main, 0, 0, "TOP");
    const toolbar = { buttons: [], mainCols: 20, tabs: [tab({ branch: "main" })] };
    const layout = makeLayout({ sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 4 });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    expect(result.rows).toBe(4); // main(3) + 1 toolbar row
    const allText = result.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
    expect(allText).not.toContain("⎇");
    expect(result.cells[1].map((c) => c.char).join("")).toContain("TOP");
  });

  test("windows with no branch leave their slot blank (no ⎇)", () => {
    const sidebar = createGrid(6, 6);
    const main = createGrid(20, 4);
    const toolbar = {
      buttons: [], mainCols: 20, tabs: [tab({ branch: undefined })],
    };
    const layout = makeLayout({ sidebarCols: 6, mainCols: 20, toolbarRows: 2, termRows: 6 });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    expect(result.cells[1].map((c) => c.char).join("")).not.toContain("⎇");
  });

  // HUMAN DECISION (Finding 1): a non-last tab's branch label may borrow the
  // inter-tab gap — nothing else paints row 1 there — instead of being bound
  // to its own (narrow) tab width. A 3-display-column name like "zsh" would
  // otherwise leave maxLen at 1, rendering a bare "…".
  test("a 3-col window name (zsh) borrows the inter-tab gap and renders more than a bare …", () => {
    const sidebar = createGrid(6, 6);
    const main = createGrid(20, 4);
    const toolbar = {
      buttons: [], mainCols: 20,
      tabs: [
        tab({ windowId: "@1", name: "zsh", branch: "main" }),
        tab({ windowId: "@2", name: "vim", branch: "develop", active: false }),
      ],
    };
    const layout = makeLayout({ sidebarCols: 6, mainCols: 20, toolbarRows: 2, termRows: 6 });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const ranges = getToolbarTabRanges(toolbar);
    const borderCol = layout.borderCol!;
    const zshRange = ranges[0];
    const vimRange = ranges[1];
    const row1 = result.cells[1].map((c) => c.char).join("");
    // zsh's branch-row slot runs from its own startCol up to (not including)
    // vim's startCol — the borrowed gap.
    const slotStart = borderCol + 1 + zshRange.startCol;
    const slotEnd = borderCol + 1 + vimRange.startCol; // exclusive
    const zshSlot = row1.slice(slotStart, slotEnd);
    // Task 7 dropped the tab separator from 3 cols (" │ ") to 2 (space.groupGutter):
    // rowWidth = tabWidth(5) + sepWidth(2) = 7; maxLen = 7 - 2 - iconWidth(2) = 3;
    // truncateToCols("main", 3) = "ma…" (budget 2 + ellipsis).
    expect(zshSlot).toBe(" ⎇ ma… ");
    expect(zshSlot).not.toBe(" ⎇ … "); // the bare-ellipsis regression this pins
  });

  // HUMAN DECISION (Finding 1 rewrite): a single-tab layout never reaches the
  // `tabRanges[i + 1]` branch at all (isLast is trivially true), so it can't
  // tell the widened formula apart from the pre-fix one — the pre-fix code
  // used the exact same `endCol - startCol + 1` expression for every tab, so
  // a last-tab-only assertion is mathematically identical before and after
  // the fix. Two tabs are required to make the test fail against the pre-fix
  // arithmetic: tab "a" is 1 display column wide (own tabWidth = 3), so the
  // pre-fix/narrow bound (maxLen = 3 - 2 - iconWidth(2) = -1) renders nothing
  // for it at all, while the widened budget (rowWidth = next tab's startCol -
  // own startCol = 6, maxLen = 2) renders its full 2-char branch — that's the
  // assertion that actually differs old vs. new. The second tab, "workspace",
  // is last and pins the half of the fix that must stay exactly as before:
  // bounded to its own endCol, never borrowing a gap that isn't there.
  test("a last-tab branch label stays bounded by its own tab width — no overflow past its right edge", () => {
    const sidebar = createGrid(6, 6);
    const main = createGrid(30, 4);
    const toolbar = {
      buttons: [], mainCols: 30,
      tabs: [
        tab({ windowId: "@1", name: "a", branch: "hi" }),
        tab({ windowId: "@2", name: "workspace", branch: "feature/a-really-long-branch-name" }),
      ],
    };
    const layout = makeLayout({ sidebarCols: 6, mainCols: 30, toolbarRows: 2, termRows: 6 });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const ranges = getToolbarTabRanges(toolbar);
    expect(ranges.length).toBe(2);
    const borderCol = layout.borderCol!;
    const row1 = result.cells[1].map((c) => c.char).join("");

    // Non-last tab "a" borrows the inter-tab gap up to "workspace"'s startCol.
    // Under the pre-fix formula (rowWidth = endCol - startCol + 1 = 3) maxLen
    // is <= 0 and this slot renders nothing; this is the part of the test
    // that fails against the pre-fix arithmetic.
    //
    // Task 7 dropped the tab separator from 3 cols to 2 (space.groupGutter):
    // rowWidth = tabWidth(3) + sepWidth(2) = 5; maxLen = 5 - 2 - iconWidth(2) = 1;
    // truncateToCols("hi", 1) = "…" (branch no longer fits at all, unlike the
    // 3-sep "hi" that used to fit exactly).
    const gapSlotStart = borderCol + 1 + ranges[0].startCol;
    const gapSlotEnd = borderCol + 1 + ranges[1].startCol; // exclusive — the borrowed gap
    expect(row1.slice(gapSlotStart, gapSlotEnd)).toBe(" ⎇ … ");

    // Last tab "workspace" stays bounded to its own endCol regardless of the
    // fix — the invariant the widening must not disturb, now exercised by a
    // real non-last neighbor instead of a vacuous single-tab layout.
    const { endCol } = ranges[1];
    const rightEdgeCol = borderCol + 1 + endCol; // last column belonging to the tab
    const withinTab = result.cells[1]
      .slice(borderCol + 1 + ranges[1].startCol, rightEdgeCol + 1)
      .map((c) => c.char).join("");
    expect(withinTab).toBe(" ⎇ featur… ");
    // Nothing from the branch row spills past the last tab's own right edge.
    expect(result.cells[1][rightEdgeCol + 1].char).toBe(" ");
  });

  // HUMAN DECISION (Finding 2 rewrite): `toContain("…")` / `not.toContain(fullBranch)`
  // both hold under the pre-fix formula too — zsh's old maxLen was 1, so a
  // 42-char branch already truncated to a bare "…" before this fix. Only an
  // exact-string assertion, derived from the widened rowWidth arithmetic,
  // fails against the pre-fix maxLen=1 (which would render " ⎇ … " here
  // instead of the 4-char-budget " ⎇ fea… " the widened formula produces).
  test("a long branch under a wide (gap-borrowing) tab still truncates with …", () => {
    const sidebar = createGrid(6, 6);
    const main = createGrid(20, 4);
    const toolbar = {
      buttons: [], mainCols: 20,
      tabs: [
        tab({ windowId: "@1", name: "zsh", branch: "feature/an-extremely-long-branch-name-here" }),
        tab({ windowId: "@2", name: "vim", branch: "develop", active: false }),
      ],
    };
    const layout = makeLayout({ sidebarCols: 6, mainCols: 20, toolbarRows: 2, termRows: 6 });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const ranges = getToolbarTabRanges(toolbar);
    const borderCol = layout.borderCol!;
    const slotStart = borderCol + 1 + ranges[0].startCol;
    const slotEnd = borderCol + 1 + ranges[1].startCol;
    const zshSlot = result.cells[1].slice(slotStart, slotEnd).map((c) => c.char).join("");
    // Task 7 dropped the tab separator from 3 cols to 2 (space.groupGutter):
    // rowWidth = vimRange.startCol - zshRange.startCol = 7; maxLen = 7 - 2 -
    // iconWidth(2) = 3; truncateToCols(branch, 3) = "fe…" (budget 2 + ellipsis).
    expect(zshSlot).toBe(" ⎇ fe… ");
  });
});

describe("compositeGrids with palette overlay", () => {
  test("palette is centered with box border over entire terminal", () => {
    const sidebar = createGrid(6, 20);
    const main = createGrid(40, 18);

    const toolbar = {
      buttons: [],
      mainCols: 40,
      tabs: [],
    };

    // Palette: 14 cols wide, 2 rows tall
    const palette = createGrid(14, 2);
    writeString(palette, 0, 0, "▷ query       ");
    writeString(palette, 1, 0, " result       ");

    const layout = makeLayout({ sidebarCols: 6, mainCols: 40, toolbarRows: 1, termRows: 19 });
    const result = compositeGrids(layout, main, sidebar, toolbar, palette);
    // Total grid: sidebar(6) + border(1) + main(40) = 47 cols, 19 rows
    expect(result.cols).toBe(47);

    const pos = getModalPosition(47, 19, 14, 2);

    // Box border: ┌ at top-left
    expect(result.cells[pos.startRow - 1][pos.startCol - 1].char).toBe("┌");
    // Box border: ┐ at top-right
    expect(result.cells[pos.startRow - 1][pos.startCol + 14].char).toBe("┐");
    // Palette content inside border
    expect(result.cells[pos.startRow][pos.startCol].char).toBe("▷");
    // Box border: └ at bottom-left
    expect(result.cells[pos.startRow + 2][pos.startCol - 1].char).toBe("└");
    // Side border: │ on left
    expect(result.cells[pos.startRow][pos.startCol - 1].char).toBe("│");
  });

  test("main content is dimmed when palette is open", () => {
    const sidebar = createGrid(6, 14);
    const main = createGrid(30, 12);
    writeString(main, 0, 0, "visible row zero");

    const toolbar = {
      buttons: [],
      mainCols: 30,
      tabs: [],
    };

    const palette = createGrid(10, 2);

    const layout = makeLayout({ sidebarCols: 6, mainCols: 30, toolbarRows: 1, termRows: 13 });
    const result = compositeGrids(layout, main, sidebar, toolbar, palette);
    // Main content area starts at col 7 (sidebar 6 + border 1), should be dimmed
    expect(result.cells[1][7].dim).toBe(true);
  });

  test("shadow appears on right and bottom edges", () => {
    const sidebar = createGrid(6, 24);
    const main = createGrid(50, 22);

    const toolbar = {
      buttons: [],
      mainCols: 50,
      tabs: [],
    };

    const palette = createGrid(14, 2);
    const layout = makeLayout({ sidebarCols: 6, mainCols: 50, toolbarRows: 1, termRows: 23 });
    const result = compositeGrids(layout, main, sidebar, toolbar, palette);

    const pos = getModalPosition(57, 23, 14, 2); // totalCols=6+1+50=57, totalRows=22+1=23
    const bRight = pos.startCol + 14; // right border col
    const bBottom = pos.startRow + 2; // bottom border row

    // Shadow cell to the right of the border
    if (bRight + 1 < result.cols) {
      expect(result.cells[pos.startRow][bRight + 1].dim).toBe(true);
    }
    // Shadow cell below the border
    if (bBottom + 1 < result.rows) {
      expect(result.cells[bBottom + 1][pos.startCol].dim).toBe(true);
    }
  });

  test("palette null falls back to normal toolbar, no dimming", () => {
    const sidebar = createGrid(4, 3);
    const main = createGrid(10, 2);

    const toolbar = {
      buttons: [{ label: "＋", id: "new" }],
      mainCols: 10,
      tabs: [],
    };

    const layout = makeLayout({ sidebarCols: 4, mainCols: 10, toolbarRows: 1, termRows: 3 });
    const result = compositeGrids(layout, main, sidebar, toolbar, null);
    expect(result.rows).toBe(3);
    // No dimming when palette is null
    expect(result.cells[1][5].dim).toBe(false);
  });
});

describe("textCols (single character)", () => {
  test("ASCII characters are 1-wide", () => {
    expect(textCols("a")).toBe(1);
    expect(textCols("Z")).toBe(1);
    expect(textCols("0")).toBe(1);
    expect(textCols(" ")).toBe(1);
  });

  test("box-drawing characters are 1-wide", () => {
    // These are universally 1-wide in all terminals
    expect(textCols("─")).toBe(1); // U+2500
    expect(textCols("│")).toBe(1); // U+2502
    expect(textCols("┌")).toBe(1); // U+250C
    expect(textCols("└")).toBe(1); // U+2514
  });

  test("geometric shapes are 1-wide in text presentation", () => {
    // U+25A0-U+25FF: these render as 1-wide in text presentation
    // in modern terminals (Ghostty, iTerm, etc.)
    expect(textCols("●")).toBe(1); // U+25CF
    expect(textCols("▲")).toBe(1); // U+25B2
    expect(textCols("▼")).toBe(1); // U+25BC
    expect(textCols("◈")).toBe(1); // U+25C8
    expect(textCols("▸")).toBe(1); // U+25B8
  });

  test("miscellaneous technical symbols are 1-wide in text presentation", () => {
    // U+2300-U+23FF
    expect(textCols("⏸")).toBe(1); // U+23F8
    expect(textCols("⏏")).toBe(1); // U+23CF
  });

  test("miscellaneous symbols are 1-wide in text presentation", () => {
    // U+2600-U+27BF
    expect(textCols("⚙")).toBe(1); // U+2699 — toolbar settings
  });

  test("CJK Unified Ideographs are 2-wide", () => {
    expect(textCols("你")).toBe(2); // U+4F60
    expect(textCols("好")).toBe(2); // U+597D
    expect(textCols("中")).toBe(2); // U+4E2D
  });

  test("Hangul Syllables are 2-wide", () => {
    expect(textCols("한")).toBe(2); // U+D55C
    expect(textCols("글")).toBe(2); // U+AE00
  });

  test("Fullwidth Forms are 2-wide", () => {
    expect(textCols("＋")).toBe(2); // U+FF0B
    expect(textCols("Ａ")).toBe(2); // U+FF21
  });

  test("emoji are 2-wide", () => {
    expect(textCols("🎉")).toBe(2); // U+1F389
    expect(textCols("🚀")).toBe(2); // U+1F680
  });

  test("general punctuation is 1-wide", () => {
    expect(textCols("–")).toBe(1); // U+2013 en-dash
    expect(textCols("—")).toBe(1); // U+2014 em-dash
    expect(textCols("…")).toBe(1); // U+2026 ellipsis
    expect(textCols("•")).toBe(1); // U+2022 bullet
  });
});

describe("textCols (strings)", () => {
  test("computes width of mixed ASCII and wide characters", () => {
    expect(textCols("hello")).toBe(5);
    expect(textCols("a你b")).toBe(4); // 1+2+1
    expect(textCols("🎉!")).toBe(3);  // 2+1
  });
});

describe("compositeGrids with diff panel", () => {
  test("split mode: sidebar + main + divider + diff panel", () => {
    const sidebar = createGrid(4, 3);
    writeString(sidebar, 0, 0, "side");
    const main = createGrid(20, 3);
    writeString(main, 0, 0, "main content here...");
    const diffGrid = createGrid(10, 3);
    writeString(diffGrid, 0, 0, "diff stuff");

    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 4, mainCols: 20, toolbarRows: 1, termRows: 4,
      panel: { cols: 10, mode: "split" },
    });
    const result = compositeGrids(layout, main, sidebar, toolbar, null, {
      grid: diffGrid,
      mode: "split",
      focused: false,
    });

    // sidebar(4) + border(1) + main(20) + divider(1) + diff(10) = 36
    expect(result.cols).toBe(36);

    // Divider column at position 25 (4+1+20)
    expect(result.cells[1][25].char).toBe("│");
    // Divider is neutral (ruleFrame) — it no longer encodes panel focus
    // (Task 5: the focus cue moved to the rule row's panel underline).
    expect(result.cells[1][25].fg).toBe(tokens.ruleFrame.fg!);
    expect(result.cells[1][25].fgMode).toBe(tokens.ruleFrame.fgMode!);

    // Diff content starts at col 26
    expect(result.cells[1][26].char).toBe("d");
  });

  test("split mode: divider stays neutral (ruleFrame) regardless of diffPanel.focused", () => {
    const sidebar = createGrid(4, 3);
    const main = createGrid(20, 3);
    const diffGrid = createGrid(10, 3);

    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 4, mainCols: 20, toolbarRows: 1, termRows: 4,
      panel: { cols: 10, mode: "split" },
    });
    const result = compositeGrids(layout, main, sidebar, toolbar, null, {
      grid: diffGrid,
      mode: "split",
      focused: true,
    });

    const dividerCol = 4 + 1 + 20;
    // No more blue-when-focused — the divider is neutral either way now.
    expect(result.cells[1][dividerCol].char).toBe("│");
    expect(result.cells[1][dividerCol].fg).toBe(tokens.ruleFrame.fg!);
    expect(result.cells[1][dividerCol].fgMode).toBe(tokens.ruleFrame.fgMode!);
  });

  test("full mode: sidebar + diff panel only, no main", () => {
    const sidebar = createGrid(4, 3);
    // main is sized to mainCols (30, matching toolbar.mainCols below) — in
    // production the pty/bridge are always resized to layout.main.w
    // regardless of diff-panel mode (frame-layout.ts), so main and the
    // panel always agree on width even though the panel visually covers it.
    const main = createGrid(30, 3);
    writeString(main, 0, 0, "should not appear");
    const diffGrid = createGrid(30, 3);
    writeString(diffGrid, 0, 0, "full diff view here");

    const toolbar = { buttons: [], mainCols: 30, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 4, mainCols: 30, toolbarRows: 1, termRows: 4,
      panel: { cols: 30, mode: "full" },
    });
    const result = compositeGrids(layout, main, sidebar, toolbar, null, {
      grid: diffGrid,
      mode: "full",
      focused: true,
    });

    // sidebar(4) + border(1) + diff(30) = 35
    expect(result.cols).toBe(35);

    // Diff content starts right after sidebar border at col 5
    expect(result.cells[1][5].char).toBe("f");
    // Main content should NOT appear
    const row1Chars = result.cells[1].map(c => c.char).join("");
    expect(row1Chars).not.toContain("should");
  });

  test("split mode: modal dimming covers both main and diff panel", () => {
    const sidebar = createGrid(4, 10);
    const main = createGrid(20, 8);
    const diffGrid = createGrid(10, 8);
    const modal = createGrid(6, 2);

    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 4, mainCols: 20, toolbarRows: 1, termRows: 9,
      panel: { cols: 10, mode: "split" },
    });
    const result = compositeGrids(layout, main, sidebar, toolbar, modal, {
      grid: diffGrid,
      mode: "split",
      focused: false,
    });

    // Main area cell should be dimmed (col 5 = sidebar border + 1)
    expect(result.cells[2][6].dim).toBe(true);
    // Diff panel cell should be dimmed (col 26+ area)
    expect(result.cells[2][30].dim).toBe(true);
    // Sidebar should NOT be dimmed
    expect(result.cells[2][0].dim).toBe(false);
  });

  test("toolbar row extends across divider and diff panel in split mode", () => {
    const sidebar = createGrid(4, 4);
    const main = createGrid(20, 3);
    const diffGrid = createGrid(10, 3);

    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 4, mainCols: 20, toolbarRows: 1, termRows: 4,
      panel: { cols: 10, mode: "split" },
    });
    const result = compositeGrids(layout, main, sidebar, toolbar, null, {
      grid: diffGrid,
      mode: "split",
      focused: false,
    });

    expect(result.cols).toBe(36);
  });
});

describe("compositeGrids with panel tab bar", () => {
  test("composites tab bar into toolbar row of panel area in split mode", () => {
    const main = createGrid(40, 10);
    const sidebar = createGrid(24, 11);
    const diffGrid = createGrid(20, 10);
    const tabBar = createGrid(20, 1);
    // Write "Diff" into the tab bar
    const text = "Diff";
    for (let i = 0; i < text.length; i++) {
      tabBar.cells[0][i + 1].char = text[i];
    }

    const layout = makeLayout({
      sidebarCols: 24, mainCols: 40, toolbarRows: 1, termRows: 11,
      panel: { cols: 20, mode: "split" },
    });
    const result = compositeGrids(
      layout,
      main,
      sidebar,
      { buttons: [], mainCols: 40 }, // toolbar config
      null, // no modal
      {
        grid: diffGrid,
        mode: "split",
        focused: false,
        tabBar,
      },
    );

    // Tab bar should be in toolbar row (row 0), starting at panel columns
    // Panel starts at: sidebar(24) + border(1) + main(40) + divider(1) = 66
    const panelStart = 24 + 1 + 40 + 1;
    const tabBarText = Array.from(
      { length: 4 },
      (_, i) => result.cells[0][panelStart + 1 + i].char,
    ).join("");
    expect(tabBarText).toBe("Diff");
  });
});

describe("compositeGrids top rule, junctions, and tab underline", () => {
  const tab = (over: Record<string, unknown> = {}) => ({
    windowId: "@1", index: 0, name: "win", active: false, bell: false, zoomed: false, ...over,
  });

  test("content is painted at contentTop, not at toolbarRows, when the rule is enabled", () => {
    const sidebar = createGrid(6, 8);
    const main = createGrid(20, 6);
    writeString(main, 0, 0, "ROWZERO");
    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 8, frameRulesEnabled: true,
    });
    const result = compositeGrids(layout, main, sidebar, toolbar);

    expect(layout.topRuleRow).toBe(1);
    expect(layout.contentTop).toBe(2);
    expect(result.rows).toBe(8); // layout.termRows, not main.rows + toolbarRows

    const contentRow = result.cells[2].map((c) => c.char).join("");
    expect(contentRow).toContain("ROWZERO");
    // The rule row (1) carries no main content.
    const ruleRow = result.cells[1].map((c) => c.char).join("");
    expect(ruleRow).not.toContain("ROWZERO");
  });

  test("top rule row is a light ruleFrame line across the main area, crossing at the border with ┼", () => {
    const sidebar = createGrid(6, 8);
    const main = createGrid(20, 6);
    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 8, frameRulesEnabled: true,
    });
    const result = compositeGrids(layout, main, sidebar, toolbar);

    const row = layout.topRuleRow!;
    const borderCol = layout.borderCol!;
    for (let x = layout.main.x; x < layout.termCols; x++) {
      expect(result.cells[row][x].char).toBe(frame.ruleLight);
      expect(result.cells[row][x].fg).toBe(tokens.ruleFrame.fg!);
      expect(result.cells[row][x].fgMode).toBe(tokens.ruleFrame.fgMode!);
    }
    expect(result.cells[row][borderCol].char).toBe(frame.crossDown);
    expect(result.cells[row][borderCol].fg).toBe(tokens.ruleFrame.fg!);
    expect(result.cells[row][borderCol].fgMode).toBe(tokens.ruleFrame.fgMode!);
  });

  test("active tab's underline range is heavy and accent-coloured", () => {
    const sidebar = createGrid(6, 8);
    const main = createGrid(20, 6);
    const toolbar = {
      buttons: [], mainCols: 20,
      tabs: [tab({ windowId: "@1", name: "active", active: true })],
    };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 8, frameRulesEnabled: true,
    });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const ranges = getToolbarTabRanges(toolbar);
    const borderCol = layout.borderCol!;
    const row = layout.topRuleRow!;
    const { startCol, endCol } = ranges[0];

    for (let x = borderCol + 1 + startCol; x <= borderCol + 1 + endCol; x++) {
      expect(result.cells[row][x].char).toBe(frame.ruleHeavy);
      expect(result.cells[row][x].fg).toBe(tokens.accent.fg!);
      expect(result.cells[row][x].fgMode).toBe(tokens.accent.fgMode!);
      // The active underline must be full intensity, not inherit the base
      // ruleFrame fill's dim (see chrome-tokens.ts's ruleFrame: dim: true).
      expect(result.cells[row][x].dim).toBeFalsy();
    }

    // The active tab's label (row 0) uses the same accent colour — pin the
    // label/underline colour match so a future change can't drift them apart.
    for (let x = borderCol + 1 + startCol; x <= borderCol + 1 + endCol; x++) {
      expect(result.cells[0][x].fg).toBe(tokens.accent.fg!);
      expect(result.cells[0][x].fgMode).toBe(tokens.accent.fgMode!);
    }
  });

  test("inactive tab's underline range is light and ruleFrame-coloured", () => {
    const sidebar = createGrid(6, 8);
    const main = createGrid(20, 6);
    const toolbar = {
      buttons: [], mainCols: 20,
      tabs: [
        tab({ windowId: "@1", name: "active", active: true }),
        tab({ windowId: "@2", name: "idle", active: false }),
      ],
    };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 8, frameRulesEnabled: true,
    });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const ranges = getToolbarTabRanges(toolbar);
    const borderCol = layout.borderCol!;
    const row = layout.topRuleRow!;
    const idle = ranges.find((r) => r.id === "@2")!;

    for (let x = borderCol + 1 + idle.startCol; x <= borderCol + 1 + idle.endCol; x++) {
      expect(result.cells[row][x].char).toBe(frame.ruleLight);
      expect(result.cells[row][x].fg).toBe(tokens.ruleFrame.fg!);
      expect(result.cells[row][x].fgMode).toBe(tokens.ruleFrame.fgMode!);
      // Idle segments inherit ruleFrame's dim — only active/focus cues are bright.
      expect(result.cells[row][x].dim).toBe(true);
    }
  });

  test("hovered inactive tab's underline is light and accentMuted-coloured", () => {
    const sidebar = createGrid(6, 8);
    const main = createGrid(30, 6);
    const toolbar = {
      buttons: [], mainCols: 30,
      tabs: [
        tab({ windowId: "@1", name: "active", active: true }),
        tab({ windowId: "@2", name: "hovered", active: false }),
      ],
      hoveredTabId: "@2",
    };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 30, toolbarRows: 1, termRows: 8, frameRulesEnabled: true,
    });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const ranges = getToolbarTabRanges(toolbar);
    const borderCol = layout.borderCol!;
    const row = layout.topRuleRow!;
    const hovered = ranges.find((r) => r.id === "@2")!;

    for (let x = borderCol + 1 + hovered.startCol; x <= borderCol + 1 + hovered.endCol; x++) {
      expect(result.cells[row][x].char).toBe(frame.ruleLight);
      expect(result.cells[row][x].fg).toBe(tokens.accentMuted.fg!);
      expect(result.cells[row][x].fgMode).toBe(tokens.accentMuted.fgMode!);
      expect(result.cells[row][x].dim).toBeFalsy();
    }
  });

  test("bell tab (not active) underline is light and attention-coloured — never heavy", () => {
    const sidebar = createGrid(6, 8);
    const main = createGrid(20, 6);
    const toolbar = {
      buttons: [], mainCols: 20,
      tabs: [
        tab({ windowId: "@1", name: "active", active: true }),
        tab({ windowId: "@2", name: "bell", active: false, bell: true }),
      ],
    };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 8, frameRulesEnabled: true,
    });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const ranges = getToolbarTabRanges(toolbar);
    const borderCol = layout.borderCol!;
    const row = layout.topRuleRow!;
    const bell = ranges.find((r) => r.id === "@2")!;

    for (let x = borderCol + 1 + bell.startCol; x <= borderCol + 1 + bell.endCol; x++) {
      expect(result.cells[row][x].char).toBe(frame.ruleLight);
      expect(result.cells[row][x].char).not.toBe(frame.ruleHeavy);
      expect(result.cells[row][x].fg).toBe(tokens.attention.fg!);
      expect(result.cells[row][x].fgMode).toBe(tokens.attention.fgMode!);
      expect(result.cells[row][x].dim).toBeFalsy();
    }
  });

  test("split mode: rule crosses the divider with ┼, divider stays ruleFrame, panel underline carries focus", () => {
    const sidebar = createGrid(4, 8);
    const main = createGrid(20, 6);
    const diffGrid = createGrid(10, 6);
    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 4, mainCols: 20, toolbarRows: 1, termRows: 8,
      panel: { cols: 10, mode: "split" }, frameRulesEnabled: true,
    });

    const focused = compositeGrids(layout, main, sidebar, toolbar, null, {
      grid: diffGrid, mode: "split", focused: true,
    });
    const unfocused = compositeGrids(layout, main, sidebar, toolbar, null, {
      grid: diffGrid, mode: "split", focused: false,
    });

    const row = layout.topRuleRow!;
    const dividerCol = layout.divider!;
    const panelStart = layout.panel!.x;

    // Divider junction on the rule row is neutral crossDown, focused or not.
    for (const result of [focused, unfocused]) {
      expect(result.cells[row][dividerCol].char).toBe(frame.crossDown);
      expect(result.cells[row][dividerCol].fg).toBe(tokens.ruleFrame.fg!);
      expect(result.cells[row][dividerCol].fgMode).toBe(tokens.ruleFrame.fgMode!);
    }

    // The split divider itself (content rows) is neutral regardless of focus.
    const contentRow = layout.contentTop;
    for (const result of [focused, unfocused]) {
      expect(result.cells[contentRow][dividerCol].fg).toBe(tokens.ruleFrame.fg!);
      expect(result.cells[contentRow][dividerCol].fgMode).toBe(tokens.ruleFrame.fgMode!);
    }

    // Panel underline carries the focus cue the divider gave up.
    expect(focused.cells[row][panelStart].fg).toBe(tokens.accent.fg!);
    expect(focused.cells[row][panelStart].fgMode).toBe(tokens.accent.fgMode!);
    expect(unfocused.cells[row][panelStart].fg).toBe(tokens.accentMuted.fg!);
    expect(unfocused.cells[row][panelStart].fgMode).toBe(tokens.accentMuted.fgMode!);

    // Both the focused and muted panel-focus underlines are cues, not the
    // idle rule — neither should be dim.
    expect(focused.cells[row][panelStart].dim).toBeFalsy();
    expect(unfocused.cells[row][panelStart].dim).toBeFalsy();
  });
});

describe("compositeGrids footer row and footer rule", () => {
  test("the footer row paints the supplied cells across the full terminal width", () => {
    const sidebar = createGrid(6, 10);
    const main = createGrid(20, 6);
    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 10,
      frameRulesEnabled: true, footerEnabled: true,
    });
    const footerCells = [{ text: "hello footer" }];
    const result = compositeGrids(layout, main, sidebar, toolbar, null, undefined, footerCells);

    expect(layout.footerRow).toBe(9);
    const row = result.cells[layout.footerRow!].map((c) => c.char).join("");
    expect(row).toContain("hello footer");
  });

  test("footer row is untouched (no main content) when no footer cells are supplied", () => {
    const sidebar = createGrid(6, 10);
    const main = createGrid(20, 6);
    writeString(main, 0, 0, "SHOULD-NOT-APPEAR-IN-FOOTER");
    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 10,
      frameRulesEnabled: true, footerEnabled: true,
    });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const row = result.cells[layout.footerRow!].map((c) => c.char).join("");
    expect(row).not.toContain("SHOULD-NOT-APPEAR-IN-FOOTER");
  });

  test("the footer rule row is a light ruleFrame line, crossing the border with ┴", () => {
    const sidebar = createGrid(6, 10);
    const main = createGrid(20, 6);
    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 10,
      frameRulesEnabled: true, footerEnabled: true,
    });
    const result = compositeGrids(layout, main, sidebar, toolbar);

    const row = layout.footerRuleRow!;
    const borderCol = layout.borderCol!;
    expect(row).toBe(8);
    for (let x = layout.main.x; x < layout.termCols; x++) {
      expect(result.cells[row][x].char).toBe(frame.ruleLight);
      expect(result.cells[row][x].fg).toBe(tokens.ruleFrame.fg!);
      expect(result.cells[row][x].fgMode).toBe(tokens.ruleFrame.fgMode!);
    }
    expect(result.cells[row][borderCol].char).toBe(frame.crossUp);
    expect(result.cells[row][borderCol].fg).toBe(tokens.ruleFrame.fg!);
    expect(result.cells[row][borderCol].fgMode).toBe(tokens.ruleFrame.fgMode!);
  });

  test("in split mode, the footer rule also crosses the divider with ┴", () => {
    const sidebar = createGrid(6, 12);
    const main = createGrid(20, 6);
    const diffGrid = createGrid(10, 6);
    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 12,
      panel: { cols: 10, mode: "split" }, frameRulesEnabled: true, footerEnabled: true,
    });
    const result = compositeGrids(layout, main, sidebar, toolbar, null, {
      grid: diffGrid, mode: "split", focused: false,
    });

    const row = layout.footerRuleRow!;
    const dividerCol = layout.divider!;
    expect(result.cells[row][dividerCol].char).toBe(frame.crossUp);
    expect(result.cells[row][dividerCol].fg).toBe(tokens.ruleFrame.fg!);
    expect(result.cells[row][dividerCol].fgMode).toBe(tokens.ruleFrame.fgMode!);
  });

  test("neither footer row nor footer rule row are painted when both layout fields are null", () => {
    const sidebar = createGrid(6, 8);
    const main = createGrid(20, 6);
    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const layout = makeLayout({
      sidebarCols: 6, mainCols: 20, toolbarRows: 1, termRows: 8, frameRulesEnabled: true,
    });
    expect(layout.footerRow).toBeNull();
    expect(layout.footerRuleRow).toBeNull();
    // Passing footer cells is a no-op when the layout has no footer row.
    const result = compositeGrids(layout, main, sidebar, toolbar, null, undefined, [{ text: "unused" }]);
    const lastRow = result.cells[layout.termRows - 1].map((c) => c.char).join("");
    expect(lastRow).not.toContain("unused");
  });
});

// Task 7: corrected toolbar glyphs, a tighter cluster, and the snapshot
// status chip's relocation to the footer.
describe("buildToolbarButtons (Task 7 glyph set)", () => {
  test("returns the six action buttons in order with the corrected glyphs", () => {
    const buttons = buildToolbarButtons({ panelActive: false });
    expect(buttons.map((b) => b.label)).toEqual(["◧", "+", "◫", "▤", "λ", "⚙"]);
    expect(buttons.map((b) => b.id)).toEqual([
      "panel", "new-window", "split-v", "split-h", "claude", "settings",
    ]);
    // The fullwidth ＋ (2 display columns) is gone — the metric fix this task
    // pins is a 1-column "+".
    expect(textCols(buttons[1].label)).toBe(1);
  });

  test("the panel button carries no accent colour when the diff panel is inactive", () => {
    const [panelBtn] = buildToolbarButtons({ panelActive: false });
    expect(panelBtn.fg).toBeUndefined();
    expect(panelBtn.fgMode).toBeUndefined();
  });

  test("the panel button uses tokens.accent when the diff panel is active", () => {
    const [panelBtn] = buildToolbarButtons({ panelActive: true });
    expect(panelBtn.fg).toBe(tokens.accent.fg!);
    expect(panelBtn.fgMode).toBe(tokens.accent.fgMode!);
  });

  test("the claude button always uses tokens.accent (the hand-written pink is retired)", () => {
    const buttons = buildToolbarButtons({ panelActive: false });
    const claudeBtn = buttons.find((b) => b.id === "claude")!;
    expect(claudeBtn.fg).toBe(tokens.accent.fg!);
    expect(claudeBtn.fgMode).toBe(tokens.accent.fgMode!);
  });

  test("settings stays a plain ⚙ with no VS15 variation selector", () => {
    const buttons = buildToolbarButtons({ panelActive: false });
    const settingsBtn = buttons.find((b) => b.id === "settings")!;
    expect(settingsBtn.label).toBe("⚙");
    expect(settingsBtn.label.length).toBe(1); // no trailing U+FE0E/U+FE0F
    expect(textCols(settingsBtn.label)).toBe(1);
  });
});

// Task 7 follow-up: the button cluster's inter-glyph gutter drops from two
// blank columns to one. Each button's box is glyph + one trailing space
// (space.glyphGutter), packed with no additional gap/separator, so adjacent
// buttons' boxes are contiguous and the only blank column between two glyphs
// is the left button's own trailing space.
describe("toolbar action buttons pack with a one-column inter-glyph gutter (Task 7 follow-up)", () => {
  test("getToolbarButtonRanges: adjacent buttons are contiguous with a 2-column box each", () => {
    const toolbar = { buttons: buildToolbarButtons({ panelActive: false }), mainCols: 40, tabs: [] };
    const ranges = getToolbarButtonRanges(toolbar);
    expect(ranges.map((r) => r.id)).toEqual([
      "panel", "new-window", "split-v", "split-h", "claude", "settings",
    ]);
    expect(ranges).toEqual([
      { id: "panel", startCol: 28, endCol: 29 },
      { id: "new-window", startCol: 30, endCol: 31 },
      { id: "split-v", startCol: 32, endCol: 33 },
      { id: "split-h", startCol: 34, endCol: 35 },
      { id: "claude", startCol: 36, endCol: 37 },
      { id: "settings", startCol: 38, endCol: 39 },
    ]);
  });

  test("adjacent button boxes are contiguous (no gap) and exactly one blank column separates their glyphs", () => {
    const toolbar = { buttons: buildToolbarButtons({ panelActive: false }), mainCols: 40, tabs: [] };
    const ranges = getToolbarButtonRanges(toolbar);
    for (let i = 0; i < ranges.length - 1; i++) {
      const left = ranges[i];
      const right = ranges[i + 1];
      // Boxes are contiguous: the next button's box starts exactly where
      // this one's ends (no packing gap between the boxes themselves).
      expect(right.startCol).toBe(left.endCol + 1);
      // Each box is glyph (startCol) + one trailing space (endCol) — so the
      // blank column between glyph_i (left.startCol) and glyph_{i+1}
      // (right.startCol) is exactly the single trailing space at left.endCol.
      expect(right.startCol - left.startCol).toBe(2);
    }
  });

  test("the rightmost button still sits flush at mainCols", () => {
    const toolbar = { buttons: buildToolbarButtons({ panelActive: false }), mainCols: 40, tabs: [] };
    const ranges = getToolbarButtonRanges(toolbar);
    const last = ranges[ranges.length - 1];
    expect(last.endCol).toBe(39); // mainCols - 1
  });

  test("compositeGrids: the hover background covers exactly the hovered button's painted range, no more", () => {
    const sidebar = createGrid(6, 6);
    const main = createGrid(40, 4);
    const toolbar = {
      buttons: buildToolbarButtons({ panelActive: false }),
      mainCols: 40,
      tabs: [],
      hoveredButton: "claude",
    };
    const layout = makeLayout({ sidebarCols: 6, mainCols: 40, toolbarRows: 1, termRows: 4 });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const borderCol = layout.borderCol!;
    const ranges = getToolbarButtonRanges(toolbar);
    const claudeRange = ranges.find((r) => r.id === "claude")!;
    const neighborRange = ranges.find((r) => r.id === "split-h")!; // immediate left neighbor

    for (let col = 0; col <= 39; col++) {
      const cell = result.cells[0][borderCol + 1 + col];
      const inClaudeRange = col >= claudeRange.startCol && col <= claudeRange.endCol;
      if (inClaudeRange) {
        expect(cell.bgMode).toBe(ColorMode.RGB);
      } else if (col >= neighborRange.startCol && col <= neighborRange.endCol) {
        // The neighboring button's own box must not pick up the hover bg.
        expect(cell.bgMode).not.toBe(ColorMode.RGB);
      }
    }
  });
});

describe("toolbar status chip removed from the live toolbar (Task 7)", () => {
  test("getToolbarStatusChipRange returns null when the toolbar carries no statusChip", () => {
    const toolbar = { buttons: buildToolbarButtons({ panelActive: false }), mainCols: 40, tabs: [] };
    expect(getToolbarStatusChipRange(toolbar)).toBeNull();
  });

  test("compositeGrids paints no chip text on row 0 when statusChip is absent", () => {
    const sidebar = createGrid(6, 6);
    const main = createGrid(40, 4);
    const toolbar = { buttons: buildToolbarButtons({ panelActive: false }), mainCols: 40, tabs: [] };
    const layout = makeLayout({ sidebarCols: 6, mainCols: 40, toolbarRows: 1, termRows: 4 });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const row0 = result.cells[0].map((c) => c.char).join("");
    expect(row0).not.toContain("snapshot");
  });
});

describe("toolbar tab separator is blank space, not a │ glyph (Task 7)", () => {
  test("two non-last tabs have no │ painted in their inter-tab gap", () => {
    const sidebar = createGrid(6, 6);
    const main = createGrid(30, 4);
    const toolbar = {
      buttons: [], mainCols: 30,
      tabs: [
        { windowId: "@1", index: 0, name: "one", active: true, bell: false, zoomed: false },
        { windowId: "@2", index: 1, name: "two", active: false, bell: false, zoomed: false },
      ],
    };
    const layout = makeLayout({ sidebarCols: 6, mainCols: 30, toolbarRows: 1, termRows: 4 });
    const result = compositeGrids(layout, main, sidebar, toolbar);
    const ranges = getToolbarTabRanges(toolbar);
    const borderCol = layout.borderCol!;
    // The gap between tab one's end and tab two's start is blank space —
    // not the old " │ " separator glyph.
    const gapStart = borderCol + 1 + ranges[0].endCol + 1;
    const gapEnd = borderCol + 1 + ranges[1].startCol; // exclusive
    const gap = result.cells[0].slice(gapStart, gapEnd).map((c) => c.char).join("");
    expect(gap).not.toContain("│");
    expect(gap.trim()).toBe("");
    // The gap is exactly space.groupGutter (2) columns wide.
    expect(gapEnd - gapStart).toBe(2);
  });
});
