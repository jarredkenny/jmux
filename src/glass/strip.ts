import type { AgentState, CellGrid } from "../types";
import { ColorMode } from "../types";
import { createGrid, writeString, cellWidth } from "../cell-grid";
import type { TabEntry } from "./tabs";

export const STRIP_ROWS = 1;
const DOT = "●";
const GAP = 1; // blank column between chips
const INDICATOR_RESERVE = 5; // cols kept clear at the right for the "+N" overflow chip

export interface StripChip {
  tabId: string;
  x: number;
  width: number;
}

export interface StripInput {
  tabs: TabEntry[];
  activeTabId: string;
  summaryByTab: Map<string, AgentState | null>;
  width: number;
  palette: Record<AgentState, number>;
}

/** The strip is hidden until there is more than one tab. */
export function stripVisibleFor(tabs: TabEntry[]): boolean {
  return tabs.length >= 2;
}

function chipText(name: string, hasDot: boolean): string {
  return hasDot ? ` ${name} ${DOT} ` : ` ${name} `;
}

function textCols(s: string): number {
  let n = 0;
  for (const ch of s) n += cellWidth(ch.codePointAt(0) ?? 0);
  return n;
}

export function layoutStrip(input: StripInput): StripChip[] {
  // Natural display width of each chip.
  const widths = input.tabs.map((tab) => {
    const hasDot = (input.summaryByTab.get(tab.id) ?? null) !== null;
    return textCols(chipText(tab.name, hasDot));
  });

  // Total width if every chip were laid out (GAP between adjacent chips).
  let total = 0;
  for (let i = 0; i < widths.length; i++) total += widths[i] + (i > 0 ? GAP : 0);

  // When everything fits, use the full width; otherwise reserve room on the
  // right for the "+N" overflow indicator and pack whole chips into the rest.
  const fitsAll = total <= input.width;
  const budget = fitsAll ? input.width : Math.max(0, input.width - INDICATOR_RESERVE);

  const chips: StripChip[] = [];
  let x = 0;
  for (let i = 0; i < input.tabs.length; i++) {
    const w = widths[i];
    if (x + w > budget) break; // only whole chips are placed — no partial chip
    chips.push({ tabId: input.tabs[i].id, x, width: w });
    x += w + GAP;
  }
  return chips;
}

export function chipAtX(chips: StripChip[], x: number): string | null {
  for (const c of chips) {
    if (x >= c.x && x < c.x + c.width) return c.tabId;
  }
  return null;
}

export function renderStrip(
  input: StripInput,
  chips: StripChip[] = layoutStrip(input),
): CellGrid {
  const grid = createGrid(input.width, STRIP_ROWS);
  for (const chip of chips) {
    const tab = input.tabs.find((t) => t.id === chip.tabId)!;
    const isActive = chip.tabId === input.activeTabId;
    const summary = input.summaryByTab.get(chip.tabId) ?? null;
    const hasDot = summary !== null;
    const text = chipText(tab.name, hasDot);

    // Base chip text: bold when active, dim otherwise.
    writeString(grid, 0, chip.x, text, {
      fgMode: ColorMode.Palette,
      fg: isActive ? 15 : 8,
      bold: isActive,
      dim: !isActive,
    });

    // Recolor the dot cell by the summary state.
    if (hasDot) {
      const dotCol = chip.x + textCols(text.slice(0, text.indexOf(DOT)));
      if (dotCol >= 0 && dotCol < input.width) {
        const cell = grid.cells[0][dotCol];
        cell.char = DOT;
        cell.width = 1;
        cell.fgMode = ColorMode.Palette;
        cell.fg = input.palette[summary as AgentState];
        cell.bold = isActive;
        cell.dim = false;
      }
    }
  }

  // Overflow indicator: when some tabs didn't fit, show "+N" at the right edge.
  const hidden = input.tabs.length - chips.length;
  if (hidden > 0) {
    const label = `+${hidden}`;
    const col = input.width - textCols(label);
    if (col >= 0) {
      writeString(grid, 0, col, label, {
        fgMode: ColorMode.Palette,
        fg: 8,
        dim: true,
      });
    }
  }

  return grid;
}
