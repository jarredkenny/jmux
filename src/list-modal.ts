import type { CellGrid } from "./types";
import { createGrid, writeString } from "./cell-grid";
import { fuzzyMatch, type FuzzyResult } from "./command-palette";
import {
  HEADER_ATTRS, SUBHEADER_ATTRS, PROMPT_ATTRS, INPUT_ATTRS,
  RESULT_ATTRS, SELECTED_RESULT_ATTRS,
  MATCH_ATTRS, SELECTED_MATCH_ATTRS,
  BG_ATTRS, SELECTED_BG_ATTRS,
  NO_MATCHES_ATTRS,
  type ModalAction,
} from "./modal";

const MAX_VISIBLE = 16;

export interface ListItem {
  id: string;
  label: string;
  annotation?: string;
}

export interface ListModalConfig {
  header: string;
  subheader?: string;
  items: ListItem[];
  defaultQuery?: string;
}

interface FilteredItem {
  item: ListItem;
  match: FuzzyResult;
}

function truncateLabel(label: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (label.length <= maxLen) return label;
  if (maxLen <= 1) return "…";
  return label.slice(0, maxLen - 1) + "…";
}

export class ListModal {
  private _open = false;
  private query = "";
  private selectedIndex = 0;
  private scrollOffset = 0;
  private config: ListModalConfig;
  private filtered: FilteredItem[] = [];

  constructor(config: ListModalConfig) {
    this.config = config;
  }

  open(): void {
    this._open = true;
    this.query = this.config.defaultQuery ?? "";
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.refilter();
  }

  close(): void {
    this._open = false;
    this.query = "";
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.filtered = [];
  }

  isOpen(): boolean {
    return this._open;
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(40, Math.round(termCols * 0.55)), 80);
  }

  getCursorPosition(): { row: number; col: number } | null {
    const queryRow = this.config.subheader !== undefined ? 2 : 1;
    return { row: queryRow, col: 4 + this.query.length };
  }

  updateItems(items: ListItem[]): void {
    this.config = { ...this.config, items };
    if (this._open) {
      this.refilter();
      if (this.selectedIndex >= this.filtered.length) {
        this.selectedIndex = Math.max(0, this.filtered.length - 1);
      }
      this.adjustScroll();
    }
  }

  handleInput(data: string): ModalAction {
    // Escape
    if (data === "\x1b") {
      this.close();
      return { type: "closed" };
    }

    // Enter
    if (data === "\r") {
      if (this.filtered.length === 0) return { type: "consumed" };
      const selected = this.filtered[this.selectedIndex];
      return { type: "result", value: selected.item };
    }

    // Arrow down
    if (data === "\x1b[B") {
      if (this.filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
        this.adjustScroll();
      }
      return { type: "consumed" };
    }

    // Arrow up
    if (data === "\x1b[A") {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
        this.adjustScroll();
      }
      return { type: "consumed" };
    }

    // Backspace
    if (data === "\x7f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selectedIndex = 0;
        this.refilter();
      }
      return { type: "consumed" };
    }

    // Tab: no-op
    if (data === "\t") {
      return { type: "consumed" };
    }

    // Printable characters
    if (data.length === 1 && data >= " " && data <= "~") {
      this.query += data;
      this.selectedIndex = 0;
      this.refilter();
      return { type: "consumed" };
    }

    return { type: "consumed" };
  }

  getGrid(width: number): CellGrid {
    const hasSubheader = this.config.subheader !== undefined;
    const queryRow = hasSubheader ? 2 : 1;
    const visibleCount = Math.min(this.filtered.length || 1, MAX_VISIBLE);
    const height = queryRow + 1 + visibleCount;
    const grid = createGrid(width, height);

    // Fill background
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    // Row 0: header
    writeString(grid, 0, 2, this.config.header, HEADER_ATTRS);

    // Row 1 (optional): subheader
    if (hasSubheader) {
      writeString(grid, 1, 2, this.config.subheader!, SUBHEADER_ATTRS);
    }

    // Query row: "  ▷ query"
    writeString(grid, queryRow, 2, "▷", PROMPT_ATTRS);
    if (this.query.length > 0) {
      writeString(grid, queryRow, 4, this.query, INPUT_ATTRS);
    }

    // Results
    const firstResultRow = queryRow + 1;
    if (this.filtered.length === 0) {
      writeString(grid, firstResultRow, 3, "No matches", NO_MATCHES_ATTRS);
    } else {
      for (let vi = 0; vi < visibleCount; vi++) {
        const i = this.scrollOffset + vi;
        const row = firstResultRow + vi;
        const entry = this.filtered[i];
        if (!entry) break;
        const isSelected = i === this.selectedIndex;
        const baseAttrs = isSelected ? SELECTED_RESULT_ATTRS : RESULT_ATTRS;

        // Paint selected row background
        if (isSelected) {
          writeString(grid, row, 0, " ".repeat(width), SELECTED_BG_ATTRS);
        }

        // Selection indicator
        if (isSelected) {
          writeString(grid, row, 1, "▸", baseAttrs);
        }

        // Label with match highlighting
        const labelStart = 3;
        const maxLabelLen = width - labelStart;
        const label = truncateLabel(entry.item.label, maxLabelLen);
        const matchIndices = new Set(entry.match.indices);

        for (let ci = 0; ci < label.length; ci++) {
          const col = labelStart + ci;
          if (col >= width) break;
          const isMatch = matchIndices.has(ci);
          const charAttrs = isMatch
            ? (isSelected ? SELECTED_MATCH_ATTRS : MATCH_ATTRS)
            : baseAttrs;
          writeString(grid, row, col, label[ci], charAttrs);
        }
      }
    }

    return grid;
  }

  private refilter(): void {
    const source = this.config.items;

    if (this.query === "") {
      this.filtered = source.map((item) => ({
        item,
        match: { score: 0, indices: [] },
      }));
    } else {
      const scored: FilteredItem[] = [];
      for (const item of source) {
        const match = fuzzyMatch(this.query, item.label);
        if (match) {
          scored.push({ item, match });
        }
      }
      scored.sort((a, b) => b.match.score - a.match.score);
      this.filtered = scored;
    }

    if (this.filtered.length === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = this.filtered.length - 1;
    }
    this.scrollOffset = 0;
    this.adjustScroll();
  }

  private adjustScroll(): void {
    const maxVisible = Math.min(this.filtered.length, MAX_VISIBLE);
    if (maxVisible === 0) {
      this.scrollOffset = 0;
      return;
    }
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.selectedIndex - maxVisible + 1;
    }
  }
}
