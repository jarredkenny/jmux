import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

// --- Setting definitions ---

export interface SettingDef {
  id: string;
  label: string;
  type: "boolean" | "text" | "list" | "map";
  getValue: () => string;
  // For boolean: toggle callback
  onToggle?: () => void;
  // For text: commit callback
  onTextCommit?: (value: string) => void;
  // For list: cycle through options
  options?: string[];
  onOptionSelect?: (value: string) => void;
  // For map: entries + CRUD callbacks
  getMapEntries?: () => Array<{ key: string; value: string }>;
  onMapAdd?: () => Promise<{ key: string; value: string } | null>;  // returns new entry or null
  onMapRemove?: (key: string) => void;
  onMapEdit?: (key: string) => Promise<string | null>;  // returns new value or null
}

export interface SettingsCategory {
  label: string;
  collapsed: boolean;
  settings: SettingDef[];
}

// --- Rendering constants ---

const PEACH = (0xFB << 16) | (0xD4 << 8) | 0xB8;
const LIGHT = (0xC9 << 16) | (0xD1 << 8) | 0xD9;

const HEADER_ATTRS: CellAttrs = { fg: PEACH, fgMode: ColorMode.RGB, bold: true };
const CATEGORY_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, bold: true };
const CATEGORY_ACTIVE: CellAttrs = { fg: PEACH, fgMode: ColorMode.RGB, bold: true };
const LABEL_ATTRS: CellAttrs = { fg: LIGHT, fgMode: ColorMode.RGB };
const LABEL_ACTIVE: CellAttrs = { fg: PEACH, fgMode: ColorMode.RGB, bold: true };
const VALUE_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
const VALUE_ACTIVE: CellAttrs = { fg: LIGHT, fgMode: ColorMode.RGB };
const DIM_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const HINT_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const CURSOR_ATTRS: CellAttrs = { fg: PEACH, fgMode: ColorMode.RGB };
const EDIT_BG: CellAttrs = { bg: (0x1A << 16) | (0x1F << 8) | 0x26, bgMode: ColorMode.RGB };
const EDIT_TEXT: CellAttrs = { fg: LIGHT, fgMode: ColorMode.RGB, bg: (0x1A << 16) | (0x1F << 8) | 0x26, bgMode: ColorMode.RGB };
const EDIT_CURSOR: CellAttrs = { fg: PEACH, fgMode: ColorMode.RGB, bg: (0x2D << 16) | (0x33 << 8) | 0x3B, bgMode: ColorMode.RGB };
const MAP_KEY_ATTRS: CellAttrs = { fg: 5, fgMode: ColorMode.Palette };
const MAP_VAL_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
const MAP_KEY_ACTIVE: CellAttrs = { fg: PEACH, fgMode: ColorMode.RGB };
const MAP_ADD_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const ON_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const OFF_ATTRS: CellAttrs = { fg: 1, fgMode: ColorMode.Palette };

// --- Node model ---

type SettingsNode =
  | { kind: "category"; label: string; collapsed: boolean; count: number }
  | { kind: "setting"; setting: SettingDef }
  | { kind: "map-entry"; parentId: string; key: string; value: string }
  | { kind: "map-add"; parentId: string };

type EditState =
  | null
  | { mode: "text"; settingId: string; buffer: string; cursorPos: number }
  | { mode: "list"; settingId: string; optionIndex: number; options: string[] };

export type SettingsAction =
  | { type: "none" }
  | { type: "map-add"; settingId: string }
  | { type: "map-edit"; settingId: string; key: string };

export class SettingsScreen {
  private categories: SettingsCategory[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private _open = false;
  private lastRenderRows = 24;
  private editState: EditState = null;
  private expandedMaps = new Set<string>();

  get isOpen(): boolean { return this._open; }
  get isEditing(): boolean { return this.editState !== null; }

  open(categories: SettingsCategory[]): void {
    this.categories = categories;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.editState = null;
    this._open = true;
  }

  close(): void {
    this._open = false;
    this.editState = null;
  }

  updateCategories(categories: SettingsCategory[]): void {
    for (const cat of categories) {
      const existing = this.categories.find((c) => c.label === cat.label);
      if (existing) cat.collapsed = existing.collapsed;
    }
    this.categories = categories;
    const nodes = this.buildNodes();
    if (this.selectedIndex >= nodes.length) {
      this.selectedIndex = Math.max(0, nodes.length - 1);
    }
  }

  // Returns an action that main.ts needs to handle asynchronously (map add/edit)
  handleInput(data: string): SettingsAction {
    // Editing mode
    if (this.editState) {
      return this.handleEditInput(data);
    }

    // Navigation mode
    if (data === "\x1b" || data === "q") {
      this.close();
      return { type: "none" };
    }
    if (data === "\x1b[A") { this.moveUp(); return { type: "none" }; }
    if (data === "\x1b[B") { this.moveDown(); return { type: "none" }; }

    if (data === "\r") {
      return this.handleEnter();
    }

    // Delete key on map entries
    if ((data === "d" || data === "\x7f") && this.getSelectedMapEntry()) {
      const node = this.getSelectedNode();
      if (node?.kind === "map-entry") {
        const setting = this.findSetting(node.parentId);
        if (setting?.onMapRemove) {
          setting.onMapRemove(node.key);
        }
      }
      return { type: "none" };
    }

    return { type: "none" };
  }

  render(cols: number, rows: number): CellGrid {
    this.lastRenderRows = rows;
    const grid = createGrid(cols, rows);
    const nodes = this.buildNodes();
    const pad = 2;

    // Header
    writeString(grid, 0, pad, "Settings", HEADER_ATTRS);
    const hint = this.editState
      ? "Enter to confirm  ·  Esc to cancel"
      : "Enter to edit  ·  Esc to close  ·  ↑↓ navigate";
    writeString(grid, 1, pad, hint, HINT_ATTRS);

    const startRow = 3;

    for (let i = 0; i < nodes.length; i++) {
      const row = startRow + i - this.scrollOffset;
      if (row < startRow || row >= rows) continue;

      const node = nodes[i];
      const isSelected = i === this.selectedIndex;

      if (node.kind === "category") {
        this.renderCategory(grid, row, cols, pad, node, isSelected);
      } else if (node.kind === "setting") {
        this.renderSetting(grid, row, cols, pad, node.setting, isSelected);
      } else if (node.kind === "map-entry") {
        this.renderMapEntry(grid, row, cols, pad, node, isSelected);
      } else if (node.kind === "map-add") {
        const indent = pad + 4;
        writeString(grid, row, indent, "+ Add mapping", isSelected ? MAP_KEY_ACTIVE : MAP_ADD_ATTRS);
        if (isSelected) writeString(grid, row, indent - 2, "▸", CURSOR_ATTRS);
      }
    }

    return grid;
  }

  // --- Private: rendering helpers ---

  private renderCategory(grid: CellGrid, row: number, cols: number, pad: number, node: Extract<SettingsNode, { kind: "category" }>, selected: boolean): void {
    const chevron = node.collapsed ? "▸" : "▾";
    const label = `${chevron} ${node.label} (${node.count})`;
    writeString(grid, row, pad, label, selected ? CATEGORY_ACTIVE : CATEGORY_ATTRS);
    if (selected) writeString(grid, row, pad - 1, "▸", CURSOR_ATTRS);
  }

  private renderSetting(grid: CellGrid, row: number, cols: number, pad: number, setting: SettingDef, selected: boolean): void {
    const indent = pad + 2;

    // Check if this setting is being edited
    if (this.editState?.settingId === setting.id) {
      if (this.editState.mode === "text") {
        this.renderTextEdit(grid, row, cols, pad, setting, this.editState);
        return;
      }
      if (this.editState.mode === "list") {
        this.renderListEdit(grid, row, cols, pad, setting, this.editState);
        return;
      }
    }

    const maxLabelLen = Math.floor((cols - indent - 2) * 0.5);
    const displayLabel = setting.label.length > maxLabelLen
      ? setting.label.slice(0, maxLabelLen - 1) + "\u2026"
      : setting.label;

    writeString(grid, row, indent, displayLabel, selected ? LABEL_ACTIVE : LABEL_ATTRS);

    // Value
    const value = setting.getValue();
    const isBoolean = setting.type === "boolean";
    const isMap = setting.type === "map";
    const valueStr = isMap
      ? (this.expandedMaps.has(setting.id) ? "▾" : `▸ ${value}`)
      : value.length > 25 ? value.slice(0, 24) + "\u2026" : value;

    const valueCol = cols - valueStr.length - pad;
    if (valueCol > indent + displayLabel.length + 1) {
      // Dotted leader
      const leaderStart = indent + displayLabel.length + 1;
      const leaderEnd = valueCol - 1;
      if (leaderEnd > leaderStart && !isMap) {
        const maxDots = Math.min(leaderEnd - leaderStart - 1, 20);
        if (maxDots > 0) {
          const dots = " " + "·".repeat(maxDots) + " ";
          const dotsStart = Math.max(leaderStart, valueCol - dots.length);
          writeString(grid, row, dotsStart, dots, DIM_ATTRS);
        }
      }

      let valAttrs: CellAttrs;
      if (isBoolean) {
        valAttrs = value === "on" ? ON_ATTRS : OFF_ATTRS;
      } else {
        valAttrs = selected ? VALUE_ACTIVE : VALUE_ATTRS;
      }
      writeString(grid, row, valueCol, valueStr, valAttrs);
    }

    if (selected) writeString(grid, row, indent - 2, "▸", CURSOR_ATTRS);
  }

  private renderTextEdit(grid: CellGrid, row: number, cols: number, pad: number, setting: SettingDef, state: Extract<EditState, { mode: "text" }>): void {
    const indent = pad + 2;
    writeString(grid, row, indent, setting.label + ": ", LABEL_ACTIVE);
    const fieldStart = indent + setting.label.length + 2;
    const fieldWidth = cols - fieldStart - pad;

    // Background for edit field
    const bg = " ".repeat(fieldWidth);
    writeString(grid, row, fieldStart, bg, EDIT_BG);

    // Buffer text
    const displayBuf = state.buffer.length > fieldWidth - 1
      ? state.buffer.slice(state.buffer.length - fieldWidth + 1)
      : state.buffer;
    writeString(grid, row, fieldStart, displayBuf, EDIT_TEXT);

    // Cursor
    const cursorCol = fieldStart + Math.min(state.cursorPos, fieldWidth - 1);
    const cursorChar = state.cursorPos < state.buffer.length ? state.buffer[state.cursorPos] : " ";
    writeString(grid, row, cursorCol, cursorChar, EDIT_CURSOR);
  }

  private renderListEdit(grid: CellGrid, row: number, cols: number, pad: number, setting: SettingDef, state: Extract<EditState, { mode: "list" }>): void {
    const indent = pad + 2;
    writeString(grid, row, indent, setting.label + ": ", LABEL_ACTIVE);
    const fieldStart = indent + setting.label.length + 2;

    // Show current option with arrows
    const option = state.options[state.optionIndex];
    writeString(grid, row, fieldStart, `◂ ${option} ▸`, { fg: PEACH, fgMode: ColorMode.RGB });
  }

  private renderMapEntry(grid: CellGrid, row: number, cols: number, pad: number, node: Extract<SettingsNode, { kind: "map-entry" }>, selected: boolean): void {
    const indent = pad + 4;
    const keyStr = node.key;
    const valStr = node.value.length > 30 ? node.value.slice(0, 29) + "\u2026" : node.value;

    writeString(grid, row, indent, keyStr, selected ? MAP_KEY_ACTIVE : MAP_KEY_ATTRS);
    writeString(grid, row, indent + keyStr.length, " → ", DIM_ATTRS);
    writeString(grid, row, indent + keyStr.length + 3, valStr, selected ? VALUE_ACTIVE : MAP_VAL_ATTRS);

    if (selected) {
      writeString(grid, row, indent - 2, "▸", CURSOR_ATTRS);
      // Hint for delete
      const hintCol = cols - 10;
      if (hintCol > indent + keyStr.length + valStr.length + 5) {
        writeString(grid, row, hintCol, "[d] remove", HINT_ATTRS);
      }
    }
  }

  // --- Private: input handling ---

  private handleEditInput(data: string): SettingsAction {
    if (!this.editState) return { type: "none" };

    if (this.editState.mode === "text") {
      const state = this.editState;
      if (data === "\x1b") {
        // Cancel
        this.editState = null;
        return { type: "none" };
      }
      if (data === "\r") {
        // Commit
        const setting = this.findSetting(state.settingId);
        if (setting?.onTextCommit) setting.onTextCommit(state.buffer);
        this.editState = null;
        return { type: "none" };
      }
      if (data === "\x7f" || data === "\b") {
        // Backspace
        if (state.cursorPos > 0) {
          state.buffer = state.buffer.slice(0, state.cursorPos - 1) + state.buffer.slice(state.cursorPos);
          state.cursorPos--;
        }
        return { type: "none" };
      }
      if (data === "\x1b[D") { // Left
        if (state.cursorPos > 0) state.cursorPos--;
        return { type: "none" };
      }
      if (data === "\x1b[C") { // Right
        if (state.cursorPos < state.buffer.length) state.cursorPos++;
        return { type: "none" };
      }
      if (data === "\x1b[H" || data === "\x01") { // Home / Ctrl-a
        state.cursorPos = 0;
        return { type: "none" };
      }
      if (data === "\x1b[F" || data === "\x05") { // End / Ctrl-e
        state.cursorPos = state.buffer.length;
        return { type: "none" };
      }
      // Printable character
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        state.buffer = state.buffer.slice(0, state.cursorPos) + data + state.buffer.slice(state.cursorPos);
        state.cursorPos++;
        return { type: "none" };
      }
      return { type: "none" };
    }

    if (this.editState.mode === "list") {
      const state = this.editState;
      if (data === "\x1b") {
        this.editState = null;
        return { type: "none" };
      }
      if (data === "\x1b[D" || data === "h") { // Left
        state.optionIndex = (state.optionIndex - 1 + state.options.length) % state.options.length;
        return { type: "none" };
      }
      if (data === "\x1b[C" || data === "l") { // Right
        state.optionIndex = (state.optionIndex + 1) % state.options.length;
        return { type: "none" };
      }
      if (data === "\r") {
        const setting = this.findSetting(state.settingId);
        const value = state.options[state.optionIndex];
        if (setting?.onOptionSelect) setting.onOptionSelect(value);
        this.editState = null;
        return { type: "none" };
      }
      return { type: "none" };
    }

    return { type: "none" };
  }

  private handleEnter(): SettingsAction {
    const nodes = this.buildNodes();
    const node = nodes[this.selectedIndex];
    if (!node) return { type: "none" };

    if (node.kind === "category") {
      const cat = this.categories.find((c) => c.label === node.label);
      if (cat) cat.collapsed = !cat.collapsed;
      return { type: "none" };
    }

    if (node.kind === "setting") {
      const setting = node.setting;

      if (setting.type === "boolean" && setting.onToggle) {
        setting.onToggle();
        return { type: "none" };
      }

      if (setting.type === "text" && setting.onTextCommit) {
        const current = setting.getValue();
        this.editState = { mode: "text", settingId: setting.id, buffer: current, cursorPos: current.length };
        return { type: "none" };
      }

      if (setting.type === "list" && setting.options && setting.onOptionSelect) {
        const current = setting.getValue();
        const idx = setting.options.indexOf(current);
        this.editState = {
          mode: "list",
          settingId: setting.id,
          optionIndex: idx >= 0 ? idx : 0,
          options: setting.options,
        };
        return { type: "none" };
      }

      if (setting.type === "map") {
        if (this.expandedMaps.has(setting.id)) {
          this.expandedMaps.delete(setting.id);
        } else {
          this.expandedMaps.add(setting.id);
        }
        return { type: "none" };
      }
    }

    if (node.kind === "map-add") {
      return { type: "map-add", settingId: node.parentId };
    }

    if (node.kind === "map-entry") {
      return { type: "map-edit", settingId: node.parentId, key: node.key };
    }

    return { type: "none" };
  }

  private moveUp(): void {
    if (this.selectedIndex > 0) this.selectedIndex--;
    this.ensureVisible();
  }

  private moveDown(): void {
    const nodes = this.buildNodes();
    if (this.selectedIndex < nodes.length - 1) this.selectedIndex++;
    this.ensureVisible();
  }

  private getSelectedNode(): SettingsNode | null {
    const nodes = this.buildNodes();
    return nodes[this.selectedIndex] ?? null;
  }

  private getSelectedMapEntry(): boolean {
    const node = this.getSelectedNode();
    return node?.kind === "map-entry";
  }

  private findSetting(id: string): SettingDef | null {
    for (const cat of this.categories) {
      for (const s of cat.settings) {
        if (s.id === id) return s;
      }
    }
    return null;
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
      if (cat.collapsed) continue;
      for (const setting of cat.settings) {
        nodes.push({ kind: "setting", setting });
        // Expanded map entries
        if (setting.type === "map" && this.expandedMaps.has(setting.id) && setting.getMapEntries) {
          for (const entry of setting.getMapEntries()) {
            nodes.push({ kind: "map-entry", parentId: setting.id, key: entry.key, value: entry.value });
          }
          nodes.push({ kind: "map-add", parentId: setting.id });
        }
      }
    }
    return nodes;
  }

  private ensureVisible(): void {
    const visibleCount = this.lastRenderRows - 3;
    const relativeIdx = this.selectedIndex - this.scrollOffset;
    if (relativeIdx < 0) {
      this.scrollOffset = this.selectedIndex;
    } else if (relativeIdx >= visibleCount) {
      this.scrollOffset = this.selectedIndex - visibleCount + 1;
    }
  }
}
