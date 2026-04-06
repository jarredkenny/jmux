import type { PaletteCommand, PaletteResult, PaletteAction } from "./types";
import type { CellGrid } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import { ColorMode } from "./types";

const MAX_VISIBLE_RESULTS = 10;
const PALETTE_BG = (0x16 << 16) | (0x1b << 8) | 0x22; // #161b22
const SELECTED_BG = (0x1e << 16) | (0x2a << 8) | 0x35; // #1e2a35

const PROMPT_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};
const QUERY_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};
const RESULT_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};
const SELECTED_RESULT_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};
const MATCH_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};
const SELECTED_MATCH_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};
const CATEGORY_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};
const SELECTED_CATEGORY_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};
const CURRENT_TAG_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};
const SELECTED_CURRENT_TAG_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};
const BORDER_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};
const BREADCRUMB_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};
const NO_MATCHES_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};

export interface FilteredItem {
  command: PaletteCommand;
  match: FuzzyResult;
}

export interface FuzzyResult {
  score: number;
  indices: number[];
}

export function fuzzyMatch(query: string, label: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, indices: [] };
  if (label.length === 0) return null;

  const lowerQuery = query.toLowerCase();
  const lowerLabel = label.toLowerCase();
  const indices: number[] = [];
  let qi = 0;

  for (let li = 0; li < lowerLabel.length && qi < lowerQuery.length; li++) {
    if (lowerLabel[li] === lowerQuery[qi]) {
      indices.push(li);
      qi++;
    }
  }

  if (qi < lowerQuery.length) return null;

  let score = 0;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) score += 10;
  }
  for (const idx of indices) {
    if (idx === 0 || label[idx - 1] === " " || label[idx - 1] === "-" || label[idx - 1] === "_") {
      score += 6;
    }
  }

  return { score, indices };
}

function truncateLabel(label: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (label.length <= maxLen) return label;
  if (maxLen <= 1) return "…";
  return label.slice(0, maxLen - 1) + "…";
}

const CONSUMED: PaletteAction = { type: "consumed" };
const CLOSED: PaletteAction = { type: "closed" };

export class CommandPalette {
  private _open = false;
  private query = "";
  private selectedIndex = 0;
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
          type: "execute",
          result: {
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
        type: "execute",
        result: { commandId: selected.command.id },
      };
    }

    // Arrow down
    if (data === "\x1b[B") {
      if (this.filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
      }
      return CONSUMED;
    }

    // Arrow up
    if (data === "\x1b[A") {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
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
    return 1 + Math.min(this.filtered.length || 1, MAX_VISIBLE_RESULTS) + 1;
  }

  getGrid(width: number): CellGrid {
    const height = this.getHeight();
    const grid = createGrid(width, height);

    // Fill background
    const bgAttrs: CellAttrs = { bg: PALETTE_BG, bgMode: ColorMode.RGB };
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), bgAttrs);
    }

    // Row 0: input line
    if (this.sublistParent) {
      const breadcrumb = this.sublistParent.label + " › ";
      writeString(grid, 0, 0, breadcrumb, BREADCRUMB_ATTRS);
      writeString(grid, 0, breadcrumb.length, this.query, QUERY_ATTRS);
    } else {
      writeString(grid, 0, 0, "▷", PROMPT_ATTRS);
      writeString(grid, 0, 2, this.query, QUERY_ATTRS);
    }

    // Rows 1..N: results
    const visibleCount = Math.min(this.filtered.length, MAX_VISIBLE_RESULTS);
    if (this.filtered.length === 0) {
      writeString(grid, 1, 3, "No matches", NO_MATCHES_ATTRS);
    } else {
      for (let i = 0; i < visibleCount; i++) {
        const row = i + 1;
        const item = this.filtered[i];
        const isSelected = i === this.selectedIndex;
        const baseAttrs = isSelected ? SELECTED_RESULT_ATTRS : RESULT_ATTRS;

        // Paint selected row background
        if (isSelected) {
          writeString(grid, row, 0, " ".repeat(width), { bg: SELECTED_BG, bgMode: ColorMode.RGB });
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

    // Last row: border
    const borderRow = height - 1;
    writeString(grid, borderRow, 0, "─".repeat(width), BORDER_ATTRS);

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

    // Clamp selection
    if (this.filtered.length === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = this.filtered.length - 1;
    }
  }
}
