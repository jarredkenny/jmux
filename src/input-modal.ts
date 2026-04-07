import type { CellGrid } from "./types";
import { createGrid, writeString } from "./cell-grid";
import {
  HEADER_ATTRS, SUBHEADER_ATTRS, PROMPT_ATTRS, INPUT_ATTRS, BG_ATTRS,
  type ModalAction,
} from "./modal";

export interface InputModalConfig {
  header: string;
  subheader?: string;
  value?: string;
  placeholder?: string;
}

export class InputModal {
  private _open = false;
  private value: string;
  private config: InputModalConfig;

  constructor(config: InputModalConfig) {
    this.config = config;
    this.value = config.value ?? "";
  }

  open(): void {
    this._open = true;
    this.value = this.config.value ?? "";
  }

  close(): void { this._open = false; }
  isOpen(): boolean { return this._open; }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(40, Math.round(termCols * 0.45)), 60);
  }

  getCursorPosition(): { row: number; col: number } | null {
    const inputRow = this.config.subheader !== undefined ? 2 : 1;
    return { row: inputRow, col: 4 + this.value.length };
  }

  handleInput(data: string): ModalAction {
    if (data === "\x1b") return { type: "closed" };
    if (data === "\r") {
      if (this.value.length === 0) return { type: "consumed" };
      return { type: "result", value: this.value };
    }
    if (data === "\x7f" || data === "\b") {
      if (this.value.length > 0) this.value = this.value.slice(0, -1);
      return { type: "consumed" };
    }
    if (data.length === 1 && data >= " " && data <= "~") {
      this.value += data;
      return { type: "consumed" };
    }
    return { type: "consumed" };
  }

  getGrid(width: number): CellGrid {
    const hasSubheader = this.config.subheader !== undefined;
    const height = hasSubheader ? 3 : 2;
    const grid = createGrid(width, height);

    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    writeString(grid, 0, 2, this.config.header, HEADER_ATTRS);

    if (hasSubheader) {
      writeString(grid, 1, 2, this.config.subheader!, SUBHEADER_ATTRS);
    }

    const inputRow = hasSubheader ? 2 : 1;
    writeString(grid, inputRow, 2, "\u25b7", PROMPT_ATTRS);
    if (this.value.length > 0) {
      writeString(grid, inputRow, 4, this.value, INPUT_ATTRS);
    } else if (this.config.placeholder) {
      writeString(grid, inputRow, 4, this.config.placeholder, SUBHEADER_ATTRS);
    }

    return grid;
  }
}
