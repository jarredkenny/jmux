export type PanelTab = "diff" | "agent";

const TABS: PanelTab[] = ["diff", "agent"];

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
}
