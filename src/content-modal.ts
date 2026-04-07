import type { CellGrid } from "./types";
import type { CellAttrs } from "./cell-grid";
import { createGrid, writeString } from "./cell-grid";
import { HEADER_ATTRS, DIM_ATTRS, BG_ATTRS, type ModalAction } from "./modal";

export interface StyledSegment {
  text: string;
  attrs?: CellAttrs;
}
export type StyledLine = StyledSegment[];

export interface ContentModalConfig {
  lines: StyledLine[];
  title?: string;
}

export class ContentModal {
  private _open = false;
  private config: ContentModalConfig;
  private scrollOffset = 0;
  private termRows = 30;

  constructor(config: ContentModalConfig) {
    this.config = config;
  }

  open(): void {
    this._open = true;
    this.scrollOffset = 0;
  }

  close(): void {
    this._open = false;
    this.scrollOffset = 0;
  }

  isOpen(): boolean {
    return this._open;
  }

  setTermRows(rows: number): void {
    this.termRows = rows;
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(50, Math.round(termCols * 0.7)), 90);
  }

  getCursorPosition(): { row: number; col: number } | null {
    return null;
  }

  private get headerRows(): number {
    return this.config.title !== undefined ? 2 : 0;
  }

  private get contentAreaRows(): number {
    // termRows - headerRows - 1 (status bar)
    return Math.max(1, this.termRows - this.headerRows - 1);
  }

  private get maxScroll(): number {
    return Math.max(0, this.config.lines.length - this.contentAreaRows);
  }

  handleInput(data: string): ModalAction {
    if (data === "q" || data === "\x1b") {
      this.close();
      return { type: "closed" };
    }

    if (data === "j" || data === "\x1b[B") {
      this.scrollOffset = Math.min(this.scrollOffset + 1, this.maxScroll);
      return { type: "consumed" };
    }

    if (data === "k" || data === "\x1b[A") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      return { type: "consumed" };
    }

    if (data === "g") {
      this.scrollOffset = 0;
      return { type: "consumed" };
    }

    if (data === "G") {
      this.scrollOffset = this.maxScroll;
      return { type: "consumed" };
    }

    if (data === "d" || data === " ") {
      const half = Math.max(1, Math.floor(this.contentAreaRows / 2));
      this.scrollOffset = Math.min(this.scrollOffset + half, this.maxScroll);
      return { type: "consumed" };
    }

    if (data === "u") {
      const half = Math.max(1, Math.floor(this.contentAreaRows / 2));
      this.scrollOffset = Math.max(0, this.scrollOffset - half);
      return { type: "consumed" };
    }

    return { type: "consumed" };
  }

  getGrid(width: number): CellGrid {
    const headerRows = this.headerRows;
    const contentAreaRows = this.contentAreaRows;
    const height = headerRows + contentAreaRows + 1; // +1 for status bar
    const grid = createGrid(width, height);

    // Fill background
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    // Header rows (title + separator)
    if (this.config.title !== undefined) {
      writeString(grid, 0, 2, this.config.title, HEADER_ATTRS);
      writeString(grid, 1, 0, "-".repeat(width), DIM_ATTRS);
    }

    // Content rows
    for (let vi = 0; vi < contentAreaRows; vi++) {
      const lineIndex = this.scrollOffset + vi;
      if (lineIndex >= this.config.lines.length) break;
      const row = headerRows + vi;
      const line = this.config.lines[lineIndex];
      let col = 2;
      for (const segment of line) {
        if (col >= width) break;
        const text = segment.text;
        const available = width - col;
        const slice = text.length > available ? text.slice(0, available) : text;
        writeString(grid, row, col, slice, segment.attrs);
        col += slice.length;
      }
    }

    // Status bar (last row)
    const statusRow = height - 1;
    const pct = this.config.lines.length === 0
      ? 100
      : Math.round(((this.scrollOffset + contentAreaRows) / this.config.lines.length) * 100);
    const clampedPct = Math.min(100, pct);
    const statusText = `  \u2191\u2193/jk scroll  q close    ${clampedPct}%`;
    writeString(grid, statusRow, 0, statusText, DIM_ATTRS);

    return grid;
  }
}
