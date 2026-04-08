import { Terminal } from "@xterm/headless";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { Cell, CellGrid, CursorPosition } from "./types";
import { ColorMode } from "./types";
import { createGrid, DEFAULT_CELL } from "./cell-grid";

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
