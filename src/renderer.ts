import type { Cell, CellGrid, CursorPosition, WindowTab } from "./types";
import { ColorMode } from "./types";
import { createGrid, DEFAULT_CELL, blit, textCols, writeStyledLine, drawBox, truncateToCols, type CellAttrs, type StyledSegment } from "./cell-grid";
import { packChips, type PlacedChip } from "./band-layout";
import { theme, neutralFg, accentFor } from "./theme";
import type { FrameLayout } from "./frame-layout";

export const BORDER_CHAR = "\u2502"; // │

export interface ToolbarButton {
  label: string;
  id: string;
  fg?: number;      // optional RGB color
  fgMode?: number;  // ColorMode
}

export interface ToolbarConfig {
  buttons: ToolbarButton[];
  mainCols: number;
  hoveredButton?: string | null;
  tabs?: WindowTab[];
  hoveredTabId?: string | null;
  /** When set, a dim status chip is rendered between tabs and buttons. */
  statusChip?: string | null;
}

export function sgrForCell(cell: Cell): string {
  const parts: string[] = ["0"]; // always reset first

  if (cell.bold) parts.push("1");
  if (cell.dim) parts.push("2");
  if (cell.italic) parts.push("3");
  if (cell.underline) parts.push("4");

  // Foreground
  if (cell.fgMode === ColorMode.Palette) {
    if (cell.fg < 8) {
      parts.push(`${30 + cell.fg}`);
    } else if (cell.fg < 16) {
      parts.push(`${90 + cell.fg - 8}`);
    } else {
      parts.push(`38;5;${cell.fg}`);
    }
  } else if (cell.fgMode === ColorMode.RGB) {
    const r = (cell.fg >> 16) & 0xff;
    const g = (cell.fg >> 8) & 0xff;
    const b = cell.fg & 0xff;
    parts.push(`38;2;${r};${g};${b}`);
  }

  // Background
  if (cell.bgMode === ColorMode.Palette) {
    if (cell.bg < 8) {
      parts.push(`${40 + cell.bg}`);
    } else if (cell.bg < 16) {
      parts.push(`${100 + cell.bg - 8}`);
    } else {
      parts.push(`48;5;${cell.bg}`);
    }
  } else if (cell.bgMode === ColorMode.RGB) {
    const r = (cell.bg >> 16) & 0xff;
    const g = (cell.bg >> 8) & 0xff;
    const b = cell.bg & 0xff;
    parts.push(`48;2;${r};${g};${b}`);
  }

  return `\x1b[${parts.join(";")}m`;
}

// A placed toolbar tab carries the WindowTab alongside its geometry — the
// paint loop and the branch row both need the underlying tab, not just its id.
interface PlacedToolbarTab extends PlacedChip {
  tab: WindowTab;
}

interface ToolbarLayout {
  tabs: PlacedToolbarTab[];
  statusChip: PlacedChip | null;
  buttons: PlacedChip[];
}

// Places the toolbar's three zones once — tabs packed left, action buttons
// packed right, and an optional status chip between them, right-aligned just
// before the buttons — so paint (compositeGrids) and hit-test
// (getToolbarTabRanges/getToolbarButtonRanges/getToolbarStatusChipRange) both
// read from this single placement rather than recomputing it independently.
// Buttons are placed first (they anchor the right edge), then the status
// chip (anchored to the buttons' left edge), then tabs (bounded by whichever
// of those sits leftmost) — mirroring the dependency order the original
// three standalone functions had.
function layoutToolbar(toolbar: ToolbarConfig): ToolbarLayout {
  const buttonItems = toolbar.buttons.map((b) => ({ id: b.id, width: textCols(b.label) + 2 }));
  // No overflow guard on buttons — matches the original, which never checked
  // a budget for them either. `-Infinity` means "never overflow".
  const buttons = packChips(buttonItems, { start: toolbar.mainCols, budget: -Infinity, align: "right" });

  const buttonsStart = buttons.length > 0 ? buttons[0].x : toolbar.mainCols;

  let statusChip: PlacedChip | null = null;
  if (toolbar.statusChip) {
    // chip text is " <statusChip> " — 1 space padding each side
    const chipWidth = textCols(toolbar.statusChip) + 2;
    statusChip = packChips([{ id: "status", width: chipWidth }], {
      start: buttonsStart, budget: -Infinity, align: "right",
    })[0] ?? null;
  }

  // Reserve space for the status chip when present; tabs must not overlap it.
  const effectiveRightEdge = statusChip ? statusChip.x - 1 : buttonsStart;
  const maxCol = effectiveRightEdge - 2; // 2-col gap before buttons/chip

  const tabs = toolbar.tabs ?? [];
  const tabItems = tabs.map((tab) => ({
    id: tab.windowId,
    width: textCols(tab.name + (tab.zoomed ? " ⤢" : "")) + 2, // " name [Z] "
  }));
  const placedTabs = tabs.length === 0
    ? []
    : packChips(tabItems, { start: 1, budget: maxCol, align: "left", sepWidth: 3 }); // " │ " separator after non-last tabs

  const placedToolbarTabs: PlacedToolbarTab[] = placedTabs.map((c) => ({
    ...c,
    tab: tabs.find((t) => t.windowId === c.id)!,
  }));

  return { tabs: placedToolbarTabs, statusChip, buttons };
}

// Returns the column ranges for each toolbar button (relative to main area start)
export function getToolbarButtonRanges(toolbar: ToolbarConfig): Array<{ id: string; startCol: number; endCol: number }> {
  return layoutToolbar(toolbar).buttons.map((c) => ({ id: c.id, startCol: c.x, endCol: c.x + c.width - 1 }));
}

// Returns the column range for the status chip (right-aligned, just before buttons).
// Returns null if there is no statusChip.
export function getToolbarStatusChipRange(toolbar: ToolbarConfig): { startCol: number; endCol: number } | null {
  const chip = layoutToolbar(toolbar).statusChip;
  return chip ? { startCol: chip.x, endCol: chip.x + chip.width - 1 } : null;
}

// Returns the column ranges for each window tab (left-aligned in toolbar)
export function getToolbarTabRanges(toolbar: ToolbarConfig): Array<{ id: string; startCol: number; endCol: number; tab: WindowTab }> {
  return layoutToolbar(toolbar).tabs.map((c) => ({
    id: c.id, startCol: c.x, endCol: c.x + c.width - 1, tab: c.tab,
  }));
}

// Returns the absolute grid position for modal content.
// Centered over the entire terminal (not just the main area).
// Accounts for border (1 cell each side) and shadow (1 cell right/bottom).
export function getModalPosition(
  totalGridCols: number, totalGridRows: number,
  modalWidth: number, modalHeight: number,
): { startCol: number; startRow: number } {
  const totalW = modalWidth + 3; // border left + content + border right + shadow
  const totalH = modalHeight + 3; // border top + content + border bottom + shadow
  return {
    startCol: Math.max(2, Math.floor((totalGridCols - totalW) / 2) + 1),
    startRow: Math.max(2, Math.floor((totalGridRows - totalH) / 3) + 1),
  };
}

// Renders the optional second toolbar row: each window's git branch, aligned
// under its tab (dim, with a ⎇ glyph, truncated to the tab width). Windows whose
// pane isn't in a git repo simply leave their slot blank.
//
// Row 1 (this row) has no separator glyphs — those only exist on row 0 — so a
// non-last tab's branch label is allowed to extend across the inter-tab gap,
// all the way up to the next tab's x. This is a display-only widening: it
// does not change the tab bar's own column bookkeeping (`tabs` is the exact
// placement row 0 and hit-testing use), so the tab bar itself and
// hit-testing are unaffected. The last tab has no gap to borrow — the button
// cluster starts beyond it — so it stays bounded by its own tab width,
// exactly like every tab was before this widening.
function renderWindowBranchRow(
  grid: CellGrid,
  tabs: PlacedToolbarTab[],
  borderCol: number,
): void {
  const branchIcon = "⎇ ";
  const iconWidth = textCols(branchIcon);
  const attrs: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
  for (let i = 0; i < tabs.length; i++) {
    const { x, width, tab } = tabs[i];
    const branch = tab.branch;
    if (!branch) continue;
    const isLast = i === tabs.length - 1;
    const rowWidth = isLast ? width : tabs[i + 1].x - x;
    const maxLen = rowWidth - 2 - iconWidth; // leading + trailing space
    if (maxLen <= 0) continue;
    const branchText = truncateToCols(branch, maxLen);
    const label = " " + branchIcon + branchText + " ";
    writeStyledLine(grid, 1, borderCol + 1 + x, [{ text: label, attrs }], rowWidth);
  }
}

export function compositeGrids(
  layout: FrameLayout,
  main: CellGrid,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  modalOverlay?: CellGrid | null,
  diffPanel?: {
    grid: CellGrid;
    mode: "split" | "full";
    focused: boolean;
    tabBar?: CellGrid;
  },
): CellGrid {
  if (!sidebar) return main;

  // Invariant maintained by callers (see src/frame-layout.ts): a sidebar
  // grid is only ever passed when `layout.sidebar`/`layout.borderCol` are
  // also non-null — main.ts sizes both from the same relayout() call.
  // Likewise `layout.panel` is non-null whenever `diffPanel.isActive()` is
  // true, and `layout.divider` is non-null whenever `diffPanel.mode` is
  // "split" — full mode has no divider. Both hold because main.ts's relayout()
  // runs synchronously after every diffPanel state mutation. The reads below
  // are guarded to match: the divider read sits inside the `mode === "split"`
  // branch, and moving it out would break this invariant.
  const borderCol = layout.borderCol!;
  const mainCols = toolbar ? toolbar.mainCols : main.cols;
  const totalCols = layout.termCols;
  const toolbarRows = toolbar ? layout.toolbarRows : 0;
  const totalRows = main.rows + toolbarRows;
  const grid = createGrid(totalCols, totalRows);

  // Placed once per frame; row 0 (tabs/buttons/status chip) and row 1 (the
  // per-window branch row) both paint from this single placement, and it's
  // the same placement getToolbarTabRanges/getToolbarButtonRanges/
  // getToolbarStatusChipRange read for hit-testing.
  const toolbarLayout = toolbar ? layoutToolbar(toolbar) : null;

  for (let y = 0; y < totalRows; y++) {
    // Copy sidebar cells
    blit(grid, sidebar, { destX: 0, destY: y, srcX: 0, srcY: y, w: sidebar.cols, h: 1 });
    // Border column
    grid.cells[y][borderCol] = {
      ...DEFAULT_CELL,
      char: BORDER_CHAR,
      fg: 8,
      fgMode: ColorMode.Palette,
    };

    if (toolbar && y < toolbarRows) {
      if (y === 1 && toolbarRows >= 2) {
        // Second toolbar row: per-window git branch, aligned under each tab.
        renderWindowBranchRow(grid, toolbarLayout!.tabs, borderCol);
      } else if (y === 0) {
      // Toolbar row — always render (palette no longer replaces it)
      const hoverBg = theme.hover;
      const activeBg = theme.selected;

      // Render window tabs (left side)
      const peachFg = accentFor((0xfb << 16) | (0xd4 << 8) | 0xb8);
      const tabs = toolbarLayout!.tabs;
      for (let ti = 0; ti < tabs.length; ti++) {
        const { x, width, tab } = tabs[ti];
        const isActive = tab.active;
        const isHovered = !isActive && toolbar.hoveredTabId === tab.windowId;
        const hasBg = isActive || isHovered;
        const bg = isActive ? activeBg : hoverBg;
        const label = ` ${tab.name}${tab.zoomed ? " ⤢" : ""} `;
        const attrs: CellAttrs = {
          fg: tab.bell ? 3 : isActive ? peachFg : 8,
          fgMode: tab.bell ? ColorMode.Palette : isActive ? ColorMode.RGB : ColorMode.Palette,
          bold: isActive || tab.bell,
          bg: hasBg ? bg : 0,
          bgMode: hasBg ? ColorMode.RGB : ColorMode.Default,
        };
        writeStyledLine(grid, 0, borderCol + 1 + x, [{ text: label, attrs }], width);

        if (ti < tabs.length - 1) {
          const sepCol = borderCol + 1 + x + width + 1;
          if (sepCol < totalCols) {
            grid.cells[0][sepCol] = {
              ...DEFAULT_CELL,
              char: "│",
              fg: 8,
              fgMode: ColorMode.Palette,
              dim: true,
            };
          }
        }
      }

      // Render action buttons (right side). The icon glyph and its
      // surrounding padding spaces get different foregrounds, so they're
      // built as separate segments rather than one uniformly-styled string.
      for (const { id, x, width } of toolbarLayout!.buttons) {
        const btn = toolbar.buttons.find(b => b.id === id)!;
        const isHovered = toolbar.hoveredButton === id;
        const bg = isHovered ? hoverBg : 0;
        const bgMode = isHovered ? ColorMode.RGB : ColorMode.Default;
        const spaceAttrs: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, bg, bgMode };
        const iconAttrs: CellAttrs = { fg: btn.fg ?? 8, fgMode: btn.fgMode ?? ColorMode.Palette, bg, bgMode };
        const segments: StyledSegment[] = [
          { text: " ", attrs: spaceAttrs },
          { text: btn.label, attrs: iconAttrs },
          { text: " ", attrs: spaceAttrs },
        ];
        writeStyledLine(grid, 0, borderCol + 1 + x, segments, width);
      }

      // Render status chip (dim text, right-aligned just before action buttons)
      const chip = toolbarLayout!.statusChip;
      if (chip && toolbar.statusChip) {
        const label = ` ${toolbar.statusChip} `;
        const attrs: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
        writeStyledLine(grid, 0, borderCol + 1 + chip.x, [{ text: label, attrs }], chip.width);
      }
      }
    } else {
      // Main content — offset by toolbar rows
      const mainY = toolbar ? y - toolbarRows : y;
      if (mainY >= 0) {
        // Copy main grid at layout.main.x. In full mode the diff panel
        // below is painted at layout.panel.x, which equals layout.main.x —
        // it overlaps and overwrites these same columns rather than main
        // being replaced by a separate code path.
        if (mainY < main.rows) {
          blit(grid, main, { destX: layout.main.x, destY: y, srcX: 0, srcY: mainY, w: mainCols, h: 1 });
        }

        if (diffPanel) {
          if (diffPanel.mode === "split") {
            const dividerCol = layout.divider!;
            const focusColor = accentFor((0x58 << 16) | (0xa6 << 8) | 0xff);
            grid.cells[y][dividerCol] = {
              ...DEFAULT_CELL,
              char: "│",
              fg: diffPanel.focused ? focusColor : 8,
              fgMode: diffPanel.focused ? ColorMode.RGB : ColorMode.Palette,
            };
          }
          const panelCol = layout.panel!.x;
          if (mainY < diffPanel.grid.rows) {
            blit(grid, diffPanel.grid, { destX: panelCol, destY: y, srcX: 0, srcY: mainY, w: diffPanel.grid.cols, h: 1 });
          }
        }
      }
    }
  }

  // Tab bar rendering — writes into the toolbar row of the panel area
  if (diffPanel?.tabBar && toolbarRows > 0) {
    const tabBarRow = 0; // toolbar is always row 0
    const panelStartCol = layout.panel!.x;
    blit(grid, diffPanel.tabBar, { destX: panelStartCol, destY: tabBarRow, srcX: 0, srcY: 0, w: diffPanel.tabBar.cols, h: 1 });
  }

  // Overlay modal centered over entire terminal with border, shadow, and dimmed background
  if (modalOverlay) {
    const pos = getModalPosition(totalCols, totalRows, modalOverlay.cols, modalOverlay.rows);

    // Dim all content cells behind the palette (main area + toolbar, not sidebar)
    const mainStart = layout.main.x;
    for (let y = 0; y < totalRows; y++) {
      for (let x = mainStart; x < totalCols; x++) {
        grid.cells[y][x].dim = true;
      }
    }

    // Border positions (absolute grid coordinates). Colors track the detected
    // terminal theme: surface for the border fill, a derived darkening for the
    // shadow, and the terminal's default foreground for the border glyph once a
    // background is known (so the outline stays visible on light themes too).
    const paletteBg = theme.surface;
    const shadowBg = theme.shadow;
    const borderFg = neutralFg(8);
    const bTop = pos.startRow - 1;
    const bLeft = pos.startCol - 1;
    const bRight = pos.startCol + modalOverlay.cols;
    const bBottom = pos.startRow + modalOverlay.rows;

    // Modal content
    blit(grid, modalOverlay, { destX: pos.startCol, destY: pos.startRow, srcX: 0, srcY: 0, w: modalOverlay.cols, h: modalOverlay.rows });

    // Border ring (corners + edges) around the content.
    drawBox(grid, { x: bLeft, y: bTop, w: bRight - bLeft + 1, h: bBottom - bTop + 1 }, {
      border: { fg: borderFg.fg, fgMode: borderFg.fgMode, bg: paletteBg, bgMode: ColorMode.RGB },
    });

    // Shadow: right edge
    const shadowX = bRight + 1;
    if (shadowX < totalCols) {
      for (let y = bTop + 1; y <= bBottom + 1 && y < totalRows; y++) {
        const cell = grid.cells[y][shadowX];
        cell.bg = shadowBg;
        cell.bgMode = ColorMode.RGB;
        cell.dim = true;
      }
    }
    // Shadow: bottom edge
    const shadowY = bBottom + 1;
    if (shadowY < totalRows) {
      for (let x = bLeft + 1; x <= bRight + 1 && x < totalCols; x++) {
        const cell = grid.cells[shadowY][x];
        cell.bg = shadowBg;
        cell.bgMode = ColorMode.RGB;
        cell.dim = true;
      }
    }
  }

  return grid;
}

// Compare only visual attributes (used for SGR dedup within a row)
function cellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.fgMode === b.fgMode &&
    a.bgMode === b.bgMode &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

// Compare all cell fields including character content (used for frame diffing)
function fullCellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.char === b.char &&
    a.width === b.width &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.fgMode === b.fgMode &&
    a.bgMode === b.bgMode &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.link === b.link
  );
}

const MOUSE_MODE_INTERVAL_MS = 2_000;

export class Renderer {
  private prevAttrs: Cell | null = null;
  private prevGrid: CellGrid | null = null;
  private lastMouseModeTime = 0;

  /**
   * URL of the hyperlink at the given absolute (0-indexed) cell of the last
   * composited frame, or undefined. Backs jmux-owned link clicking — the input
   * router maps a click's coordinates straight onto what was rendered there.
   */
  getLinkAt(col: number, row: number): string | undefined {
    return this.prevGrid?.cells[row]?.[col]?.link;
  }

  render(
    layout: FrameLayout,
    main: CellGrid,
    cursor: CursorPosition,
    sidebar: CellGrid | null,
    toolbar?: ToolbarConfig | null,
    modalOverlay?: CellGrid | null,
    modalCursor?: { row: number; col: number } | null,
    diffPanel?: {
      grid: CellGrid;
      mode: "split" | "full";
      focused: boolean;
      tabBar?: CellGrid;
    },
  ): void {
    const grid = compositeGrids(layout, main, sidebar, toolbar, modalOverlay, diffPanel);
    const cursorOffset = layout.main.x;
    const buf: string[] = [];

    // Row-level diffing: skip rows whose cells are identical to the
    // previous frame.  This dramatically reduces stdout output when
    // the screen is static, which prevents terminal emulators' URL
    // detection from being disrupted by constant full-screen rewrites.
    const canDiff =
      this.prevGrid !== null &&
      this.prevGrid.rows === grid.rows &&
      this.prevGrid.cols === grid.cols;

    for (let y = 0; y < grid.rows; y++) {
      if (canDiff) {
        let rowChanged = false;
        const prevRow = this.prevGrid!.cells[y];
        const curRow = grid.cells[y];
        for (let x = 0; x < grid.cols; x++) {
          if (!fullCellsEqual(curRow[x], prevRow[x])) {
            rowChanged = true;
            break;
          }
        }
        if (!rowChanged) continue;
      }

      // Move to start of row (1-indexed)
      buf.push(`\x1b[${y + 1};1H`);
      this.prevAttrs = null;
      let col = 1; // expected terminal column (1-indexed)
      // OSC 8 link state — reset per row so the close emitted at the
      // end of each row keeps state cleanly bounded.
      let prevLink: string | undefined = undefined;

      for (let x = 0; x < grid.cols; x++) {
        const cell = grid.cells[y][x];

        // Skip continuation cells (second half of wide characters)
        if (cell.width === 0) continue;

        // Emit OSC 8 transitions before SGR/text so the link "wraps"
        // the styled glyphs the way Bun emits them.
        if (cell.link !== prevLink) {
          if (prevLink !== undefined) buf.push("\x1b]8;;\x1b\\");
          if (cell.link !== undefined) buf.push(`\x1b]8;;${cell.link}\x1b\\`);
          prevLink = cell.link;
        }

        // Emit SGR only when attributes change
        if (!this.prevAttrs || !cellsEqual(this.prevAttrs, cell)) {
          buf.push(sgrForCell(cell));
          this.prevAttrs = cell;
        }

        buf.push(cell.char);
        col += cell.width;

        // Reposition cursor after wide characters to prevent drift
        // from width disagreements between xterm.js and the real
        // terminal.  Only characters with display width >= 2 (CJK,
        // emoji) can cause drift — width-1 non-ASCII (box-drawing,
        // bullets, arrows, Latin Extended) are unambiguous and don't
        // need correction.  Repositioning after every non-ASCII char
        // (cp >= 0x80) injected hundreds of CUP sequences per frame,
        // which broke URL detection in terminal emulators that track
        // text segments separated by cursor movement.
        if (col <= grid.cols && cell.width >= 2) {
          buf.push(`\x1b[${y + 1};${col}H`);
        }
      }

      // Close any open OSC 8 region at the end of the row so it
      // doesn't leak into the next row's text or the trailing reset.
      if (prevLink !== undefined) {
        buf.push("\x1b]8;;\x1b\\");
      }
    }

    this.prevGrid = grid;

    // Reset attributes, position cursor
    const cursorRowOffset = toolbar ? 1 : 0;
    buf.push("\x1b[0m");
    if (modalCursor != null) {
      // Modal cursor is in absolute grid coordinates
      buf.push(`\x1b[${modalCursor.row + 1};${modalCursor.col + 1}H`);
      buf.push("\x1b[?25h");
    } else if (diffPanel?.focused) {
      buf.push("\x1b[?25l"); // hide cursor when diff panel focused
    } else {
      buf.push(
        `\x1b[${cursor.y + cursorRowOffset + 1};${cursor.x + cursorOffset + 1}H`,
      );
      buf.push("\x1b[?25h");
    }

    // Re-assert mouse tracking modes periodically to keep jmux's own mouse
    // reception alive against mode drift — link clicking now depends on jmux
    // receiving the click (see InputRouter's getLinkAt path), so these modes
    // must stay on. Throttled to 2s rather than per-frame: per-frame re-assert
    // sent ?1003h 60x/sec, churn that could disrupt terminals' URL detection.
    // (We no longer depend on the terminal's own click bypass, so reasserting
    // here is purely upside.)
    const now = Date.now();
    if (now - this.lastMouseModeTime >= MOUSE_MODE_INTERVAL_MS) {
      buf.push("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
      this.lastMouseModeTime = now;
    }

    process.stdout.write(buf.join(""));
  }
}
