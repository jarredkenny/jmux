import type { Cell, CellGrid, CursorPosition, WindowTab } from "./types";
import { ColorMode } from "./types";
import { createGrid, DEFAULT_CELL, cellWidth } from "./cell-grid";
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
  /** Total toolbar height in rows (1 = tabs only; 2 = tabs + per-window branch row). Defaults to 1. */
  toolbarRows?: number;
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

// Display width of a character — delegates to the shared cellWidth table.
function charDisplayWidth(ch: string): number {
  return cellWidth(ch.codePointAt(0) ?? 0);
}

export { charDisplayWidth };

export function stringDisplayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charDisplayWidth(ch);
  return w;
}

// Returns the column ranges for each toolbar button (relative to main area start)
export function getToolbarButtonRanges(toolbar: ToolbarConfig): Array<{ id: string; startCol: number; endCol: number }> {
  const ranges: Array<{ id: string; startCol: number; endCol: number }> = [];
  let col = toolbar.mainCols;
  for (let i = toolbar.buttons.length - 1; i >= 0; i--) {
    const btn = toolbar.buttons[i];
    const width = stringDisplayWidth(btn.label) + 2; // label display width + padding
    col -= width;
    ranges.unshift({ id: btn.id, startCol: col, endCol: col + width - 1 });
  }
  return ranges;
}

// Returns the column range for the status chip (right-aligned, just before buttons).
// Returns null if there is no statusChip.
export function getToolbarStatusChipRange(toolbar: ToolbarConfig): { startCol: number; endCol: number } | null {
  if (!toolbar.statusChip) return null;
  const buttonRanges = getToolbarButtonRanges(toolbar);
  const buttonsStart = buttonRanges.length > 0 ? buttonRanges[0].startCol : toolbar.mainCols;
  // chip text is " <statusChip> " — 1 space padding each side
  const chipWidth = stringDisplayWidth(toolbar.statusChip) + 2;
  const startCol = buttonsStart - chipWidth;
  return { startCol, endCol: buttonsStart - 1 };
}

// Returns the column ranges for each window tab (left-aligned in toolbar)
export function getToolbarTabRanges(toolbar: ToolbarConfig): Array<{ id: string; startCol: number; endCol: number; tab: WindowTab }> {
  const tabs = toolbar.tabs ?? [];
  if (tabs.length === 0) return [];

  const buttonRanges = getToolbarButtonRanges(toolbar);
  const buttonsStart = buttonRanges.length > 0 ? buttonRanges[0].startCol : toolbar.mainCols;
  // Reserve space for the status chip when present; tabs must not overlap it
  const chipRange = getToolbarStatusChipRange(toolbar);
  const effectiveRightEdge = chipRange ? chipRange.startCol - 1 : buttonsStart;
  const maxCol = effectiveRightEdge - 2; // 2-col gap before buttons/chip

  const ranges: Array<{ id: string; startCol: number; endCol: number; tab: WindowTab }> = [];
  let col = 1; // 1-col left padding

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const zoomSuffix = tab.zoomed ? " ⤢" : "";
    const width = stringDisplayWidth(tab.name + zoomSuffix) + 2; // " name [Z] "
    const sepWidth = i < tabs.length - 1 ? 3 : 0; // " │ " separator after non-last tabs
    if (col + width > maxCol) break; // no room
    ranges.push({ id: tab.windowId, startCol: col, endCol: col + width - 1, tab });
    col += width + sepWidth;
  }
  return ranges;
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
function renderWindowBranchRow(
  grid: CellGrid,
  toolbar: ToolbarConfig,
  borderCol: number,
  totalCols: number,
): void {
  const branchIcon = "⎇ ";
  const iconWidth = stringDisplayWidth(branchIcon);
  for (const { startCol, endCol, tab } of getToolbarTabRanges(toolbar)) {
    const branch = tab.branch;
    if (!branch) continue;
    const tabWidth = endCol - startCol + 1;
    const maxLen = tabWidth - 2 - iconWidth; // leading + trailing space
    if (maxLen <= 0) continue;
    let branchText = branch;
    if (stringDisplayWidth(branchText) > maxLen) {
      branchText = branchText.slice(0, Math.max(1, maxLen - 1)) + "…";
    }
    const label = " " + branchIcon + branchText + " ";
    let col = 0;
    for (const ch of label) {
      const c = borderCol + 1 + startCol + col;
      const w = charDisplayWidth(ch);
      if (c < totalCols) {
        grid.cells[1][c] = {
          ...DEFAULT_CELL,
          char: ch,
          width: w,
          fg: 8,
          fgMode: ColorMode.Palette,
          dim: true,
        };
        if (w === 2 && c + 1 < totalCols) {
          grid.cells[1][c + 1] = { ...DEFAULT_CELL, char: "", width: 0 };
        }
      }
      col += w;
    }
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
  const borderCol = layout.borderCol!;
  const mainCols = toolbar ? toolbar.mainCols : main.cols;
  const totalCols = layout.termCols;
  const toolbarRows = toolbar ? layout.toolbarRows : 0;
  const totalRows = main.rows + toolbarRows;
  const grid = createGrid(totalCols, totalRows);

  for (let y = 0; y < totalRows; y++) {
    // Copy sidebar cells
    for (let x = 0; x < sidebar.cols && x < sidebar.cells[y]?.length; x++) {
      grid.cells[y][x] = { ...sidebar.cells[y][x] };
    }
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
        renderWindowBranchRow(grid, toolbar, borderCol, totalCols);
      } else if (y === 0) {
      // Toolbar row — always render (palette no longer replaces it)
      const hoverBg = theme.hover;
      const activeBg = theme.selected;

      // Render window tabs (left side)
      const peachFg = accentFor((0xfb << 16) | (0xd4 << 8) | 0xb8);
      const tabRanges = getToolbarTabRanges(toolbar);
      for (let ti = 0; ti < tabRanges.length; ti++) {
        const { id, startCol, endCol, tab } = tabRanges[ti];
        const isActive = tab.active;
        const isHovered = !isActive && toolbar.hoveredTabId === id;
        const label = ` ${tab.name}${tab.zoomed ? " ⤢" : ""} `;
        let col = 0;
        for (const ch of label) {
          const c = borderCol + 1 + startCol + col;
          const w = charDisplayWidth(ch);
          const hasBg = isActive || isHovered;
          const bg = isActive ? activeBg : hoverBg;
          if (c < totalCols) {
            grid.cells[0][c] = {
              ...DEFAULT_CELL,
              char: ch,
              width: w,
              fg: tab.bell ? 3 : isActive ? peachFg : 8,
              fgMode: tab.bell ? ColorMode.Palette : isActive ? ColorMode.RGB : ColorMode.Palette,
              bold: isActive || tab.bell,
              bg: hasBg ? bg : 0,
              bgMode: hasBg ? ColorMode.RGB : ColorMode.Default,
            };
            if (w === 2 && c + 1 < totalCols) {
              grid.cells[0][c + 1] = {
                ...DEFAULT_CELL, char: "", width: 0,
                bg: hasBg ? bg : 0,
                bgMode: hasBg ? ColorMode.RGB : ColorMode.Default,
              };
            }
          }
          col += w;
        }
        if (ti < tabRanges.length - 1) {
          const sepCol = borderCol + 1 + endCol + 2;
          if (sepCol < totalCols) {
            grid.cells[0][sepCol] = {
              ...DEFAULT_CELL,
              char: "\u2502",
              fg: 8,
              fgMode: ColorMode.Palette,
              dim: true,
            };
          }
        }
      }

      // Render action buttons (right side)
      const ranges = getToolbarButtonRanges(toolbar);
      for (const { id, startCol } of ranges) {
        const btn = toolbar.buttons.find(b => b.id === id)!;
        const isHovered = toolbar.hoveredButton === id;
        const label = ` ${btn.label} `;
        let col = 0;
        for (const ch of label) {
          const c = borderCol + 1 + startCol + col;
          const w = charDisplayWidth(ch);
          const isIcon = ch !== " ";
          if (c < totalCols) {
            grid.cells[0][c] = {
              ...DEFAULT_CELL,
              char: ch,
              width: w,
              fg: isIcon ? (btn.fg ?? 8) : 8,
              fgMode: isIcon ? (btn.fgMode ?? ColorMode.Palette) : ColorMode.Palette,
              bg: isHovered ? hoverBg : 0,
              bgMode: isHovered ? ColorMode.RGB : ColorMode.Default,
            };
            if (w === 2 && c + 1 < totalCols) {
              grid.cells[0][c + 1] = {
                ...DEFAULT_CELL, char: "", width: 0,
                bg: isHovered ? hoverBg : 0,
                bgMode: isHovered ? ColorMode.RGB : ColorMode.Default,
              };
            }
          }
          col += w;
        }
      }

      // Render status chip (dim text, right-aligned just before action buttons)
      const chipRange = getToolbarStatusChipRange(toolbar);
      if (chipRange && toolbar.statusChip) {
        const label = ` ${toolbar.statusChip} `;
        let col = 0;
        for (const ch of label) {
          const c = borderCol + 1 + chipRange.startCol + col;
          const w = charDisplayWidth(ch);
          if (c < totalCols) {
            grid.cells[0][c] = {
              ...DEFAULT_CELL,
              char: ch,
              width: w,
              fg: 8,
              fgMode: ColorMode.Palette,
              dim: true,
            };
            if (w === 2 && c + 1 < totalCols) {
              grid.cells[0][c + 1] = {
                ...DEFAULT_CELL, char: "", width: 0,
                fg: 8,
                fgMode: ColorMode.Palette,
                dim: true,
              };
            }
          }
          col += w;
        }
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
          for (let x = 0; x < mainCols; x++) {
            grid.cells[y][layout.main.x + x] = { ...main.cells[mainY][x] };
          }
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
            for (let x = 0; x < diffPanel.grid.cols; x++) {
              grid.cells[y][panelCol + x] = { ...diffPanel.grid.cells[mainY][x] };
            }
          }
        }
      }
    }
  }

  // Tab bar rendering — writes into the toolbar row of the panel area
  if (diffPanel?.tabBar && toolbarRows > 0) {
    const tabBarRow = 0; // toolbar is always row 0
    const panelStartCol = layout.panel!.x;
    for (let c = 0; c < diffPanel.tabBar.cols && panelStartCol + c < totalCols; c++) {
      grid.cells[tabBarRow][panelStartCol + c] = { ...diffPanel.tabBar.cells[0][c] };
    }
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
    const borderCell = (ch: string) => ({
      ...DEFAULT_CELL, char: ch, fg: borderFg.fg, fgMode: borderFg.fgMode as number,
      bg: paletteBg, bgMode: ColorMode.RGB as number,
    });

    // Top border
    if (bTop >= 0 && bTop < totalRows) {
      if (bLeft >= 0 && bLeft < totalCols) grid.cells[bTop][bLeft] = borderCell("┌");
      for (let x = bLeft + 1; x < bRight && x < totalCols; x++) {
        grid.cells[bTop][x] = borderCell("─");
      }
      if (bRight < totalCols) grid.cells[bTop][bRight] = borderCell("┐");
    }

    // Side borders + modal content
    for (let py = 0; py < modalOverlay.rows; py++) {
      const gy = pos.startRow + py;
      if (gy >= totalRows) break;
      if (bLeft >= 0 && bLeft < totalCols) grid.cells[gy][bLeft] = borderCell("│");
      for (let px = 0; px < modalOverlay.cols; px++) {
        const gx = pos.startCol + px;
        if (gx >= totalCols) break;
        grid.cells[gy][gx] = { ...modalOverlay.cells[py][px] };
      }
      if (bRight < totalCols) grid.cells[gy][bRight] = borderCell("│");
    }

    // Bottom border
    if (bBottom < totalRows) {
      if (bLeft >= 0 && bLeft < totalCols) grid.cells[bBottom][bLeft] = borderCell("└");
      for (let x = bLeft + 1; x < bRight && x < totalCols; x++) {
        grid.cells[bBottom][x] = borderCell("─");
      }
      if (bRight < totalCols) grid.cells[bBottom][bRight] = borderCell("┘");
    }

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
