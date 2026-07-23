import type { AgentState, CellGrid } from "../types";
import { ColorMode } from "../types";
import { createGrid, writeString, textCols } from "../cell-grid";
import { packChips, type PlacedChip } from "../band-layout";
import type { TabEntry } from "./tabs";
import { stateAttrs, type StateColor } from "../state-colors";

export const STRIP_ROWS = 1;
const DOT = "●";
const GAP = 1; // blank column between chips
const INDICATOR_RESERVE = 5; // cols kept clear at the right for the "+N" overflow chip

export interface StripInput {
  tabs: TabEntry[];
  activeTabId: string;
  summaryByTab: Map<string, AgentState | null>;
  width: number;
  palette: Record<AgentState, StateColor>;
}

/** The strip is hidden until there is more than one tab. */
export function stripVisibleFor(tabs: TabEntry[]): boolean {
  return tabs.length >= 2;
}

function chipText(name: string, hasDot: boolean): string {
  return hasDot ? ` ${name} ${DOT} ` : ` ${name} `;
}

export function layoutStrip(input: StripInput): PlacedChip[] {
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

  const items = input.tabs.map((tab, i) => ({ id: tab.id, width: widths[i] }));
  return packChips(items, { start: 0, budget, align: "left", gap: GAP });
}

export function renderStrip(
  input: StripInput,
  chips: PlacedChip[] = layoutStrip(input),
): CellGrid {
  const grid = createGrid(input.width, STRIP_ROWS);
  for (const chip of chips) {
    const tab = input.tabs.find((t) => t.id === chip.id)!;
    const isActive = chip.id === input.activeTabId;
    const summary = input.summaryByTab.get(chip.id) ?? null;
    const hasDot = summary !== null;
    const text = chipText(tab.name, hasDot);

    // Base chip text: bold when active, dim otherwise.
    writeString(grid, 0, chip.x, text, {
      fgMode: ColorMode.Palette,
      fg: isActive ? 15 : 8,
      bold: isActive,
      dim: !isActive,
    });

    // Recolor the dot cell by the summary state. Bold reflects the active
    // tab, not the per-state emphasis (waiting bold / complete dim) the
    // sidebar uses — this is a single tab-summary dot, not an agent-state row.
    if (hasDot) {
      const dotCol = chip.x + textCols(text.slice(0, text.indexOf(DOT)));
      if (dotCol >= 0 && dotCol < input.width) {
        const cell = grid.cells[0][dotCol];
        cell.char = DOT;
        cell.width = 1;
        const attrs = stateAttrs(input.palette[summary as AgentState], { bold: isActive, dim: false });
        cell.fg = attrs.fg ?? cell.fg;
        cell.fgMode = attrs.fgMode ?? cell.fgMode;
        cell.bold = attrs.bold ?? false;
        cell.dim = attrs.dim ?? false;
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
