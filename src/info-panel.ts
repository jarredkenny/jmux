import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeStyledLine, textCols, type CellAttrs } from "./cell-grid";
import { packChips, type PlacedChip } from "./band-layout";
import { theme, accentFor, neutralFg } from "./theme";

export type InfoTab = "diff" | string; // "diff" is special, others are view IDs

// Warm accent for the active tab (peach on dark themes, darkened on light).
const ACTIVE_TAB_ACCENT = (0xfb << 16) | (0xd4 << 8) | 0xb8;

// These attr objects are re-themed in place by rebuildInfoPanelColors(): the
// active tab uses the adaptive warm accent, the hovered tab uses neutral text
// (terminal default fg once a theme is detected), and the tab-bar surface
// tracks the detected background. They start on the dark defaults.
const ACTIVE_TAB: CellAttrs = {
  fg: ACTIVE_TAB_ACCENT,
  fgMode: ColorMode.RGB,
  bold: true,
};

const INACTIVE_TAB: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
};

const HOVERED_TAB: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
};

const TAB_BG: CellAttrs = {
  bg: theme.surface,
  bgMode: ColorMode.RGB,
};

export function rebuildInfoPanelColors(): void {
  TAB_BG.bg = theme.surface;
  ACTIVE_TAB.fg = accentFor(ACTIVE_TAB_ACCENT);
  const hovered = neutralFg(7);
  HOVERED_TAB.fg = hovered.fg;
  HOVERED_TAB.fgMode = hovered.fgMode;
}
rebuildInfoPanelColors();

export interface InfoPanelConfig {
  viewIds: string[];      // ordered list of view IDs to show as tabs
  viewLabels: Map<string, string>; // id → label for tab bar rendering
}

export class InfoPanel {
  private _tabs: InfoTab[] = [];
  private _activeTab: InfoTab = "diff";
  private _viewLabels = new Map<string, string>();

  constructor(config: InfoPanelConfig) {
    this.rebuildTabs(config);
  }

  get tabs(): InfoTab[] {
    return [...this._tabs];
  }

  get activeTab(): InfoTab {
    return this._activeTab;
  }

  get hasMultipleTabs(): boolean {
    return this._tabs.length > 1;
  }

  updateConfig(config: InfoPanelConfig): void {
    const prevActive = this._activeTab;
    this.rebuildTabs(config);
    if (!this._tabs.includes(prevActive)) {
      this._activeTab = "diff";
    }
  }

  setActiveTab(tab: InfoTab): void {
    if (this._tabs.includes(tab)) {
      this._activeTab = tab;
    }
  }

  nextTab(): void {
    if (this._tabs.length <= 1) return;
    const idx = this._tabs.indexOf(this._activeTab);
    this._activeTab = this._tabs[(idx + 1) % this._tabs.length];
  }

  prevTab(): void {
    if (this._tabs.length <= 1) return;
    const idx = this._tabs.indexOf(this._activeTab);
    this._activeTab = this._tabs[(idx - 1 + this._tabs.length) % this._tabs.length];
  }

  private tabLabel(tab: InfoTab): string {
    return ` ${tab === "diff" ? "Diff" : (this._viewLabels.get(tab) ?? tab)} `;
  }

  // Places every tab once (paint and hit-test both read from this). No
  // budget cutoff — `getTabRanges` never dropped a tab that didn't fit
  // before this refactor (it just returned an unreachable range past the
  // grid's width), so `budget: Infinity` preserves that rather than
  // introducing a new whole-chip-drop behaviour here.
  private layoutTabs(): PlacedChip[] {
    const items = this._tabs.map((tab) => ({ id: tab, width: textCols(this.tabLabel(tab)) }));
    return packChips(items, { start: 1, budget: Infinity, align: "left", sepWidth: 1 });
  }

  getTabBarGrid(cols: number, hoveredTab?: string | null): CellGrid {
    const grid = createGrid(cols, 1);

    // Fill leading padding with background
    if (cols > 0) {
      grid.cells[0][0].bg = TAB_BG.bg!;
      grid.cells[0][0].bgMode = TAB_BG.bgMode!;
    }

    const chips = this.layoutTabs();
    let col = 1;
    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i];
      const tab = chip.id;
      const isActive = tab === this._activeTab;
      const isHovered = !isActive && hoveredTab === tab;
      const label = this.tabLabel(tab);
      const attrs: CellAttrs = {
        ...(isActive ? ACTIVE_TAB : isHovered ? HOVERED_TAB : INACTIVE_TAB),
        ...TAB_BG,
      };
      writeStyledLine(grid, 0, chip.x, [{ text: label, attrs }]);
      col = chip.x + chip.width;

      if (i < chips.length - 1) {
        writeStyledLine(grid, 0, col, [{ text: "│", attrs: { ...INACTIVE_TAB, ...TAB_BG } }]);
        col += 1;
      }
    }

    // Fill remaining columns with background
    for (let c = col; c < cols; c++) {
      grid.cells[0][c].bg = TAB_BG.bg!;
      grid.cells[0][c].bgMode = TAB_BG.bgMode!;
    }

    return grid;
  }

  getTabRanges(): Array<{ tab: InfoTab; startCol: number; endCol: number }> {
    return this.layoutTabs().map((chip) => ({
      tab: chip.id,
      startCol: chip.x,
      endCol: chip.x + chip.width - 1,
    }));
  }

  private rebuildTabs(config: InfoPanelConfig): void {
    this._tabs = ["diff"];
    for (const id of config.viewIds) {
      this._tabs.push(id);
    }
    this._viewLabels = config.viewLabels;
  }
}
