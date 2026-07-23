import type { PaletteCommand, PaletteAction } from "./types";
import type { CellGrid } from "./types";
import { createGrid, writeString } from "./cell-grid";
import { fuzzyMatch, truncateLabel, type FuzzyResult } from "./fuzzy";
import {
  PROMPT_ATTRS, INPUT_ATTRS, RESULT_ATTRS, SELECTED_RESULT_ATTRS,
  MATCH_ATTRS, SELECTED_MATCH_ATTRS, CATEGORY_ATTRS, SELECTED_CATEGORY_ATTRS,
  CURRENT_TAG_ATTRS, SELECTED_CURRENT_TAG_ATTRS,
  BREADCRUMB_ATTRS, NO_MATCHES_ATTRS, BG_ATTRS, SELECTED_BG_ATTRS,
  modalContentRect, drawModalChrome, type ModalChrome,
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

  // The width of the last grid getGrid() built — getCursorPosition() has no
  // width parameter of its own (see the Modal interface), but needs it to
  // ask modalContentRect the same question getGrid() just did. The renderer
  // always calls getGrid() immediately before getCursorPosition() in the
  // same frame (see main.ts's computeModalOverlay), so this is never stale
  // in practice; the fallback only matters before the first render.
  private lastWidth = 40;

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
    return { row: this.getInputRow(), col: this.getCursorCol() };
  }

  /** Row of the input/breadcrumb line — right below the chrome title. */
  private getInputRow(): number {
    const rect = modalContentRect(this.buildChrome(), { cols: this.lastWidth, rows: this.getHeight() });
    return rect.top - 2; // title(1) + hairline(1) sit between the title row and this one
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

      // Disabled rows are inert: never execute, never drill in.
      if (selected.command.disabled) {
        return CONSUMED;
      }

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

  /** Visible result rows — 1 ("No matches") when the filter is empty. */
  private getResultsRows(): number {
    return Math.min(this.filtered.length || 1, MAX_VISIBLE_RESULTS);
  }

  /**
   * The palette's ModalChrome: a "Commands" title, the live result count,
   * and the flagship hint footer (↑↓ move · ↵ run · esc close) in the
   * shared dialect. A hairline separates the input line from the results.
   */
  private buildChrome(): ModalChrome {
    const n = this.filtered.length;
    return {
      title: "Commands",
      count: `${n} result${n === 1 ? "" : "s"}`,
      hints: [
        { key: "↑↓", label: "move" },
        { key: "↵", label: "run" },
        { key: "esc", label: "close" },
      ],
      hairlineAfterInput: true,
    };
  }

  getHeight(): number {
    // title(1) + input(1) + hairline(1) + hint(1) + results.
    return 4 + this.getResultsRows();
  }

  getGrid(width: number): CellGrid {
    this.lastWidth = width;
    const height = this.getHeight();
    const grid = createGrid(width, height);

    // Fill background
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    const chrome = this.buildChrome();
    const rect = modalContentRect(chrome, { cols: width, rows: height });
    const inputRow = rect.top - 2; // title + hairline sit between the title row and this one

    // Input line, directly under the title.
    if (this.sublistParent) {
      const breadcrumb = this.sublistParent.label + " › ";
      writeString(grid, inputRow, 0, breadcrumb, BREADCRUMB_ATTRS);
      writeString(grid, inputRow, breadcrumb.length, this.query, INPUT_ATTRS);
    } else {
      writeString(grid, inputRow, 0, "▷", PROMPT_ATTRS);
      writeString(grid, inputRow, 2, this.query, INPUT_ATTRS);
    }

    // Results (scrolled), inside the chrome-reserved content rect.
    const visibleCount = Math.min(this.filtered.length, rect.rows);
    if (this.filtered.length === 0) {
      writeString(grid, rect.top, 3, "No matches", NO_MATCHES_ATTRS);
    } else {
      for (let vi = 0; vi < visibleCount; vi++) {
        const i = this.scrollOffset + vi;
        const row = rect.top + vi;
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
        const rawLabel = item.command.hint
          ? `${item.command.label} — ${item.command.hint}`
          : item.command.label;
        const label = truncateLabel(rawLabel, maxLabelLen);
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

    drawModalChrome(grid, chrome);

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
