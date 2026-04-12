import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, cellWidth, type CellAttrs } from "./cell-grid";

export type InfoTab = "diff" | "mr" | "issues";

const TAB_LABELS: Record<InfoTab, string> = {
  diff: "Diff",
  mr: "MR",
  issues: "Issues",
};

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

const TAB_BG: CellAttrs = {
  bg: (0x16 << 16) | (0x1b << 8) | 0x22,
  bgMode: ColorMode.RGB,
};

export interface InfoPanelConfig {
  hasCodeHost: boolean;
  hasIssueTracker: boolean;
}

function textCols(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += cellWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

export class InfoPanel {
  private _tabs: InfoTab[] = [];
  private _activeTab: InfoTab = "diff";

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

  getTabBarGrid(cols: number): CellGrid {
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
      const label = ` ${TAB_LABELS[tab]} `;
      const attrs: CellAttrs = {
        ...(isActive ? ACTIVE_TAB : INACTIVE_TAB),
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
      const label = ` ${TAB_LABELS[tab]} `;
      const labelWidth = textCols(label);
      ranges.push({ tab, startCol: col, endCol: col + labelWidth - 1 });
      col += labelWidth;
      if (i < this._tabs.length - 1) col += 1; // separator
    }
    return ranges;
  }

  private rebuildTabs(config: InfoPanelConfig): void {
    this._tabs = ["diff"];
    if (config.hasCodeHost) this._tabs.push("mr");
    if (config.hasIssueTracker) this._tabs.push("issues");
  }
}
