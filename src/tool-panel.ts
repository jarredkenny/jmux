import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

export type PanelTab = "diff" | "agent";

const TABS: PanelTab[] = ["diff", "agent"];
const TAB_LABELS: Record<PanelTab, string> = { diff: "Diff", agent: "Agent" };

const ACTIVE_TAB_ATTRS: CellAttrs = { bold: true, fg: 15, fgMode: ColorMode.Palette };
const INACTIVE_TAB_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
const TAB_BAR_BG: CellAttrs = { bg: (0x1a << 16) | (0x1a << 8) | 0x1a, bgMode: ColorMode.RGB };
const SEPARATOR_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };

export class ToolPanel {
  private _activeTab: PanelTab = "diff";

  get activeTab(): PanelTab {
    return this._activeTab;
  }

  switchTab(tab: PanelTab): void {
    this._activeTab = tab;
  }

  nextTab(): void {
    const idx = TABS.indexOf(this._activeTab);
    this._activeTab = TABS[(idx + 1) % TABS.length];
  }

  renderTabBar(cols: number): CellGrid {
    const grid = createGrid(cols, 1);

    // Fill background
    const bgFill = " ".repeat(cols);
    writeString(grid, 0, 0, bgFill, TAB_BAR_BG);

    let col = 1;
    for (let i = 0; i < TABS.length; i++) {
      const tab = TABS[i];
      const label = TAB_LABELS[tab];
      const isActive = tab === this._activeTab;
      const attrs: CellAttrs = {
        ...(isActive ? ACTIVE_TAB_ATTRS : INACTIVE_TAB_ATTRS),
        ...TAB_BAR_BG,
      };
      writeString(grid, 0, col, label, attrs);
      col += label.length;

      if (i < TABS.length - 1) {
        writeString(grid, 0, col + 1, "|", { ...SEPARATOR_ATTRS, ...TAB_BAR_BG });
        col += 3;
      }
    }

    return grid;
  }
}
