import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import { theme, neutralFg } from "./theme";
import { tokens, space, frame } from "./chrome-tokens";

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
  getMapKeyOptions?: () => Array<{ id: string; label: string }>;   // available keys to add (e.g., Linear teams)
  getMapValueOptions?: () => Array<{ id: string; label: string }>; // available values (e.g., project dirs)
  onMapSave?: (key: string, value: string) => void;
  onMapRemove?: (key: string) => void;
}

export interface SettingsCategory {
  label: string;
  collapsed: boolean;
  settings: SettingDef[];
}

// --- Rendering constants ---

// The single jmux accent (see chrome-tokens.ts) marks focus: the title, the
// active category/label, the row cursor and edit caret. The attr objects
// below are re-themed in place by rebuildSettingsColors(): every ACCENT-role
// object is re-patched from tokens.accent, HAIRLINE_ROLE from
// tokens.ruleHairline, every neutral-text object from the terminal default
// fg once a theme is detected, and the edit-field surfaces track
// theme.hover / theme.selected. They start on the dark defaults.

const HEADER_ATTRS: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bold: true };
const CATEGORY_ATTRS: CellAttrs = { fg: tokens.textSecondary.fg, fgMode: tokens.textSecondary.fgMode };
const CATEGORY_ACTIVE: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bold: true };
const HAIRLINE_ATTRS: CellAttrs = { fg: tokens.ruleHairline.fg, fgMode: tokens.ruleHairline.fgMode, dim: tokens.ruleHairline.dim };
const LABEL_ATTRS: CellAttrs = { fg: 7, fgMode: ColorMode.Palette };
const LABEL_ACTIVE: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bold: true };
const VALUE_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
const VALUE_ACTIVE: CellAttrs = { fg: 7, fgMode: ColorMode.Palette };
const DIM_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const HINT_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const HINT_KEY_ATTRS: CellAttrs = { fg: tokens.accentMuted.fg, fgMode: tokens.accentMuted.fgMode };
const HINT_LABEL_ATTRS: CellAttrs = { fg: tokens.textSecondary.fg, fgMode: tokens.textSecondary.fgMode };
const HINT_SEP_ATTRS: CellAttrs = { fg: tokens.ruleHairline.fg, fgMode: tokens.ruleHairline.fgMode, dim: tokens.ruleHairline.dim };
const CURSOR_ATTRS: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode };
const EDIT_BG: CellAttrs = { bg: theme.hover, bgMode: ColorMode.RGB };
const EDIT_TEXT: CellAttrs = { fg: 7, fgMode: ColorMode.Palette, bg: theme.hover, bgMode: ColorMode.RGB };
const EDIT_CURSOR: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode, bg: theme.selected, bgMode: ColorMode.RGB };
const MAP_KEY_ATTRS: CellAttrs = { fg: 5, fgMode: ColorMode.Palette };
const MAP_VAL_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
const MAP_KEY_ACTIVE: CellAttrs = { fg: tokens.accent.fg, fgMode: tokens.accent.fgMode };
const MAP_ADD_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const ON_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const OFF_ATTRS: CellAttrs = { fg: 1, fgMode: ColorMode.Palette };

// Objects whose foreground tracks the accent / neutral-text / hairline tokens — patched by role.
const ACCENT_ROLE: CellAttrs[] = [HEADER_ATTRS, CATEGORY_ACTIVE, LABEL_ACTIVE, CURSOR_ATTRS, EDIT_CURSOR, MAP_KEY_ACTIVE];
const NEUTRAL_ROLE: CellAttrs[] = [LABEL_ATTRS, VALUE_ACTIVE, EDIT_TEXT];
const TEXT_SECONDARY_ROLE: CellAttrs[] = [CATEGORY_ATTRS, HINT_LABEL_ATTRS];
const HAIRLINE_ROLE: CellAttrs[] = [HAIRLINE_ATTRS, HINT_SEP_ATTRS];

export function rebuildSettingsColors(): void {
  for (const a of ACCENT_ROLE) { a.fg = tokens.accent.fg; a.fgMode = tokens.accent.fgMode; }
  for (const a of TEXT_SECONDARY_ROLE) { a.fg = tokens.textSecondary.fg; a.fgMode = tokens.textSecondary.fgMode; }
  for (const a of HAIRLINE_ROLE) { a.fg = tokens.ruleHairline.fg; a.fgMode = tokens.ruleHairline.fgMode; a.dim = tokens.ruleHairline.dim; }
  HINT_KEY_ATTRS.fg = tokens.accentMuted.fg;
  HINT_KEY_ATTRS.fgMode = tokens.accentMuted.fgMode;
  const n = neutralFg(7);
  for (const a of NEUTRAL_ROLE) { a.fg = n.fg; a.fgMode = n.fgMode; }
  EDIT_BG.bg = theme.hover;
  EDIT_TEXT.bg = theme.hover;
  EDIT_CURSOR.bg = theme.selected;
}
rebuildSettingsColors();

// --- Node model ---

type SettingsNode =
  | { kind: "category"; label: string; collapsed: boolean; count: number }
  | { kind: "setting"; setting: SettingDef }
  | { kind: "map-entry"; parentId: string; key: string; value: string }
  | { kind: "map-add"; parentId: string };

type PickerItem = { id: string; label: string };

type EditState =
  | null
  | { mode: "text"; settingId: string; buffer: string; cursorPos: number }
  | { mode: "list"; settingId: string; optionIndex: number; options: string[] }
  | { mode: "picker"; settingId: string; title: string; items: PickerItem[]; filtered: PickerItem[]; selectedIndex: number; filter: string; onSelect: (item: PickerItem) => void };

export type SettingsAction =
  | { type: "none" }
  | { type: "map-add"; settingId: string }
  | { type: "map-edit"; settingId: string; key: string };

// --- Visual-row plan ---
//
// `buildNodes()` produces the list of *setting indices* — the only things
// `selectedIndex`/navigation ever address. `buildRowPlan()` wraps that list
// into the *rendered rows*: it inserts a blank spacer row before every
// category header except the first, purely for visual breathing room
// between sections. Blank rows carry no nodeIndex, so they can never be
// the render-time target of `isSelected`, and moveUp()/moveDown() never
// touch the row plan at all — they walk `nodes` directly, so the cursor
// can only ever land on a real node. The row plan's only jobs are (a)
// deciding what appears on which screen row and (b) letting scrolling
// account for the extra blank rows consuming vertical space.
type RenderRow =
  | { kind: "blank" }
  | { kind: "node"; nodeIndex: number; node: SettingsNode };

// Row 0 is the "Settings" title, row 1 is a blank breathing row; content
// starts at row 2. Shared between render() and ensureVisible() so the two
// can't drift apart.
const CONTENT_START_ROW = 2;

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

    // Picker mode gets a dedicated render
    if (this.editState?.mode === "picker") {
      return this.renderPicker(cols, rows, this.editState);
    }

    const grid = createGrid(cols, rows);

    // Content is capped at space.measure and centred within the render
    // area (which is already the main rect, excluding the sidebar) rather
    // than laid out edge-to-edge — the dot leaders used to fill the whole
    // terminal width, so the layout got worse the wider the terminal.
    // measureWidth is clamped to `cols` so `right` never lands past the
    // grid edge: below the measure, content uses the full available width
    // (left = 0); at/above it, content is capped at the measure and
    // centred with symmetric margins.
    const measureWidth = Math.min(cols, space.measure);
    const left = cols > space.measure ? Math.floor((cols - space.measure) / 2) : 0;
    const right = left + measureWidth;

    const nodes = this.buildNodes();
    const rowPlan = this.buildRowPlan(nodes);

    // Header
    writeString(grid, 0, left, "Settings", HEADER_ATTRS);

    // The hint line is its own bottom row — settings is a frameless
    // full-screen takeover (no shared footer), so it keeps one hint line
    // of its own, reserved at the bottom of the content band.
    const hintRow = rows - 1;

    for (let r = 0; r < rowPlan.length; r++) {
      const row = CONTENT_START_ROW + r - this.scrollOffset;
      if (row < CONTENT_START_ROW || row >= hintRow) continue;

      const entry = rowPlan[r];
      if (entry.kind === "blank") continue;

      const node = entry.node;
      const isSelected = entry.nodeIndex === this.selectedIndex;

      if (node.kind === "category") {
        this.renderCategory(grid, row, left, right, node, isSelected);
      } else if (node.kind === "setting") {
        this.renderSetting(grid, row, left, right, node.setting, isSelected);
      } else if (node.kind === "map-entry") {
        this.renderMapEntry(grid, row, left, right, node, isSelected);
      } else if (node.kind === "map-add") {
        const indent = left + 4;
        writeString(grid, row, indent, "+ Add mapping", isSelected ? MAP_KEY_ACTIVE : MAP_ADD_ATTRS);
        if (isSelected) writeString(grid, row, indent - 2, "▸", CURSOR_ATTRS);
      }
    }

    this.renderHint(grid, hintRow, left);

    return grid;
  }

  private renderHint(grid: CellGrid, row: number, left: number): void {
    const groups: Array<{ key: string; label: string }> = this.editState
      ? [{ key: "↵", label: "confirm" }, { key: "esc", label: "cancel" }]
      : [{ key: "↵", label: "edit" }, { key: "esc", label: "close" }, { key: "↑↓", label: "navigate" }];

    let col = left;
    groups.forEach((group, i) => {
      if (i > 0) {
        writeString(grid, row, col, "  ", HINT_SEP_ATTRS);
        col += 2;
        writeString(grid, row, col, "·", HINT_SEP_ATTRS);
        col += 1;
        writeString(grid, row, col, "  ", HINT_SEP_ATTRS);
        col += 2;
      }
      writeString(grid, row, col, group.key, HINT_KEY_ATTRS);
      col += group.key.length;
      writeString(grid, row, col, " " + group.label, HINT_LABEL_ATTRS);
      col += group.label.length + 1;
    });
  }

  // --- Private: visual-row plan ---

  private buildRowPlan(nodes: SettingsNode[]): RenderRow[] {
    const plan: RenderRow[] = [];
    nodes.forEach((node, nodeIndex) => {
      if (node.kind === "category" && plan.length > 0) {
        plan.push({ kind: "blank" });
      }
      plan.push({ kind: "node", nodeIndex, node });
    });
    return plan;
  }

  // --- Private: rendering helpers ---

  // Section header as a "label ────" hairline (replacing the old
  // "▸/▸ label (count)" chevron form): the label, a space, then a
  // ruleHairline-toned fill of frame.ruleLight to the right edge of the
  // measure. Collapse still toggles via Enter (handleEnter()) and still
  // hides the category's settings (buildNodes()) — only the *display* of
  // collapse changed, from a count on every header to "n hidden" shown
  // only when collapsed.
  private renderCategory(grid: CellGrid, row: number, left: number, right: number, node: Extract<SettingsNode, { kind: "category" }>, selected: boolean): void {
    const label = node.label;
    writeString(grid, row, left, label, selected ? CATEGORY_ACTIVE : CATEGORY_ATTRS);
    if (selected) writeString(grid, row, left - 1, "▸", CURSOR_ATTRS);

    const hiddenLabel = node.collapsed ? `${node.count} hidden` : "";
    const hairlineStart = left + label.length + 1;
    const hairlineEnd = hiddenLabel ? right - hiddenLabel.length - 1 : right;
    const fillLen = Math.max(0, hairlineEnd - hairlineStart);
    if (fillLen > 0) {
      writeString(grid, row, hairlineStart, frame.ruleLight.repeat(fillLen), HAIRLINE_ATTRS);
    }
    if (hiddenLabel && right - hiddenLabel.length >= hairlineStart) {
      writeString(grid, row, right - hiddenLabel.length, hiddenLabel, CATEGORY_ATTRS);
    }
  }

  private renderSetting(grid: CellGrid, row: number, left: number, right: number, setting: SettingDef, selected: boolean): void {
    const indent = left + 2;

    // Check if this setting is being edited
    if (this.editState?.settingId === setting.id) {
      if (this.editState.mode === "text") {
        this.renderTextEdit(grid, row, left, right, setting, this.editState);
        return;
      }
      if (this.editState.mode === "list") {
        this.renderListEdit(grid, row, left, setting, this.editState);
        return;
      }
    }

    const maxLabelLen = Math.max(1, Math.floor((right - indent - 2) * 0.5));
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

    // Dot leader computed within the measure: label, leader, value — the
    // leader fills exactly the space between them (measureWidth - label -
    // value - the flanking padding), never past `right`.
    const valueCol = right - valueStr.length;
    const labelEnd = indent + displayLabel.length;
    if (valueCol > labelEnd + 1) {
      if (!isMap) {
        const leaderStart = labelEnd + 1;
        const leaderEnd = valueCol - 1;
        const maxDots = leaderEnd - leaderStart - 1; // reserve one flanking space each side
        if (maxDots >= 2) {
          const dots = " " + "·".repeat(maxDots) + " ";
          writeString(grid, row, leaderStart, dots, HAIRLINE_ATTRS);
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

  private renderTextEdit(grid: CellGrid, row: number, left: number, right: number, setting: SettingDef, state: Extract<EditState, { mode: "text" }>): void {
    const indent = left + 2;
    writeString(grid, row, indent, setting.label + ": ", LABEL_ACTIVE);
    const fieldStart = indent + setting.label.length + 2;
    const fieldWidth = Math.max(0, right - fieldStart);

    // Background for edit field
    const bg = " ".repeat(fieldWidth);
    writeString(grid, row, fieldStart, bg, EDIT_BG);

    // Buffer text — when overflowing, show a window around the cursor
    const sliceOffset = state.buffer.length > fieldWidth - 1
      ? Math.max(0, Math.min(state.cursorPos - Math.floor(fieldWidth / 2), state.buffer.length - fieldWidth + 1))
      : 0;
    const displayBuf = state.buffer.slice(sliceOffset, sliceOffset + fieldWidth - 1);
    writeString(grid, row, fieldStart, displayBuf, EDIT_TEXT);

    // Cursor
    const cursorCol = fieldStart + state.cursorPos - sliceOffset;
    const cursorChar = state.cursorPos < state.buffer.length ? state.buffer[state.cursorPos] : " ";
    writeString(grid, row, cursorCol, cursorChar, EDIT_CURSOR);
  }

  private renderListEdit(grid: CellGrid, row: number, left: number, setting: SettingDef, state: Extract<EditState, { mode: "list" }>): void {
    const indent = left + 2;
    writeString(grid, row, indent, setting.label + ": ", LABEL_ACTIVE);
    const fieldStart = indent + setting.label.length + 2;

    // Show current option with arrows
    const option = state.options[state.optionIndex];
    writeString(grid, row, fieldStart, `◂ ${option} ▸`, CURSOR_ATTRS);
  }

  private renderMapEntry(grid: CellGrid, row: number, left: number, right: number, node: Extract<SettingsNode, { kind: "map-entry" }>, selected: boolean): void {
    const indent = left + 4;
    const keyStr = node.key;
    const valStr = node.value.length > 30 ? node.value.slice(0, 29) + "\u2026" : node.value;

    writeString(grid, row, indent, keyStr, selected ? MAP_KEY_ACTIVE : MAP_KEY_ATTRS);
    writeString(grid, row, indent + keyStr.length, " → ", DIM_ATTRS);
    writeString(grid, row, indent + keyStr.length + 3, valStr, selected ? VALUE_ACTIVE : MAP_VAL_ATTRS);

    if (selected) {
      writeString(grid, row, indent - 2, "▸", CURSOR_ATTRS);
      // Hint for delete
      const hintCol = right - 10;
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

    if (this.editState.mode === "picker") {
      const state = this.editState;
      if (data === "\x1b") {
        this.editState = null;
        return { type: "none" };
      }
      if (data === "\x1b[A") { // Up
        if (state.selectedIndex > 0) state.selectedIndex--;
        return { type: "none" };
      }
      if (data === "\x1b[B") { // Down
        if (state.selectedIndex < state.filtered.length - 1) state.selectedIndex++;
        return { type: "none" };
      }
      if (data === "\r") {
        const item = state.filtered[state.selectedIndex];
        if (item) state.onSelect(item);
        return { type: "none" };
      }
      if (data === "\x7f" || data === "\b") {
        if (state.filter.length > 0) {
          state.filter = state.filter.slice(0, -1);
          this.applyPickerFilter(state);
        }
        return { type: "none" };
      }
      // Printable character — filter
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        state.filter += data;
        this.applyPickerFilter(state);
        return { type: "none" };
      }
      return { type: "none" };
    }

    return { type: "none" };
  }

  private applyPickerFilter(state: Extract<EditState, { mode: "picker" }>): void {
    const q = state.filter.toLowerCase();
    state.filtered = q
      ? state.items.filter((i) => i.label.toLowerCase().includes(q))
      : state.items;
    state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.filtered.length - 1));
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
      const setting = this.findSetting(node.parentId);
      if (setting?.getMapKeyOptions && setting?.getMapValueOptions && setting?.onMapSave) {
        const keyOptions = setting.getMapKeyOptions();
        if (keyOptions.length > 0) {
          const valOpts = setting.getMapValueOptions();
          const saveFn = setting.onMapSave;
          this.editState = {
            mode: "picker",
            settingId: node.parentId,
            title: "Select team",
            items: keyOptions,
            filtered: keyOptions,
            selectedIndex: 0,
            filter: "",
            onSelect: (keyItem) => {
              // After picking a key, open a second picker for value
              this.editState = {
                mode: "picker",
                settingId: node.parentId,
                title: `Repository for ${keyItem.label}`,
                items: valOpts,
                filtered: valOpts,
                selectedIndex: 0,
                filter: "",
                onSelect: (valItem) => {
                  saveFn(keyItem.id, valItem.id);
                  this.editState = null;
                },
              };
            },
          };
        }
      }
      return { type: "none" };
    }

    if (node.kind === "map-entry") {
      const setting = this.findSetting(node.parentId);
      if (setting?.getMapValueOptions && setting?.onMapSave) {
        const valOpts = setting.getMapValueOptions();
        const saveFn = setting.onMapSave;
        this.editState = {
          mode: "picker",
          settingId: node.parentId,
          title: `Repository for ${node.key}`,
          items: valOpts,
          filtered: valOpts,
          selectedIndex: 0,
          filter: "",
          onSelect: (valItem) => {
            saveFn(node.key, valItem.id);
            this.editState = null;
          },
        };
      }
      return { type: "none" };
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

  private renderPicker(cols: number, rows: number, state: Extract<EditState, { mode: "picker" }>): CellGrid {
    const grid = createGrid(cols, rows);
    const pad = 2;

    // Title
    writeString(grid, 0, pad, state.title, HEADER_ATTRS);

    // Filter input
    const filterLabel = "Filter: ";
    writeString(grid, 1, pad, filterLabel, HINT_ATTRS);
    const filterStart = pad + filterLabel.length;
    const filterWidth = cols - filterStart - pad;
    const filterBg = " ".repeat(filterWidth);
    writeString(grid, 1, filterStart, filterBg, EDIT_BG);
    writeString(grid, 1, filterStart, state.filter, EDIT_TEXT);
    const filterCursorCol = filterStart + state.filter.length;
    if (filterCursorCol < cols - pad) {
      writeString(grid, 1, filterCursorCol, " ", EDIT_CURSOR);
    }

    // Items
    const startRow = 3;
    const maxVisible = rows - startRow;
    let scrollOff = 0;
    if (state.selectedIndex >= maxVisible) {
      scrollOff = state.selectedIndex - maxVisible + 1;
    }

    for (let i = 0; i < state.filtered.length; i++) {
      const row = startRow + i - scrollOff;
      if (row < startRow || row >= rows) continue;
      const item = state.filtered[i];
      const isSelected = i === state.selectedIndex;

      if (isSelected) {
        writeString(grid, row, pad, "▸", CURSOR_ATTRS);
      }
      writeString(grid, row, pad + 2, item.label, isSelected ? LABEL_ACTIVE : LABEL_ATTRS);
    }

    if (state.filtered.length === 0) {
      writeString(grid, startRow, pad + 2, "No matches", DIM_ATTRS);
    }

    // Hint
    const hintRow = rows - 1;
    writeString(grid, hintRow, pad, "↑↓ select  ·  Enter confirm  ·  Esc cancel  ·  type to filter", HINT_ATTRS);

    return grid;
  }

  // scrollOffset is measured in row-plan positions (rowPlan indices), not
  // node indices, since the plan's blank spacer rows consume screen space
  // too. Convert the selected node index to its row-plan position before
  // clamping — this keeps the selected setting on-screen without ever
  // being able to land scroll on a blank row itself (selectedIndex only
  // ever addresses "node" entries).
  private ensureVisible(): void {
    const rowPlan = this.buildRowPlan(this.buildNodes());
    const rowPos = rowPlan.findIndex((r) => r.kind === "node" && r.nodeIndex === this.selectedIndex);
    if (rowPos < 0) return;

    // Reserve CONTENT_START_ROW rows above the content and 1 row for the
    // hint line at the bottom.
    const visibleCount = Math.max(1, this.lastRenderRows - CONTENT_START_ROW - 1);
    const relativeIdx = rowPos - this.scrollOffset;
    if (relativeIdx < 0) {
      this.scrollOffset = rowPos;
    } else if (relativeIdx >= visibleCount) {
      this.scrollOffset = rowPos - visibleCount + 1;
    }
  }
}
