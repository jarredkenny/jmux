import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

// --- Setting definitions ---

export type SettingType = "text" | "boolean" | "list" | "map";

export interface SettingDef {
  id: string;
  label: string;
  type: SettingType;
  category: string;
  getValue: () => string;  // display value
}

export interface SettingsCategory {
  label: string;
  collapsed: boolean;
  settings: SettingDef[];
}

// --- Rendering constants ---

const HEADER_ATTRS: CellAttrs = {
  fg: (0xFB << 16) | (0xD4 << 8) | 0xB8,
  fgMode: ColorMode.RGB,
  bold: true,
};
const CATEGORY_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, bold: true };
const CATEGORY_ACTIVE: CellAttrs = {
  fg: (0xFB << 16) | (0xD4 << 8) | 0xB8,
  fgMode: ColorMode.RGB,
  bold: true,
};
const LABEL_ATTRS: CellAttrs = {
  fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9,
  fgMode: ColorMode.RGB,
};
const LABEL_ACTIVE: CellAttrs = {
  fg: (0xFB << 16) | (0xD4 << 8) | 0xB8,
  fgMode: ColorMode.RGB,
  bold: true,
};
const VALUE_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
const VALUE_ACTIVE: CellAttrs = {
  fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9,
  fgMode: ColorMode.RGB,
};
const DIM_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const HINT_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const CURSOR_ATTRS: CellAttrs = {
  fg: (0xFB << 16) | (0xD4 << 8) | 0xB8,
  fgMode: ColorMode.RGB,
};

// --- Visible node model ---

type SettingsNode =
  | { kind: "category"; label: string; collapsed: boolean; count: number }
  | { kind: "setting"; setting: SettingDef };

export class SettingsScreen {
  private categories: SettingsCategory[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private _open = false;

  get isOpen(): boolean {
    return this._open;
  }

  open(categories: SettingsCategory[]): void {
    this.categories = categories;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this._open = true;
  }

  close(): void {
    this._open = false;
  }

  getSelectedSetting(): SettingDef | null {
    const nodes = this.buildNodes();
    const node = nodes[this.selectedIndex];
    if (node?.kind === "setting") return node.setting;
    return null;
  }

  getSelectedCategory(): string | null {
    const nodes = this.buildNodes();
    const node = nodes[this.selectedIndex];
    if (node?.kind === "category") return node.label;
    return null;
  }

  moveUp(): void {
    if (this.selectedIndex > 0) this.selectedIndex--;
    this.ensureVisible();
  }

  moveDown(): void {
    const nodes = this.buildNodes();
    if (this.selectedIndex < nodes.length - 1) this.selectedIndex++;
    this.ensureVisible();
  }

  toggleCollapse(): void {
    const nodes = this.buildNodes();
    const node = nodes[this.selectedIndex];
    if (node?.kind === "category") {
      const cat = this.categories.find((c) => c.label === node.label);
      if (cat) cat.collapsed = !cat.collapsed;
    }
  }

  updateCategories(categories: SettingsCategory[]): void {
    // Preserve collapse state
    for (const cat of categories) {
      const existing = this.categories.find((c) => c.label === cat.label);
      if (existing) cat.collapsed = existing.collapsed;
    }
    this.categories = categories;
    // Clamp selection
    const nodes = this.buildNodes();
    if (this.selectedIndex >= nodes.length) {
      this.selectedIndex = Math.max(0, nodes.length - 1);
    }
  }

  render(cols: number, rows: number): CellGrid {
    const grid = createGrid(cols, rows);
    const nodes = this.buildNodes();
    const pad = 2;

    // Header
    writeString(grid, 0, pad, "Settings", HEADER_ATTRS);
    writeString(grid, 1, pad, "Enter to edit  ·  Esc to close  ·  ↑↓ navigate", HINT_ATTRS);

    const startRow = 3;
    const maxRows = rows - startRow;

    for (let i = 0; i < nodes.length; i++) {
      const row = startRow + i - this.scrollOffset;
      if (row < startRow || row >= rows) continue;

      const node = nodes[i];
      const isSelected = i === this.selectedIndex;

      if (node.kind === "category") {
        const chevron = node.collapsed ? "▸" : "▾";
        const label = `${chevron} ${node.label} (${node.count})`;
        writeString(grid, row, pad, label, isSelected ? CATEGORY_ACTIVE : CATEGORY_ATTRS);
        if (isSelected) writeString(grid, row, pad - 1, "▸", CURSOR_ATTRS);
      } else {
        const indent = pad + 2;
        const setting = node.setting;
        const value = setting.getValue();
        const maxLabelLen = Math.floor((cols - indent - 2) * 0.5);
        const displayLabel = setting.label.length > maxLabelLen
          ? setting.label.slice(0, maxLabelLen - 1) + "\u2026"
          : setting.label;

        writeString(grid, row, indent, displayLabel, isSelected ? LABEL_ACTIVE : LABEL_ATTRS);

        // Right-align value
        const valueStr = value.length > 25 ? value.slice(0, 24) + "\u2026" : value;
        const valueCol = cols - valueStr.length - pad;
        if (valueCol > indent + displayLabel.length + 1) {
          // Dotted leader between label and value
          const leaderStart = indent + displayLabel.length + 1;
          const leaderEnd = valueCol - 1;
          if (leaderEnd > leaderStart) {
            const dots = " " + "·".repeat(Math.min(leaderEnd - leaderStart - 1, 20)) + " ";
            const dotsStart = Math.max(leaderStart, valueCol - dots.length);
            writeString(grid, row, dotsStart, dots, DIM_ATTRS);
          }
          writeString(grid, row, valueCol, valueStr, isSelected ? VALUE_ACTIVE : VALUE_ATTRS);
        }

        if (isSelected) writeString(grid, row, indent - 2, "▸", CURSOR_ATTRS);
      }
    }

    return grid;
  }

  private buildNodes(): SettingsNode[] {
    const nodes: SettingsNode[] = [];
    for (const cat of this.categories) {
      nodes.push({
        kind: "category",
        label: cat.label,
        collapsed: cat.collapsed,
        count: cat.settings.length,
      });
      if (!cat.collapsed) {
        for (const setting of cat.settings) {
          nodes.push({ kind: "setting", setting });
        }
      }
    }
    return nodes;
  }

  private ensureVisible(): void {
    const startRow = 3;
    const relativeIdx = this.selectedIndex - this.scrollOffset;
    if (relativeIdx < 0) {
      this.scrollOffset = this.selectedIndex;
    } else if (relativeIdx >= 20) { // rough visible count
      this.scrollOffset = this.selectedIndex - 19;
    }
  }
}
