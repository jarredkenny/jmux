import type { PaletteCommand, PaletteSublistOption, PaletteResult, PaletteAction } from "./types";
import type { CellGrid } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import { ColorMode } from "./types";

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

  private refilter(): void {
    const source: PaletteCommand[] = this.sublistParent?.sublist
      ? this.sublistParent.sublist.map((opt) => ({
          id: opt.id,
          label: opt.label,
          category: this.sublistParent!.category,
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
