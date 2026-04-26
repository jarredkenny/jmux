import type { CellGrid } from "./types";
import type { CellAttrs, StyledLine, StyledSegment } from "./cell-grid";
import { createGrid, writeString } from "./cell-grid";
import { HEADER_ATTRS, DIM_ATTRS, BG_ATTRS, type ModalAction } from "./modal";

// Re-exported for backwards compatibility with consumers that import from
// content-modal — the canonical home is now cell-grid.
export type { StyledLine, StyledSegment };

export interface ContentModalConfig {
  lines: StyledLine[];
  title?: string;
}

function wrapStyledLine(line: StyledLine, maxWidth: number): StyledLine[] {
  if (line.length === 0) return [line];
  const totalLen = line.reduce((sum, seg) => sum + seg.text.length, 0);
  if (totalLen <= maxWidth) return [line];

  const fullText = line.map(s => s.text).join("");
  let breakAt = maxWidth;
  for (let i = maxWidth; i > 0; i--) {
    if (fullText[i] === " ") { breakAt = i; break; }
  }

  // Split segments at the break point
  const before: StyledSegment[] = [];
  const after: StyledSegment[] = [];
  let offset = 0;
  for (const seg of line) {
    if (offset >= breakAt) {
      after.push(seg);
    } else if (offset + seg.text.length <= breakAt) {
      before.push(seg);
    } else {
      const splitAt = breakAt - offset;
      before.push({ text: seg.text.slice(0, splitAt), attrs: seg.attrs });
      after.push({ text: seg.text.slice(splitAt), attrs: seg.attrs });
    }
    offset += seg.text.length;
  }

  // Trim leading space from wrapped portion
  if (after.length > 0 && after[0].text.startsWith(" ")) {
    after[0] = { ...after[0], text: after[0].text.slice(1) };
    if (after[0].text.length === 0) after.shift();
  }

  const result: StyledLine[] = [before];
  if (after.length > 0) {
    result.push(...wrapStyledLine(after, maxWidth));
  }
  return result;
}

export class ContentModal {
  private _open = false;
  private config: ContentModalConfig;
  private scrollOffset = 0;
  private termRows = 30;
  private wrappedLines: StyledLine[] | null = null;
  private lastWrappedWidth = 0;

  constructor(config: ContentModalConfig) {
    this.config = config;
  }

  open(): void {
    this._open = true;
    this.scrollOffset = 0;
    this.wrappedLines = null;
    this.lastWrappedWidth = 0;
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
    // termRows minus: headerRows, status bar, border (2), shadow (1), margin (3)
    return Math.max(1, this.termRows - this.headerRows - 7);
  }

  private get displayLines(): StyledLine[] {
    return this.wrappedLines ?? this.config.lines;
  }

  private ensureWrapped(width: number): void {
    if (this.wrappedLines && this.lastWrappedWidth === width) return;
    this.lastWrappedWidth = width;
    const availWidth = width - 4; // 2 col padding each side
    const result: StyledLine[] = [];
    for (const line of this.config.lines) {
      result.push(...wrapStyledLine(line, availWidth));
    }
    this.wrappedLines = result;
    // Clamp scroll after re-wrap
    const max = Math.max(0, result.length - this.contentAreaRows);
    if (this.scrollOffset > max) this.scrollOffset = max;
  }

  private get maxScroll(): number {
    return Math.max(0, this.displayLines.length - this.contentAreaRows);
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
    this.ensureWrapped(width);
    const lines = this.displayLines;
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
      if (lineIndex >= lines.length) break;
      const row = headerRows + vi;
      const line = lines[lineIndex];
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
    const pct = lines.length === 0
      ? 100
      : Math.round(((this.scrollOffset + contentAreaRows) / lines.length) * 100);
    const clampedPct = Math.min(100, pct);
    const statusText = `  \u2191\u2193/jk scroll  q close    ${clampedPct}%`;
    writeString(grid, statusRow, 0, statusText, DIM_ATTRS);

    return grid;
  }
}
