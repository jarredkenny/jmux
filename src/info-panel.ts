import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, textCols, type CellAttrs } from "./cell-grid";

export type InfoTab = "diff" | string; // "diff" is special, others are view IDs

const ACTIVE_TAB: CellAttrs = {
  fg: (0xfb << 16) | (0xd4 << 8) | 0xb8,
  fgMode: ColorMode.RGB,
  bold: true,
};

const INACTIVE_TAB: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
};

const HOVERED_TAB: CellAttrs = {
  fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9,
  fgMode: ColorMode.RGB,
};

const TAB_BG: CellAttrs = {
  bg: (0x16 << 16) | (0x1b << 8) | 0x22,
  bgMode: ColorMode.RGB,
};

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

  getTabBarGrid(cols: number, hoveredTab?: string | null): CellGrid {
    const grid = createGrid(cols, 1);
    let col = 1;

    // Fill leading padding with background
    if (cols > 0) {
      grid.cells[0][0].bg = TAB_BG.bg!;
      grid.cells[0][0].bgMode = TAB_BG.bgMode!;
    }

    for (let i = 0; i < this._tabs.length; i++) {
      const tab = this._tabs[i];
      const isActive = tab === this._activeTab;
      const isHovered = !isActive && hoveredTab === tab;
      const label = ` ${tab === "diff" ? "Diff" : (this._viewLabels.get(tab) ?? tab)} `;
      const attrs: CellAttrs = {
        ...(isActive ? ACTIVE_TAB : isHovered ? HOVERED_TAB : INACTIVE_TAB),
        ...TAB_BG,
      };
      writeString(grid, 0, col, label, attrs);
      col += textCols(label);

      if (i < this._tabs.length - 1) {
        writeString(grid, 0, col, "│", { ...INACTIVE_TAB, ...TAB_BG });
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
    const ranges: Array<{ tab: InfoTab; startCol: number; endCol: number }> = [];
    let col = 1; // 1 col padding
    for (let i = 0; i < this._tabs.length; i++) {
      const tab = this._tabs[i];
      const label = ` ${tab === "diff" ? "Diff" : (this._viewLabels.get(tab) ?? tab)} `;
      const labelWidth = textCols(label);
      ranges.push({ tab, startCol: col, endCol: col + labelWidth - 1 });
      col += labelWidth;
      if (i < this._tabs.length - 1) col += 1; // separator
    }
    return ranges;
  }

  private rebuildTabs(config: InfoPanelConfig): void {
    this._tabs = ["diff"];
    for (const id of config.viewIds) {
      this._tabs.push(id);
    }
    this._viewLabels = config.viewLabels;
  }
}
