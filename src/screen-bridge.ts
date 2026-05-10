import { Terminal, type IBuffer } from "@xterm/headless";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { Cell, CellGrid, CursorPosition } from "./types";
import { ColorMode } from "./types";
import { createGrid, DEFAULT_CELL } from "./cell-grid";

// Ghostty (and most terminals) detect URLs by regex over a single visible
// line. When jmux re-emits a wrapped tmux line as separately-positioned
// rows, the wrap signal is lost and the URL becomes undetectable. We
// rebuild logical lines via xterm.js's isWrapped flag and emit OSC 8 link
// markup so URLs survive wraps regardless of what the source program did.
const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s<>"'`{}|\\^[\]]+/g;
const URL_TRAILING_PUNCT = /[.,;:!?)\]]+$/;

export class ScreenBridge {
  private terminal: Terminal;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 0,
      allowProposedApi: true,
    });
    const unicodeAddon = new UnicodeGraphemesAddon();
    this.terminal.loadAddon(unicodeAddon);
    this.terminal.unicode.activeVersion = "15";
  }

  write(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write(data, resolve);
    });
  }

  getGrid(): CellGrid {
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    const grid = createGrid(cols, rows);
    const buffer = this.terminal.buffer.active;

    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      for (let x = 0; x < cols; x++) {
        const xtermCell = line.getCell(x);
        if (!xtermCell) continue;

        const cell = grid.cells[y][x];
        const chars = xtermCell.getChars();
        const w = xtermCell.getWidth();
        cell.char = w === 0 ? "" : (chars || " ");
        cell.width = w;
        cell.fg = xtermCell.getFgColor();
        cell.bg = xtermCell.getBgColor();
        cell.fgMode = xtermCell.isFgRGB()
          ? ColorMode.RGB
          : xtermCell.isFgPalette()
            ? ColorMode.Palette
            : ColorMode.Default;
        cell.bgMode = xtermCell.isBgRGB()
          ? ColorMode.RGB
          : xtermCell.isBgPalette()
            ? ColorMode.Palette
            : ColorMode.Default;
        cell.bold = xtermCell.isBold() !== 0;
        cell.italic = xtermCell.isItalic() !== 0;
        cell.underline = xtermCell.isUnderline() !== 0;
        cell.dim = xtermCell.isDim() !== 0;
      }
    }

    detectUrlsInGrid(buffer, cols, rows, grid);

    return grid;
  }

  getCursor(): CursorPosition {
    const buffer = this.terminal.buffer.active;
    return { x: buffer.cursorX, y: buffer.cursorY };
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }
}

function detectUrlsInGrid(
  buffer: IBuffer,
  cols: number,
  rows: number,
  grid: CellGrid,
): void {
  let y = 0;
  while (y < rows) {
    const startY = y;
    let text = "";
    const cellMap: Array<{ y: number; x: number }> = [];

    while (y < rows) {
      const line = buffer.getLine(y);
      if (!line) { y++; continue; }
      if (y !== startY && !line.isWrapped) break;

      for (let x = 0; x < cols; x++) {
        const xtermCell = line.getCell(x);
        if (!xtermCell) continue;
        const w = xtermCell.getWidth();
        if (w === 0) continue;
        const chars = xtermCell.getChars() || " ";
        for (const ch of chars) {
          text += ch;
          cellMap.push({ y, x });
        }
      }
      y++;
    }

    if (text.length === 0) continue;

    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text)) !== null) {
      const trimmed = m[0].replace(URL_TRAILING_PUNCT, "");
      if (trimmed.length === 0) continue;
      const start = m.index;
      const end = start + trimmed.length;
      for (let i = start; i < end && i < cellMap.length; i++) {
        const { y: cy, x: cx } = cellMap[i];
        grid.cells[cy][cx].link = trimmed;
      }
    }
  }
}
