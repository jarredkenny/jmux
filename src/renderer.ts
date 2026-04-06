import type { Cell, CellGrid, CursorPosition, WindowTab } from "./types";
import { ColorMode } from "./types";
import { createGrid, DEFAULT_CELL } from "./cell-grid";

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

// Display width of a character — wide Unicode symbols take 2 terminal columns
function charDisplayWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x2000) return 1;
  // Ranges that render as 2-wide in most terminal fonts
  if (
    (cp >= 0x2300 && cp <= 0x23FF) ||  // Miscellaneous Technical
    (cp >= 0x25A0 && cp <= 0x25FF) ||  // Geometric Shapes
    (cp >= 0x2600 && cp <= 0x27BF) ||  // Misc Symbols + Dingbats
    (cp >= 0x2900 && cp <= 0x29FF) ||  // Misc Mathematical Symbols-B
    (cp >= 0x2B00 && cp <= 0x2BFF) ||  // Misc Symbols and Arrows
    (cp >= 0xFF01 && cp <= 0xFF60) ||  // Fullwidth Forms
    (cp >= 0x1F000)                     // Supplementary symbols/emoji
  ) {
    return 2;
  }
  return 1;
}

function stringDisplayWidth(s: string): number {
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
    const width = stringDisplayWidth(tab.name) + 2; // " name "
    const sepWidth = i < tabs.length - 1 ? 3 : 0; // " │ " separator after non-last tabs
    if (col + width > maxCol) break; // no room
    ranges.push({ id: tab.windowId, startCol: col, endCol: col + width - 1, tab });
    col += width + sepWidth;
  }
  return ranges;
}

export function compositeGrids(
  main: CellGrid,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
): CellGrid {
  if (!sidebar) return main;

  const totalCols = sidebar.cols + 1 + (toolbar ? toolbar.mainCols : main.cols);
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
      // Toolbar row — tabs left-aligned, buttons right-aligned
      const hoverBg = (0x2a << 16) | (0x2f << 8) | 0x38;
      const activeBg = (0x1e << 16) | (0x2a << 8) | 0x35;

      // Render window tabs (left side)
      // Peach accent for active tab — matches pane border and old status bar design
      const peachFg = (0xfb << 16) | (0xd4 << 8) | 0xb8;
      const tabRanges = getToolbarTabRanges(toolbar);
      for (let ti = 0; ti < tabRanges.length; ti++) {
        const { id, startCol, endCol, tab } = tabRanges[ti];
        const isActive = tab.active;
        const isHovered = !isActive && toolbar.hoveredTabId === id;
        const label = ` ${tab.name} `;
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
        // Separator after non-last tabs
        if (ti < tabRanges.length - 1) {
          const sepCol = borderCol + 1 + endCol + 2; // 1 space + separator
          if (sepCol < totalCols) {
            grid.cells[0][sepCol] = {
              ...DEFAULT_CELL,
              char: "\u2502", // │
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
    } else {
      // Main content — offset by toolbar row
      const mainY = toolbar ? y - 1 : y;
      if (mainY >= 0 && mainY < main.rows) {
        for (let x = 0; x < main.cols; x++) {
          grid.cells[y][borderCol + 1 + x] = { ...main.cells[mainY][x] };
        }
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
  ): void {
    const grid = compositeGrids(main, sidebar, toolbar);
    const cursorOffset = sidebar ? sidebar.cols + 1 : 0;
    const buf: string[] = [];

    for (let y = 0; y < grid.rows; y++) {
      // Move to start of row (1-indexed)
      buf.push(`\x1b[${y + 1};1H`);
      this.prevAttrs = null;

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
      }
    }

    // Reset attributes, position cursor
    const cursorRowOffset = toolbar ? 1 : 0;
    buf.push("\x1b[0m");
    buf.push(
      `\x1b[${cursor.y + cursorRowOffset + 1};${cursor.x + cursorOffset + 1}H`,
    );

    process.stdout.write(buf.join(""));
  }
}
