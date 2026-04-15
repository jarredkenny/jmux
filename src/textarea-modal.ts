import type { CellGrid } from "./types";
import { createGrid, writeString } from "./cell-grid";
import {
  HEADER_ATTRS, SUBHEADER_ATTRS, INPUT_ATTRS, BG_ATTRS, DIM_ATTRS,
  type ModalAction,
} from "./modal";

export interface TextAreaModalConfig {
  header: string;
  subheader?: string;
  value?: string;
}

export class TextAreaModal {
  private _open = false;
  private lines: string[] = [""];
  private cursorRow = 0;
  private cursorCol = 0;
  private config: TextAreaModalConfig;
  private scrollOffset = 0;

  constructor(config: TextAreaModalConfig) {
    this.config = config;
  }

  open(): void {
    this._open = true;
    if (this.config.value) {
      this.lines = this.config.value.split("\n");
      this.cursorRow = this.lines.length - 1;
      this.cursorCol = this.lines[this.cursorRow].length;
    } else {
      this.lines = [""];
      this.cursorRow = 0;
      this.cursorCol = 0;
    }
    this.scrollOffset = 0;
  }

  close(): void { this._open = false; }
  isOpen(): boolean { return this._open; }

  getValue(): string {
    return this.lines.join("\n");
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(40, Math.round(termCols * 0.55)), 80);
  }

  getCursorPosition(): { row: number; col: number } | null {
    const headerRows = this.config.subheader !== undefined ? 2 : 1;
    return {
      row: headerRows + (this.cursorRow - this.scrollOffset),
      col: 2 + this.cursorCol,
    };
  }

  handleInput(data: string): ModalAction {
    // Escape
    if (data === "\x1b") return { type: "closed" };

    // Ctrl-S: submit
    if (data === "\x13") {
      const value = this.getValue();
      if (value.length === 0) return { type: "consumed" };
      return { type: "result", value };
    }

    // Enter: new line
    if (data === "\r") {
      const line = this.lines[this.cursorRow];
      const before = line.slice(0, this.cursorCol);
      const after = line.slice(this.cursorCol);
      this.lines[this.cursorRow] = before;
      this.lines.splice(this.cursorRow + 1, 0, after);
      this.cursorRow++;
      this.cursorCol = 0;
      return { type: "consumed" };
    }

    // Ctrl-A: start of line
    if (data === "\x01") {
      this.cursorCol = 0;
      return { type: "consumed" };
    }

    // Ctrl-E: end of line
    if (data === "\x05") {
      this.cursorCol = this.lines[this.cursorRow].length;
      return { type: "consumed" };
    }

    // Ctrl-K: kill to end of line
    if (data === "\x0b") {
      this.lines[this.cursorRow] = this.lines[this.cursorRow].slice(0, this.cursorCol);
      return { type: "consumed" };
    }

    // Alt+Backspace / Ctrl-U: clear entire line
    if (data === "\x1b\x7f" || data === "\x1b\b" || data === "\x15") {
      this.lines[this.cursorRow] = "";
      this.cursorCol = 0;
      return { type: "consumed" };
    }

    // Backspace
    if (data === "\x7f" || data === "\b") {
      if (this.cursorCol > 0) {
        const line = this.lines[this.cursorRow];
        this.lines[this.cursorRow] = line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
        this.cursorCol--;
      } else if (this.cursorRow > 0) {
        // Join with previous line
        const prevLen = this.lines[this.cursorRow - 1].length;
        this.lines[this.cursorRow - 1] += this.lines[this.cursorRow];
        this.lines.splice(this.cursorRow, 1);
        this.cursorRow--;
        this.cursorCol = prevLen;
      }
      return { type: "consumed" };
    }

    // Delete key
    if (data === "\x1b[3~") {
      const line = this.lines[this.cursorRow];
      if (this.cursorCol < line.length) {
        this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1);
      } else if (this.cursorRow < this.lines.length - 1) {
        this.lines[this.cursorRow] += this.lines[this.cursorRow + 1];
        this.lines.splice(this.cursorRow + 1, 1);
      }
      return { type: "consumed" };
    }

    // Arrow left
    if (data === "\x1b[D") {
      if (this.cursorCol > 0) {
        this.cursorCol--;
      } else if (this.cursorRow > 0) {
        this.cursorRow--;
        this.cursorCol = this.lines[this.cursorRow].length;
      }
      return { type: "consumed" };
    }

    // Arrow right
    if (data === "\x1b[C") {
      if (this.cursorCol < this.lines[this.cursorRow].length) {
        this.cursorCol++;
      } else if (this.cursorRow < this.lines.length - 1) {
        this.cursorRow++;
        this.cursorCol = 0;
      }
      return { type: "consumed" };
    }

    // Arrow up
    if (data === "\x1b[A") {
      if (this.cursorRow > 0) {
        this.cursorRow--;
        this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorRow].length);
      }
      return { type: "consumed" };
    }

    // Arrow down
    if (data === "\x1b[B") {
      if (this.cursorRow < this.lines.length - 1) {
        this.cursorRow++;
        this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorRow].length);
      }
      return { type: "consumed" };
    }

    // Home
    if (data === "\x1b[H") {
      this.cursorCol = 0;
      return { type: "consumed" };
    }

    // End
    if (data === "\x1b[F") {
      this.cursorCol = this.lines[this.cursorRow].length;
      return { type: "consumed" };
    }

    // Tab: no-op
    if (data === "\t") {
      return { type: "consumed" };
    }

    // Printable characters (single keystroke or pasted text)
    if (data.length >= 1 && data[0] >= " " && data[0] <= "~") {
      for (const ch of data) {
        if (ch === "\n" || ch === "\r") {
          const line = this.lines[this.cursorRow];
          this.lines[this.cursorRow] = line.slice(0, this.cursorCol);
          this.lines.splice(this.cursorRow + 1, 0, line.slice(this.cursorCol));
          this.cursorRow++;
          this.cursorCol = 0;
        } else if (ch >= " " && ch <= "~") {
          const line = this.lines[this.cursorRow];
          this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + ch + line.slice(this.cursorCol);
          this.cursorCol++;
        }
      }
      return { type: "consumed" };
    }

    return { type: "consumed" };
  }

  getGrid(width: number, maxHeight?: number): CellGrid {
    const hasSubheader = this.config.subheader !== undefined;
    const headerRows = hasSubheader ? 2 : 1;
    const statusRows = 1;
    const availableLines = (maxHeight ?? 12) - headerRows - statusRows;
    const visibleLines = Math.max(1, Math.min(this.lines.length, availableLines));

    // Adjust scroll to keep cursor visible
    if (this.cursorRow < this.scrollOffset) {
      this.scrollOffset = this.cursorRow;
    } else if (this.cursorRow >= this.scrollOffset + availableLines) {
      this.scrollOffset = this.cursorRow - availableLines + 1;
    }

    const height = headerRows + visibleLines + statusRows;
    const grid = createGrid(width, height);

    // Fill background
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    // Header
    writeString(grid, 0, 2, this.config.header, HEADER_ATTRS);

    // Subheader
    if (hasSubheader) {
      writeString(grid, 1, 2, this.config.subheader!, SUBHEADER_ATTRS);
    }

    // Content lines
    for (let i = 0; i < visibleLines; i++) {
      const lineIdx = this.scrollOffset + i;
      if (lineIdx >= this.lines.length) break;
      const row = headerRows + i;
      const text = this.lines[lineIdx].slice(0, width - 4);
      if (text.length > 0) {
        writeString(grid, row, 2, text, INPUT_ATTRS);
      }
    }

    // Status bar
    const statusRow = height - 1;
    const status = "Ctrl+S submit \u00b7 Esc cancel";
    writeString(grid, statusRow, 2, status, DIM_ATTRS);

    return grid;
  }
}
