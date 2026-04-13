import type { PaletteCommand, PaletteAction } from "./types";
import type { CellGrid } from "./types";
import { createGrid, writeString } from "./cell-grid";
import { fuzzyMatch, truncateLabel, type FuzzyResult } from "./fuzzy";
import {
  PROMPT_ATTRS, INPUT_ATTRS, RESULT_ATTRS, SELECTED_RESULT_ATTRS,
  MATCH_ATTRS, SELECTED_MATCH_ATTRS, CATEGORY_ATTRS, SELECTED_CATEGORY_ATTRS,
  CURRENT_TAG_ATTRS, SELECTED_CURRENT_TAG_ATTRS,
  BREADCRUMB_ATTRS, NO_MATCHES_ATTRS, BG_ATTRS, SELECTED_BG_ATTRS,
} from "./modal";

export { fuzzyMatch, type FuzzyResult } from "./fuzzy";

const MAX_VISIBLE_RESULTS = 16;

export interface FilteredItem {
  command: PaletteCommand;
  match: FuzzyResult;
}

const CONSUMED: PaletteAction = { type: "consumed" };
const CLOSED: PaletteAction = { type: "closed" };

export class CommandPalette {
  private _open = false;
  private query = "";
  private selectedIndex = 0;
  private scrollOffset = 0;
  private commands: PaletteCommand[] = [];
  private filtered: FilteredItem[] = [];
  private ctrlABuffered = false;

  // Sub-list state
  private sublistParent: PaletteCommand | null = null;
  private savedQuery = "";
  private savedIndex = 0;

  open(commands: PaletteCommand[]): void {
    this._open = true;
    this.commands = commands;
    this.query = "";
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.ctrlABuffered = false;
    this.sublistParent = null;
    this.savedQuery = "";
    this.savedIndex = 0;
    this.refilter();
  }

  close(): void {
    this._open = false;
    this.query = "";
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.commands = [];
    this.filtered = [];
    this.ctrlABuffered = false;
    this.sublistParent = null;
  }

  isOpen(): boolean {
    return this._open;
  }

  isInSublist(): boolean {
    return this.sublistParent !== null;
  }

  getQuery(): string {
    return this.query;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  getFilteredResults(): FilteredItem[] {
    return this.filtered;
  }

  getSublistParent(): PaletteCommand | null {
    return this.sublistParent;
  }

  getCursorCol(): number {
    if (this.sublistParent) {
      return this.sublistParent.label.length + 3 + this.query.length; // " › " = 3 chars
    }
    return 2 + this.query.length; // "▷ " prefix = 2 chars
  }

  getCursorPosition(): { row: number; col: number } | null {
    return { row: 0, col: this.getCursorCol() };
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(40, Math.round(termCols * 0.55)), 80);
  }

  handleInput(data: string): PaletteAction {
    // Handle Ctrl-a buffering
    if (this.ctrlABuffered) {
      this.ctrlABuffered = false;
      if (data === "p") {
        this.close();
        return CLOSED;
      }
      // Discard both bytes
      return CONSUMED;
    }

    // Ctrl-a: buffer it
    if (data === "\x01") {
      this.ctrlABuffered = true;
      return CONSUMED;
    }

    // Escape
    if (data === "\x1b") {
      if (this.sublistParent) {
        // Pop back to main list
        this.query = this.savedQuery;
        this.selectedIndex = this.savedIndex;
        this.sublistParent = null;
        this.refilter();
        return CONSUMED;
      }
      this.close();
      return CLOSED;
    }

    // Enter
    if (data === "\r") {
      if (this.filtered.length === 0) return CONSUMED;

      const selected = this.filtered[this.selectedIndex];

      if (this.sublistParent) {
        // In sublist: execute with sublistOptionId
        return {
          type: "result",
          value: {
            commandId: this.sublistParent.id,
            sublistOptionId: selected.command.id,
          },
        };
      }

      if (selected.command.sublist && selected.command.sublist.length > 0) {
        // Drill into sublist
        this.sublistParent = selected.command;
        this.savedQuery = this.query;
        this.savedIndex = this.selectedIndex;
        this.query = "";
        this.selectedIndex = 0;
        this.refilter();
        return CONSUMED;
      }

      // Regular command
      return {
        type: "result",
        value: { commandId: selected.command.id },
      };
    }

    // Arrow down
    if (data === "\x1b[B") {
      if (this.filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
        this.adjustScroll();
      }
      return CONSUMED;
    }

    // Arrow up
    if (data === "\x1b[A") {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
        this.adjustScroll();
      }
      return CONSUMED;
    }

    // Alt+Backspace / Cmd+Backspace / Ctrl-U: clear entire input
    if (data === "\x1b\x7f" || data === "\x1b\b" || data === "\x15") {
      if (this.query.length > 0) {
        this.query = "";
        this.selectedIndex = 0;
        this.refilter();
      }
      return CONSUMED;
    }

    // Backspace
    if (data === "\x7f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selectedIndex = 0;
        this.refilter();
      }
      return CONSUMED;
    }

    // Tab: no-op
    if (data === "\t") {
      return CONSUMED;
    }

    // Printable characters (space through tilde)
    if (data.length === 1 && data >= " " && data <= "~") {
      this.query += data;
      this.selectedIndex = 0;
      this.refilter();
      return CONSUMED;
    }

    // Everything else: consume silently
    return CONSUMED;
  }

  getHeight(): number {
    return 1 + Math.min(this.filtered.length || 1, MAX_VISIBLE_RESULTS);
  }

  getGrid(width: number): CellGrid {
    const height = this.getHeight();
    const grid = createGrid(width, height);

    // Fill background
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    // Row 0: input line
    if (this.sublistParent) {
      const breadcrumb = this.sublistParent.label + " › ";
      writeString(grid, 0, 0, breadcrumb, BREADCRUMB_ATTRS);
      writeString(grid, 0, breadcrumb.length, this.query, INPUT_ATTRS);
    } else {
      writeString(grid, 0, 0, "▷", PROMPT_ATTRS);
      writeString(grid, 0, 2, this.query, INPUT_ATTRS);
    }

    // Rows 1..N: results (scrolled)
    const visibleCount = Math.min(this.filtered.length, MAX_VISIBLE_RESULTS);
    if (this.filtered.length === 0) {
      writeString(grid, 1, 3, "No matches", NO_MATCHES_ATTRS);
    } else {
      for (let vi = 0; vi < visibleCount; vi++) {
        const i = this.scrollOffset + vi;
        const row = vi + 1;
        const item = this.filtered[i];
        if (!item) break;
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

        // Category tag (right-aligned with 1 col padding)
        const category = item.command.category;
        let tagWidth = 0;
        if (category) {
          tagWidth = category.length + 2; // 1 col gap before tag + 1 col padding after
          const tagCol = width - category.length - 1;
          const tagAttrs = category === "current"
            ? (isSelected ? SELECTED_CURRENT_TAG_ATTRS : CURRENT_TAG_ATTRS)
            : (isSelected ? SELECTED_CATEGORY_ATTRS : CATEGORY_ATTRS);
          writeString(grid, row, tagCol, category, tagAttrs);
        }

        // Label with match highlighting
        const labelStart = 3;
        const maxLabelLen = width - labelStart - tagWidth;
        const label = truncateLabel(item.command.label, maxLabelLen);
        const matchIndices = new Set(item.match.indices);

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
    const source: PaletteCommand[] = this.sublistParent?.sublist
      ? this.sublistParent.sublist.map((opt) => ({
          id: opt.id,
          label: opt.label,
          category: opt.current ? "current" : "",
        }))
      : this.commands;

    if (this.query === "") {
      this.filtered = source.map((cmd) => ({
        command: cmd,
        match: { score: 0, indices: [] },
      }));
    } else {
      const scored: FilteredItem[] = [];
      for (const cmd of source) {
        const match = fuzzyMatch(this.query, cmd.label);
        if (match) {
          scored.push({ command: cmd, match });
        }
      }
      scored.sort((a, b) => b.match.score - a.match.score);
      this.filtered = scored;
    }

    // Clamp selection and reset scroll
    if (this.filtered.length === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = this.filtered.length - 1;
    }
    this.scrollOffset = 0;
    this.adjustScroll();
  }

  private adjustScroll(): void {
    const maxVisible = Math.min(this.filtered.length, MAX_VISIBLE_RESULTS);
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
