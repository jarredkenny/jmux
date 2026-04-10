import type { Cell, CellGrid, CursorPosition, WindowTab } from "./types";
import { ColorMode } from "./types";
import { createGrid, DEFAULT_CELL, cellWidth } from "./cell-grid";

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
  panelTabs?: { label: string; active: boolean }[];
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

// Returns the column ranges for each window tab (left-aligned in toolbar)
export function getToolbarTabRanges(toolbar: ToolbarConfig): Array<{ id: string; startCol: number; endCol: number; tab: WindowTab }> {
  const tabs = toolbar.tabs ?? [];
  if (tabs.length === 0) return [];

  const buttonRanges = getToolbarButtonRanges(toolbar);
  const buttonsStart = buttonRanges.length > 0 ? buttonRanges[0].startCol : toolbar.mainCols;
  const maxCol = buttonsStart - 2; // 2-col gap before buttons

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

export function compositeGrids(
  main: CellGrid,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  modalOverlay?: CellGrid | null,
  diffPanel?: {
    grid: CellGrid;
    mode: "split" | "full";
    focused: boolean;
  },
): CellGrid {
  if (!sidebar) return main;

  const mainCols = toolbar ? toolbar.mainCols : main.cols;
  let contentCols: number;
  if (diffPanel) {
    if (diffPanel.mode === "split") {
      contentCols = mainCols + 1 + diffPanel.grid.cols; // main + divider + diff
    } else {
      contentCols = diffPanel.grid.cols; // full: diff replaces main
    }
  } else {
    contentCols = mainCols;
  }
  const totalCols = sidebar.cols + 1 + contentCols;
  const toolbarRows = toolbar ? 1 : 0;
  const totalRows = main.rows + toolbarRows;
  const grid = createGrid(totalCols, totalRows);

  for (let y = 0; y < totalRows; y++) {
    // Copy sidebar cells
    for (let x = 0; x < sidebar.cols && x < sidebar.cells[y]?.length; x++) {
      grid.cells[y][x] = { ...sidebar.cells[y][x] };
    }
    // Border column
    const borderCol = sidebar.cols;
    grid.cells[y][borderCol] = {
      ...DEFAULT_CELL,
      char: BORDER_CHAR,
      fg: 8,
      fgMode: ColorMode.Palette,
    };

    if (toolbar && y === 0) {
      // Toolbar row — always render (palette no longer replaces it)
      const hoverBg = (0x2a << 16) | (0x2f << 8) | 0x38;
      const activeBg = (0x1e << 16) | (0x2a << 8) | 0x35;

      // Render window tabs (left side)
      const peachFg = (0xfb << 16) | (0xd4 << 8) | 0xb8;
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

      // Render panel tabs in the diff panel column area of the toolbar row
      if (diffPanel && diffPanel.mode === "split" && toolbar.panelTabs?.length) {
        const dividerCol = borderCol + 1 + mainCols;
        const panelStart = dividerCol + 1;
        let col = 1; // 1-col left padding
        for (let ti = 0; ti < toolbar.panelTabs.length; ti++) {
          const pt = toolbar.panelTabs[ti];
          const label = ` ${pt.label} `;
          let charCol = 0;
          for (const ch of label) {
            const c = panelStart + col + charCol;
            const w = charDisplayWidth(ch);
            if (c < totalCols) {
              grid.cells[0][c] = {
                ...DEFAULT_CELL,
                char: ch,
                width: w,
                fg: pt.active ? peachFg : 8,
                fgMode: pt.active ? ColorMode.RGB : ColorMode.Palette,
                bold: pt.active,
                bg: pt.active ? activeBg : 0,
                bgMode: pt.active ? ColorMode.RGB : ColorMode.Default,
              };
              if (w === 2 && c + 1 < totalCols) {
                grid.cells[0][c + 1] = {
                  ...DEFAULT_CELL, char: "", width: 0,
                  bg: pt.active ? activeBg : 0,
                  bgMode: pt.active ? ColorMode.RGB : ColorMode.Default,
                };
              }
            }
            charCol += w;
          }
          col += charCol;
          if (ti < toolbar.panelTabs.length - 1) {
            const sepCol = panelStart + col + 1;
            if (sepCol < totalCols) {
              grid.cells[0][sepCol] = {
                ...DEFAULT_CELL,
                char: "\u2502",
                fg: 8,
                fgMode: ColorMode.Palette,
                dim: true,
              };
            }
            col += 3; // " │ "
          }
        }
      }
    } else {
      // Main content — offset by toolbar row
      const mainY = toolbar ? y - 1 : y;
      if (mainY >= 0) {
        if (diffPanel && diffPanel.mode === "full") {
          // Full mode: copy diff grid instead of main
          if (mainY < diffPanel.grid.rows) {
            for (let x = 0; x < diffPanel.grid.cols; x++) {
              grid.cells[y][borderCol + 1 + x] = { ...diffPanel.grid.cells[mainY][x] };
            }
          }
        } else {
          // Normal or split mode: copy main grid
          if (mainY < main.rows) {
            for (let x = 0; x < mainCols; x++) {
              grid.cells[y][borderCol + 1 + x] = { ...main.cells[mainY][x] };
            }
          }
          // Split mode: add divider + diff panel
          if (diffPanel && diffPanel.mode === "split") {
            const dividerCol = borderCol + 1 + mainCols;
            const focusColor = (0x58 << 16) | (0xa6 << 8) | 0xff;
            grid.cells[y][dividerCol] = {
              ...DEFAULT_CELL,
              char: "│",
              fg: diffPanel.focused ? focusColor : 8,
              fgMode: diffPanel.focused ? ColorMode.RGB : ColorMode.Palette,
            };
            if (mainY < diffPanel.grid.rows) {
              for (let x = 0; x < diffPanel.grid.cols; x++) {
                grid.cells[y][dividerCol + 1 + x] = { ...diffPanel.grid.cells[mainY][x] };
              }
            }
          }
        }
      }
    }
  }

  // Overlay modal centered over entire terminal with border, shadow, and dimmed background
  if (modalOverlay) {
    const pos = getModalPosition(totalCols, totalRows, modalOverlay.cols, modalOverlay.rows);

    // Dim all content cells behind the palette (main area + toolbar, not sidebar)
    const mainStart = sidebar.cols + 1;
    for (let y = 0; y < totalRows; y++) {
      for (let x = mainStart; x < totalCols; x++) {
        grid.cells[y][x].dim = true;
      }
    }

    // Border positions (absolute grid coordinates)
    const paletteBg = (0x16 << 16) | (0x1b << 8) | 0x22; // #161b22
    const shadowBg = (0x06 << 16) | (0x08 << 8) | 0x0c; // very dark
    const bTop = pos.startRow - 1;
    const bLeft = pos.startCol - 1;
    const bRight = pos.startCol + modalOverlay.cols;
    const bBottom = pos.startRow + modalOverlay.rows;
    const borderCell = (ch: string) => ({
      ...DEFAULT_CELL, char: ch, fg: 8, fgMode: ColorMode.Palette as number,
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

export class Renderer {
  private prevAttrs: Cell | null = null;

  render(
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
    },
  ): void {
    const grid = compositeGrids(main, sidebar, toolbar, modalOverlay, diffPanel);
    const cursorOffset = sidebar ? sidebar.cols + 1 : 0;
    const buf: string[] = [];

    for (let y = 0; y < grid.rows; y++) {
      // Move to start of row (1-indexed)
      buf.push(`\x1b[${y + 1};1H`);
      this.prevAttrs = null;
      let col = 1; // expected terminal column (1-indexed)

      for (let x = 0; x < grid.cols; x++) {
        const cell = grid.cells[y][x];

        // Skip continuation cells (second half of wide characters)
        if (cell.width === 0) continue;

        // Emit SGR only when attributes change
        if (!this.prevAttrs || !cellsEqual(this.prevAttrs, cell)) {
          buf.push(sgrForCell(cell));
          this.prevAttrs = cell;
        }

        buf.push(cell.char);
        col += cell.width;

        // Reposition cursor after non-ASCII characters to prevent
        // drift from width disagreements between xterm.js and the
        // real terminal.  ASCII (< 0x80) is always width 1 everywhere;
        // non-ASCII chars (symbols, emoji, box-drawing) may differ
        // between xterm.js and the terminal.  Repositioning forces
        // alignment to xterm.js's model — this may cause a minor
        // artifact at a specific ambiguous-width character (its
        // second half overwritten) but prevents the accumulated
        // drift that corrupts tmux pane borders and line layout.
        const cp = cell.char.codePointAt(0) ?? 0;
        if (col <= grid.cols && cp >= 0x80) {
          buf.push(`\x1b[${y + 1};${col}H`);
        }
      }
    }

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

    process.stdout.write(buf.join(""));
  }
}
