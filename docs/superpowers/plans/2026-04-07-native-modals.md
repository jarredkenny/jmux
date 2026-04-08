# Native Modals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all tmux popup modals (fzf shell scripts) with native jmux modals drawn by the renderer, consistent with the command palette.

**Architecture:** Define a `Modal` interface that CommandPalette and new modal classes (InputModal, ListModal, ContentModal, NewSessionModal) all satisfy. main.ts manages a single `activeModal` slot with a result callback. The renderer's existing overlay mechanism renders any modal's CellGrid — no compositor changes needed.

**Tech Stack:** TypeScript, Bun test framework, `@xterm/headless`, existing cell-grid/renderer primitives.

**Spec:** `docs/superpowers/specs/2026-04-06-native-modals-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/modal.ts` | Modal interface, ModalAction type, shared color constants + attribute sets |
| `src/input-modal.ts` | InputModal — text input with header, subheader, pre-fill |
| `src/list-modal.ts` | ListModal — fuzzy-filterable list picker |
| `src/content-modal.ts` | ContentModal — scrollable styled text viewer |
| `src/new-session-modal.ts` | NewSessionModal — multi-step wizard composing ListModal + InputModal |
| `src/__tests__/input-modal.test.ts` | InputModal tests |
| `src/__tests__/list-modal.test.ts` | ListModal tests |
| `src/__tests__/content-modal.test.ts` | ContentModal tests |
| `src/__tests__/new-session-modal.test.ts` | NewSessionModal tests |

### Modified Files

| File | Changes |
|---|---|
| `src/renderer.ts` | Rename `paletteOverlay` → `modalOverlay`, `paletteCursor` → `modalCursor`, `getPalettePosition` → `getModalPosition` |
| `src/command-palette.ts` | Add `getCursorPosition()`, `preferredWidth()`. Change action `"execute"` → `"result"`. Import constants from `modal.ts`. |
| `src/types.ts` | Change `PaletteAction` `"execute"` → `"result"` with `value` field |
| `src/input-router.ts` | Rename `paletteOpen` → `modalOpen`, `setPaletteOpen` → `setModalOpen`, `onPaletteInput` → `onModalInput`, `onPaletteToggle` → `onModalToggle` |
| `src/main.ts` | Replace palette wiring with `activeModal` slot + `openModal`/`closeModal`. Wire all modal commands. Add data providers. Add dynamic window commands. Remove `spawnTmuxPopup`. |
| `src/__tests__/renderer.test.ts` | Update `getPalettePosition` → `getModalPosition` references |
| `src/__tests__/command-palette.test.ts` | Update `"execute"` → `"result"` in any assertions |

### Deleted Files

| File | Replaced by |
|---|---|
| `config/rename-session.sh` | InputModal |
| `config/rename-window.sh` | InputModal |
| `config/new-session.sh` | NewSessionModal |
| `config/move-window.sh` | ListModal |
| `config/settings.sh` | Palette sublists + InputModal |
| `config/release-notes.sh` | ContentModal |
| `config/welcome.sh` | ContentModal |

---

### Task 1: Foundation — modal.ts, renderer renames

**Files:**
- Create: `src/modal.ts`
- Modify: `src/renderer.ts`
- Modify: `src/__tests__/renderer.test.ts`

- [ ] **Step 1: Create `src/modal.ts` with interface and shared constants**

```typescript
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import type { CellAttrs } from "./cell-grid";

// --- Modal interface ---

export type ModalAction =
  | { type: "consumed" }
  | { type: "closed" }
  | { type: "result"; value: unknown };

export interface Modal {
  isOpen(): boolean;
  preferredWidth(termCols: number): number;
  getGrid(width: number): CellGrid;
  getCursorPosition(): { row: number; col: number } | null;
  handleInput(data: string): ModalAction;
  close(): void;
}

// --- Shared color constants ---

export const MODAL_BG = (0x16 << 16) | (0x1b << 8) | 0x22; // #161b22
export const SELECTED_BG = (0x1e << 16) | (0x2a << 8) | 0x35; // #1e2a35

export const HEADER_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SUBHEADER_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const PROMPT_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const INPUT_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const RESULT_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SELECTED_RESULT_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

export const MATCH_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SELECTED_MATCH_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

export const CATEGORY_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SELECTED_CATEGORY_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

export const CURRENT_TAG_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SELECTED_CURRENT_TAG_ATTRS: CellAttrs = {
  fg: 3,
  fgMode: ColorMode.Palette,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

export const MODAL_BORDER_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const BREADCRUMB_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const NO_MATCHES_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const DIM_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const BG_ATTRS: CellAttrs = {
  bg: MODAL_BG,
  bgMode: ColorMode.RGB,
};

export const SELECTED_BG_ATTRS: CellAttrs = {
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};
```

- [ ] **Step 2: Rename renderer exports and parameters**

In `src/renderer.ts`:

Rename the exported function `getPalettePosition` → `getModalPosition` (rename only, no logic change):

```typescript
// Line 130: rename function
export function getModalPosition(
  totalGridCols: number, totalGridRows: number,
  modalWidth: number, modalHeight: number,
): { startCol: number; startRow: number } {
  const totalW = modalWidth + 3;
  const totalH = modalHeight + 3;
  return {
    startCol: Math.max(2, Math.floor((totalGridCols - totalW) / 2) + 1),
    startRow: Math.max(2, Math.floor((totalGridRows - totalH) / 3) + 1),
  };
}
```

Rename `compositeGrids` parameter `paletteOverlay` → `modalOverlay`:

```typescript
// Line 142: rename parameter
export function compositeGrids(
  main: CellGrid,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  modalOverlay?: CellGrid | null,
): CellGrid {
```

Update all references to `paletteOverlay` inside `compositeGrids` to `modalOverlay` (appears at lines 268, 269, 284-285, 301, 305, 308).

Rename `Renderer.render()` parameters `paletteOverlay` → `modalOverlay`, `paletteCursor` → `modalCursor`:

```typescript
// Line 363: rename parameters
render(
  main: CellGrid,
  cursor: CursorPosition,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  modalOverlay?: CellGrid | null,
  modalCursor?: { row: number; col: number } | null,
): void {
```

Update the reference to `paletteCursor` inside `render()` (line 399) to `modalCursor`:

```typescript
if (modalCursor != null) {
  buf.push(`\x1b[${modalCursor.row + 1};${modalCursor.col + 1}H`);
```

- [ ] **Step 3: Update renderer test imports**

In `src/__tests__/renderer.test.ts`, update the import on line 2:

```typescript
import { sgrForCell, compositeGrids, getModalPosition, BORDER_CHAR } from "../renderer";
```

Replace all occurrences of `getPalettePosition` with `getModalPosition` in the test file (appears in test names and function calls around lines 114-132, 155, 200).

- [ ] **Step 4: Update main.ts renderer references**

In `src/main.ts`:

Update the import (line 4):
```typescript
import { Renderer, getToolbarButtonRanges, getToolbarTabRanges, getModalPosition, type ToolbarConfig } from "./renderer";
```

Update `renderFrame()` (line ~413):
```typescript
const pos = getModalPosition(termCols, termRows, paletteWidth, paletteGrid.rows);
```

Note: the local variable names `paletteGrid`/`paletteCursor`/`paletteWidth` in `renderFrame()` stay for now — they'll be replaced in Task 3 when we refactor to `activeModal`.

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: All 164 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/modal.ts src/renderer.ts src/__tests__/renderer.test.ts src/main.ts
git commit -m "refactor: add Modal interface and rename palette→modal in renderer"
```

---

### Task 2: Adapt CommandPalette to Modal interface

**Files:**
- Modify: `src/types.ts`
- Modify: `src/command-palette.ts`
- Modify: `src/main.ts`
- Modify: `src/__tests__/command-palette.test.ts` (if any assertions reference `"execute"`)

- [ ] **Step 1: Update PaletteAction in types.ts**

In `src/types.ts`, change the `PaletteAction` type (lines 70-73):

```typescript
export type PaletteAction =
  | { type: "consumed" }
  | { type: "closed" }
  | { type: "result"; value: PaletteResult };
```

- [ ] **Step 2: Update CommandPalette to use new action type and import constants from modal.ts**

In `src/command-palette.ts`:

Replace the local constant definitions (lines 7-92) with imports from modal.ts:

```typescript
import {
  MODAL_BG, SELECTED_BG,
  PROMPT_ATTRS, INPUT_ATTRS, RESULT_ATTRS, SELECTED_RESULT_ATTRS,
  MATCH_ATTRS, SELECTED_MATCH_ATTRS, CATEGORY_ATTRS, SELECTED_CATEGORY_ATTRS,
  CURRENT_TAG_ATTRS, SELECTED_CURRENT_TAG_ATTRS, MODAL_BORDER_ATTRS,
  BREADCRUMB_ATTRS, NO_MATCHES_ATTRS, BG_ATTRS, SELECTED_BG_ATTRS,
} from "./modal";
```

In the `getGrid` method, update attribute references:
- `QUERY_ATTRS` → `INPUT_ATTRS` (same values)
- `BORDER_ATTRS` → `MODAL_BORDER_ATTRS`
- The `bgAttrs` local that used `{ bg: PALETTE_BG, bgMode: ColorMode.RGB }` → use `BG_ATTRS`
- Selected background fills that used `{ bg: SELECTED_BG, bgMode: ColorMode.RGB }` → use `SELECTED_BG_ATTRS`

Change the two `"execute"` returns in `handleInput()`:

Line ~254 (sublist result):
```typescript
return {
  type: "result",
  value: {
    commandId: this.sublistParent.id,
    sublistOptionId: selected.command.id,
  },
};
```

Line ~275 (regular command):
```typescript
return {
  type: "result",
  value: { commandId: selected.command.id },
};
```

Add `getCursorPosition()` and `preferredWidth()` methods to the `CommandPalette` class:

```typescript
getCursorPosition(): { row: number; col: number } | null {
  return { row: 0, col: this.getCursorCol() };
}

preferredWidth(termCols: number): number {
  return Math.min(Math.max(40, Math.round(termCols * 0.55)), 80);
}
```

- [ ] **Step 3: Update main.ts to use new action type**

In `src/main.ts`, in the `onPaletteInput` callback (line ~546-557), change `"execute"` to `"result"`:

```typescript
onPaletteInput: (data) => {
  if (!palette.isOpen()) return;
  const action = palette.handleInput(data);
  switch (action.type) {
    case "consumed":
      scheduleRender();
      break;
    case "closed":
      closePalette();
      break;
    case "result":
      closePalette();
      handlePaletteAction(action.value);
      break;
  }
},
```

- [ ] **Step 4: Update command-palette tests if needed**

In `src/__tests__/command-palette.test.ts`, search for any assertions that reference `"execute"` and change to `"result"`. Also update any references to `action.result` → `action.value`.

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/command-palette.ts src/main.ts src/__tests__/command-palette.test.ts
git commit -m "refactor: adapt CommandPalette to Modal interface"
```

---

### Task 3: Refactor main.ts and input-router for generic modal management

**Files:**
- Modify: `src/input-router.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Rename palette references in input-router.ts**

In `src/input-router.ts`:

Rename the field (line 48):
```typescript
private modalOpen = false;
```

Rename the method (lines 60-62):
```typescript
setModalOpen(open: boolean): void {
  this.modalOpen = open;
}
```

Update references to `this.paletteOpen` → `this.modalOpen` (lines ~130, ~154).

Rename callback types in the opts interface — `onPaletteInput` → `onModalInput`, `onPaletteToggle` → `onModalToggle`. Update all internal references.

- [ ] **Step 2: Refactor main.ts — add openModal/closeModal, refactor renderFrame**

In `src/main.ts`:

Add import of `Modal` type:
```typescript
import type { Modal } from "./modal";
```

Replace the palette-specific state and helpers with generic modal management. After the existing `const palette = new CommandPalette();` (line ~565), add:

```typescript
let activeModal: Modal | null = null;
let onModalResult: ((value: unknown) => void) | null = null;

function openModal(modal: Modal, onResult: (value: unknown) => void): void {
  activeModal = modal;
  onModalResult = onResult;
  inputRouter.setModalOpen(true);
  renderFrame();
}

function closeModal(): void {
  activeModal?.close();
  activeModal = null;
  onModalResult = null;
  inputRouter.setModalOpen(false);
  renderFrame();
}
```

Replace `togglePalette`, `openPalette`, `closePalette`:

```typescript
function togglePalette(): void {
  if (activeModal) {
    closeModal();
  } else {
    openPalette();
  }
}

function openPalette(): void {
  const commands = buildPaletteCommands();
  palette.open(commands);
  openModal(palette, (value) => {
    handlePaletteAction(value as PaletteResult);
  });
}
```

Remove the old `closePalette()` function — `closeModal()` replaces it. Search for all calls to `closePalette()` and replace with `closeModal()`.

- [ ] **Step 3: Refactor renderFrame to use activeModal**

Replace the palette-specific logic in `renderFrame()`:

```typescript
function renderFrame(): void {
  if (writesPending > 0) return;
  const grid = bridge.getGrid();
  const cursor = bridge.getCursor();
  const tb = toolbarEnabled ? makeToolbar() : null;
  let modalGrid: import("./types").CellGrid | null = null;
  let modalCursorPos: { row: number; col: number } | null = null;
  if (activeModal?.isOpen()) {
    const termCols = process.stdout.columns || 80;
    const termRows = process.stdout.rows || 24;
    const modalWidth = activeModal.preferredWidth(termCols);
    modalGrid = activeModal.getGrid(modalWidth);
    const pos = getModalPosition(termCols, termRows, modalWidth, modalGrid.rows);
    const cursorPos = activeModal.getCursorPosition();
    if (cursorPos) {
      modalCursorPos = { row: pos.startRow + cursorPos.row, col: pos.startCol + cursorPos.col };
    }
  }
  renderer.render(
    grid, cursor,
    sidebarShown ? sidebar.getGrid() : null,
    tb,
    modalGrid,
    modalCursorPos,
  );
}
```

- [ ] **Step 4: Update onModalInput callback**

In the InputRouter construction, update the callback to use generic modal handling:

```typescript
onModalToggle: () => togglePalette(),
onModalInput: (data) => {
  if (!activeModal?.isOpen()) return;
  const action = activeModal.handleInput(data);
  switch (action.type) {
    case "consumed":
      scheduleRender();
      break;
    case "closed":
      closeModal();
      break;
    case "result":
      const handler = onModalResult;
      closeModal();
      handler?.(action.value);
      break;
  }
},
```

- [ ] **Step 5: Update resize handler**

In the SIGWINCH handler (line ~873), replace `palette.isOpen()` check:

```typescript
if (activeModal) {
  closeModal();
}
```

- [ ] **Step 6: Add dynamic window commands to buildPaletteCommands**

In `buildPaletteCommands()` (around line ~588), add dynamic window commands after the session commands:

```typescript
// Dynamic: switch to window (current session, excluding active)
for (const tab of currentWindows) {
  if (tab.active) continue;
  commands.push({
    id: `switch-window:${tab.windowId}`,
    label: `Window ${tab.index}: ${tab.name}`,
    category: "window",
  });
}
```

In `handlePaletteAction()`, the existing `switch-window:` handler (lines ~688-691) already handles this:
```typescript
if (commandId.startsWith("switch-window:")) {
  const windowId = commandId.slice("switch-window:".length);
  await handleTabClick(windowId);
  return;
}
```

Remove the `"window-picker"` entry from the static commands list (line ~623) and its case in the switch statement (lines ~751-753).

- [ ] **Step 7: Run tests**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/input-router.ts src/main.ts
git commit -m "refactor: replace palette-specific wiring with generic activeModal slot"
```

---

### Task 4: InputModal — TDD + wire rename commands

**Files:**
- Create: `src/input-modal.ts`
- Create: `src/__tests__/input-modal.test.ts`
- Modify: `src/main.ts`
- Delete: `config/rename-session.sh`, `config/rename-window.sh`

- [ ] **Step 1: Write InputModal tests**

Create `src/__tests__/input-modal.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { InputModal } from "../input-modal";

describe("InputModal", () => {
  test("opens with pre-filled value", () => {
    const modal = new InputModal({ header: "Rename", value: "hello" });
    modal.open();
    expect(modal.isOpen()).toBe(true);
    const grid = modal.getGrid(40);
    // Row 0: header
    expect(grid.cells[0][2].char).toBe("R");
    expect(grid.cells[0][2].bold).toBe(true);
    // Input row: "  ▷ hello"
    const inputRow = modal.hasSubheader() ? 2 : 1;
    expect(grid.cells[inputRow][4].char).toBe("h");
  });

  test("opens with subheader", () => {
    const modal = new InputModal({ header: "Rename", subheader: "Current: foo", value: "foo" });
    modal.open();
    const grid = modal.getGrid(40);
    // Row 1 is subheader
    expect(grid.cells[1][2].char).toBe("C");
    expect(grid.cells[1][2].dim).toBe(true);
  });

  test("typing appends to value", () => {
    const modal = new InputModal({ header: "Test" });
    modal.open();
    modal.handleInput("a");
    modal.handleInput("b");
    const grid = modal.getGrid(40);
    // "  ▷ ab" — chars at col 4,5
    expect(grid.cells[1][4].char).toBe("a");
    expect(grid.cells[1][5].char).toBe("b");
  });

  test("backspace removes last character", () => {
    const modal = new InputModal({ header: "Test", value: "abc" });
    modal.open();
    modal.handleInput("\x7f");
    const grid = modal.getGrid(40);
    expect(grid.cells[1][4].char).toBe("a");
    expect(grid.cells[1][5].char).toBe("b");
    expect(grid.cells[1][6].char).toBe(" ");
  });

  test("enter returns result with value", () => {
    const modal = new InputModal({ header: "Test", value: "hello" });
    modal.open();
    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    if (action.type === "result") {
      expect(action.value).toBe("hello");
    }
  });

  test("enter on empty value does nothing", () => {
    const modal = new InputModal({ header: "Test" });
    modal.open();
    const action = modal.handleInput("\r");
    expect(action.type).toBe("consumed");
  });

  test("escape closes modal", () => {
    const modal = new InputModal({ header: "Test" });
    modal.open();
    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
  });

  test("getCursorPosition returns input line position", () => {
    const modal = new InputModal({ header: "Test", value: "hi" });
    modal.open();
    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
    // "  ▷ hi" — cursor after "hi" = col 6, row 1 (no subheader)
    expect(pos!.row).toBe(1);
    expect(pos!.col).toBe(6);
  });

  test("preferredWidth returns constrained value", () => {
    const modal = new InputModal({ header: "Test" });
    expect(modal.preferredWidth(200)).toBe(60); // max cap
    expect(modal.preferredWidth(80)).toBe(40); // min cap (36 rounds up)
    expect(modal.preferredWidth(120)).toBe(54); // 120 * 0.45 = 54
  });

  test("close resets state", () => {
    const modal = new InputModal({ header: "Test", value: "hello" });
    modal.open();
    modal.close();
    expect(modal.isOpen()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/input-modal.test.ts`
Expected: FAIL — `InputModal` module not found.

- [ ] **Step 3: Implement InputModal**

Create `src/input-modal.ts`:

```typescript
import type { CellGrid } from "./types";
import { createGrid, writeString } from "./cell-grid";
import {
  MODAL_BG, HEADER_ATTRS, SUBHEADER_ATTRS, PROMPT_ATTRS, INPUT_ATTRS, BG_ATTRS,
  type ModalAction,
} from "./modal";

export interface InputModalConfig {
  header: string;
  subheader?: string;
  value?: string;
  placeholder?: string;
}

export class InputModal {
  private _open = false;
  private value: string;
  private config: InputModalConfig;

  constructor(config: InputModalConfig) {
    this.config = config;
    this.value = config.value ?? "";
  }

  open(): void {
    this._open = true;
    this.value = this.config.value ?? "";
  }

  close(): void {
    this._open = false;
  }

  isOpen(): boolean {
    return this._open;
  }

  hasSubheader(): boolean {
    return this.config.subheader !== undefined;
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(40, Math.round(termCols * 0.45)), 60);
  }

  getCursorPosition(): { row: number; col: number } | null {
    const inputRow = this.config.subheader !== undefined ? 2 : 1;
    return { row: inputRow, col: 4 + this.value.length };
  }

  handleInput(data: string): ModalAction {
    if (data === "\x1b") {
      return { type: "closed" };
    }

    if (data === "\r") {
      if (this.value.length === 0) return { type: "consumed" };
      return { type: "result", value: this.value };
    }

    if (data === "\x7f" || data === "\b") {
      if (this.value.length > 0) {
        this.value = this.value.slice(0, -1);
      }
      return { type: "consumed" };
    }

    if (data.length === 1 && data >= " " && data <= "~") {
      this.value += data;
      return { type: "consumed" };
    }

    return { type: "consumed" };
  }

  getGrid(width: number): CellGrid {
    const hasSubheader = this.config.subheader !== undefined;
    const height = hasSubheader ? 3 : 2;
    const grid = createGrid(width, height);

    // Background fill
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    // Row 0: header
    writeString(grid, 0, 2, this.config.header, HEADER_ATTRS);

    // Row 1 (optional): subheader
    if (hasSubheader) {
      writeString(grid, 1, 2, this.config.subheader!, SUBHEADER_ATTRS);
    }

    // Input row
    const inputRow = hasSubheader ? 2 : 1;
    writeString(grid, inputRow, 2, "\u25b7", PROMPT_ATTRS);
    if (this.value.length > 0) {
      writeString(grid, inputRow, 4, this.value, INPUT_ATTRS);
    } else if (this.config.placeholder) {
      writeString(grid, inputRow, 4, this.config.placeholder, SUBHEADER_ATTRS);
    }

    return grid;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/input-modal.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 6: Wire rename-session and rename-window commands in main.ts**

In `handlePaletteAction()`, replace the rename-session and rename-window cases:

```typescript
case "rename-session": {
  const currentName = currentSessions.find(s => s.id === currentSessionId)?.name ?? "";
  const modal = new InputModal({
    header: "Rename Session",
    subheader: `Current: ${currentName}`,
    value: currentName,
  });
  modal.open();
  openModal(modal, async (name) => {
    await control.sendCommand(`rename-session -t '${currentSessionId}' '${name}'`);
  });
  return;
}
case "rename-window": {
  const currentName = currentWindows.find(w => w.active)?.name ?? "";
  const modal = new InputModal({
    header: "Rename Window",
    subheader: `Current: ${currentName}`,
    value: currentName,
  });
  modal.open();
  openModal(modal, async (name) => {
    await control.sendCommand(`rename-window '${name}'`);
    fetchWindows();
  });
  return;
}
```

Add the import at the top of main.ts:
```typescript
import { InputModal } from "./input-modal";
```

- [ ] **Step 7: Delete shell scripts**

```bash
rm config/rename-session.sh config/rename-window.sh
```

- [ ] **Step 8: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/input-modal.ts src/__tests__/input-modal.test.ts src/main.ts
git rm config/rename-session.sh config/rename-window.sh
git commit -m "feat: add InputModal, wire rename session/window commands"
```

---

### Task 5: ListModal — TDD + wire move-window

**Files:**
- Create: `src/list-modal.ts`
- Create: `src/__tests__/list-modal.test.ts`
- Modify: `src/main.ts`
- Delete: `config/move-window.sh`

- [ ] **Step 1: Write ListModal tests**

Create `src/__tests__/list-modal.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { ListModal } from "../list-modal";

const ITEMS = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Charlie" },
  { id: "d", label: "Delta" },
];

describe("ListModal", () => {
  test("opens with items and renders header + query + results", () => {
    const modal = new ListModal({ header: "Pick", items: ITEMS });
    modal.open();
    expect(modal.isOpen()).toBe(true);
    const grid = modal.getGrid(40);
    // Row 0: header "  Pick"
    expect(grid.cells[0][2].char).toBe("P");
    // Row 1: query "  ▷ "
    expect(grid.cells[1][2].char).toBe("\u25b7");
    // Row 2: first result "    Alpha" — selected
    expect(grid.cells[2][3].char).toBe("A");
  });

  test("opens with subheader", () => {
    const modal = new ListModal({ header: "Move", subheader: "Moving: win → ?", items: ITEMS });
    modal.open();
    const grid = modal.getGrid(40);
    // Row 0: header, Row 1: subheader
    expect(grid.cells[1][2].char).toBe("M");
    expect(grid.cells[1][2].dim).toBe(true);
    // Row 2: query
    expect(grid.cells[2][2].char).toBe("\u25b7");
  });

  test("typing filters results", () => {
    const modal = new ListModal({ header: "Pick", items: ITEMS });
    modal.open();
    modal.handleInput("a");
    const grid = modal.getGrid(40);
    // "Alpha" and "Delta" match "a", "Charlie" matches too
    // "Alpha" should rank highest (word start)
    expect(grid.cells[2][3].char).toBe("A"); // Alpha first
  });

  test("arrow down moves selection", () => {
    const modal = new ListModal({ header: "Pick", items: ITEMS });
    modal.open();
    modal.handleInput("\x1b[B"); // down
    // Selection should be on index 1 (Beta)
    const grid = modal.getGrid(40);
    expect(grid.cells[3][1].char).toBe("\u25b8"); // ▸ on row 3 (Beta)
  });

  test("enter returns selected item", () => {
    const modal = new ListModal({ header: "Pick", items: ITEMS });
    modal.open();
    modal.handleInput("\x1b[B"); // select Beta
    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    if (action.type === "result") {
      const item = action.value as { id: string; label: string };
      expect(item.id).toBe("b");
    }
  });

  test("enter with no results does nothing", () => {
    const modal = new ListModal({ header: "Pick", items: ITEMS });
    modal.open();
    modal.handleInput("z");
    modal.handleInput("z");
    modal.handleInput("z");
    const action = modal.handleInput("\r");
    expect(action.type).toBe("consumed");
  });

  test("escape closes modal", () => {
    const modal = new ListModal({ header: "Pick", items: ITEMS });
    modal.open();
    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
  });

  test("getCursorPosition returns query line position", () => {
    const modal = new ListModal({ header: "Pick", items: ITEMS });
    modal.open();
    modal.handleInput("ab");
    const pos = modal.getCursorPosition();
    // "  ▷ ab" — cursor at col 6, row 1 (no subheader)
    expect(pos).toEqual({ row: 1, col: 6 });
  });

  test("preferredWidth returns constrained value", () => {
    const modal = new ListModal({ header: "Pick", items: ITEMS });
    expect(modal.preferredWidth(200)).toBe(80);
    expect(modal.preferredWidth(60)).toBe(40);
  });

  test("defaultQuery pre-fills the filter", () => {
    const modal = new ListModal({ header: "Pick", items: ITEMS, defaultQuery: "be" });
    modal.open();
    const pos = modal.getCursorPosition();
    expect(pos!.col).toBe(6); // "  ▷ be" — cursor at 6
    // Should show Beta as top match
    const grid = modal.getGrid(40);
    expect(grid.cells[2][3].char).toBe("B");
  });

  test("close resets state", () => {
    const modal = new ListModal({ header: "Pick", items: ITEMS });
    modal.open();
    modal.handleInput("a");
    modal.close();
    expect(modal.isOpen()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/list-modal.test.ts`
Expected: FAIL — `ListModal` module not found.

- [ ] **Step 3: Implement ListModal**

Create `src/list-modal.ts`:

```typescript
import type { CellGrid } from "./types";
import { createGrid, writeString } from "./cell-grid";
import { fuzzyMatch, type FuzzyResult } from "./command-palette";
import {
  MODAL_BG, SELECTED_BG,
  HEADER_ATTRS, SUBHEADER_ATTRS, PROMPT_ATTRS, INPUT_ATTRS,
  RESULT_ATTRS, SELECTED_RESULT_ATTRS,
  MATCH_ATTRS, SELECTED_MATCH_ATTRS,
  BG_ATTRS, SELECTED_BG_ATTRS,
  NO_MATCHES_ATTRS,
  type ModalAction,
} from "./modal";
import { ColorMode } from "./types";

const MAX_VISIBLE = 16;

export interface ListItem {
  id: string;
  label: string;
  annotation?: string;
}

export interface ListModalConfig {
  header: string;
  subheader?: string;
  items: ListItem[];
  defaultQuery?: string;
}

interface FilteredItem {
  item: ListItem;
  match: FuzzyResult;
}

export class ListModal {
  private _open = false;
  private query: string;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private config: ListModalConfig;
  private filtered: FilteredItem[] = [];

  constructor(config: ListModalConfig) {
    this.config = config;
    this.query = config.defaultQuery ?? "";
  }

  open(): void {
    this._open = true;
    this.query = this.config.defaultQuery ?? "";
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.refilter();
  }

  close(): void {
    this._open = false;
    this.query = "";
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.filtered = [];
  }

  isOpen(): boolean {
    return this._open;
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(40, Math.round(termCols * 0.55)), 80);
  }

  getCursorPosition(): { row: number; col: number } | null {
    const queryRow = this.config.subheader !== undefined ? 2 : 1;
    return { row: queryRow, col: 4 + this.query.length };
  }

  handleInput(data: string): ModalAction {
    if (data === "\x1b") {
      return { type: "closed" };
    }

    if (data === "\r") {
      if (this.filtered.length === 0) return { type: "consumed" };
      return { type: "result", value: this.filtered[this.selectedIndex].item };
    }

    if (data === "\x1b[B") { // down
      if (this.filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
        this.adjustScroll();
      }
      return { type: "consumed" };
    }

    if (data === "\x1b[A") { // up
      if (this.filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
        this.adjustScroll();
      }
      return { type: "consumed" };
    }

    if (data === "\x7f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selectedIndex = 0;
        this.refilter();
      }
      return { type: "consumed" };
    }

    if (data === "\t") return { type: "consumed" };

    if (data.length === 1 && data >= " " && data <= "~") {
      this.query += data;
      this.selectedIndex = 0;
      this.refilter();
      return { type: "consumed" };
    }

    return { type: "consumed" };
  }

  getGrid(width: number): CellGrid {
    const hasSubheader = this.config.subheader !== undefined;
    const headerRows = hasSubheader ? 3 : 2; // header [+ subheader] + query
    const resultRows = Math.min(this.filtered.length || 1, MAX_VISIBLE);
    const height = headerRows + resultRows;
    const grid = createGrid(width, height);

    // Background fill
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    // Header
    writeString(grid, 0, 2, this.config.header, HEADER_ATTRS);

    // Subheader
    if (hasSubheader) {
      writeString(grid, 1, 2, this.config.subheader!, SUBHEADER_ATTRS);
    }

    // Query row
    const queryRow = hasSubheader ? 2 : 1;
    writeString(grid, queryRow, 2, "\u25b7", PROMPT_ATTRS);
    if (this.query.length > 0) {
      writeString(grid, queryRow, 4, this.query, INPUT_ATTRS);
    }

    // Results
    const visibleCount = Math.min(this.filtered.length, MAX_VISIBLE);
    if (this.filtered.length === 0) {
      writeString(grid, headerRows, 3, "No matches", NO_MATCHES_ATTRS);
    } else {
      for (let vi = 0; vi < visibleCount; vi++) {
        const i = this.scrollOffset + vi;
        const row = headerRows + vi;
        const { item, match } = this.filtered[i];
        if (!item) break;
        const isSelected = i === this.selectedIndex;
        const baseAttrs = isSelected ? SELECTED_RESULT_ATTRS : RESULT_ATTRS;

        if (isSelected) {
          writeString(grid, row, 0, " ".repeat(width), SELECTED_BG_ATTRS);
          writeString(grid, row, 1, "\u25b8", baseAttrs);
        }

        // Annotation (right-aligned)
        let annotationWidth = 0;
        if (item.annotation) {
          annotationWidth = item.annotation.length + 2;
          const annotCol = width - item.annotation.length - 1;
          writeString(grid, row, annotCol, item.annotation, isSelected ? SELECTED_RESULT_ATTRS : SUBHEADER_ATTRS);
        }

        // Label with match highlighting
        const labelStart = 3;
        const maxLen = width - labelStart - annotationWidth;
        const label = item.label.length > maxLen
          ? item.label.slice(0, maxLen - 1) + "\u2026"
          : item.label;
        const matchIndices = new Set(match.indices);

        for (let ci = 0; ci < label.length; ci++) {
          const col = labelStart + ci;
          if (col >= width) break;
          const isMatch = matchIndices.has(ci);
          const charAttrs = isMatch
            ? (isSelected ? SELECTED_MATCH_ATTRS : MATCH_ATTRS)
            : baseAttrs;
          writeString(grid, row, col, label[ci], charAttrs);
        }
      }
    }

    return grid;
  }

  private refilter(): void {
    if (this.query === "") {
      this.filtered = this.config.items.map((item) => ({
        item,
        match: { score: 0, indices: [] },
      }));
    } else {
      const scored: FilteredItem[] = [];
      for (const item of this.config.items) {
        const match = fuzzyMatch(this.query, item.label);
        if (match) scored.push({ item, match });
      }
      scored.sort((a, b) => b.match.score - a.match.score);
      this.filtered = scored;
    }

    if (this.filtered.length === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = this.filtered.length - 1;
    }
    this.scrollOffset = 0;
    this.adjustScroll();
  }

  private adjustScroll(): void {
    const maxVisible = Math.min(this.filtered.length, MAX_VISIBLE);
    if (maxVisible === 0) { this.scrollOffset = 0; return; }
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.selectedIndex - maxVisible + 1;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/list-modal.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Wire move-window command in main.ts**

In `handlePaletteAction()`, replace the `move-window` case:

```typescript
case "move-window": {
  const currentWindowName = currentWindows.find(w => w.active)?.name ?? "";
  const sessions = currentSessions
    .filter(s => s.id !== currentSessionId)
    .map(s => ({ id: s.id, label: s.name }));
  if (sessions.length === 0) return;
  const modal = new ListModal({
    header: "Move Window",
    subheader: `Moving: ${currentWindowName} \u2192 ?`,
    items: sessions,
  });
  modal.open();
  openModal(modal, async (value) => {
    const selected = value as ListItem;
    await control.sendCommand(`move-window -t '${selected.label}:'`);
    fetchWindows();
  });
  return;
}
```

Add import at the top of main.ts:
```typescript
import { ListModal, type ListItem } from "./list-modal";
```

- [ ] **Step 6: Delete move-window.sh**

```bash
rm config/move-window.sh
```

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/list-modal.ts src/__tests__/list-modal.test.ts src/main.ts
git rm config/move-window.sh
git commit -m "feat: add ListModal, wire move-window command"
```

---

### Task 6: ContentModal — TDD + wire release notes and welcome

**Files:**
- Create: `src/content-modal.ts`
- Create: `src/__tests__/content-modal.test.ts`
- Modify: `src/main.ts`
- Delete: `config/release-notes.sh`, `config/welcome.sh`

- [ ] **Step 1: Write ContentModal tests**

Create `src/__tests__/content-modal.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { ContentModal } from "../content-modal";
import { ColorMode } from "../types";
import type { CellAttrs } from "../cell-grid";

const LINES = [
  [{ text: "Line one" }],
  [{ text: "Line two" }],
  [{ text: "Line three" }],
  [{ text: "Bold", attrs: { bold: true } as CellAttrs }, { text: " text" }],
  [{ text: "Line five" }],
  [{ text: "Line six" }],
  [{ text: "Line seven" }],
  [{ text: "Line eight" }],
];

describe("ContentModal", () => {
  test("opens and renders title + content", () => {
    const modal = new ContentModal({ lines: LINES, title: "Test" });
    modal.open();
    expect(modal.isOpen()).toBe(true);
    const grid = modal.getGrid(50);
    // Row 0: title "  Test"
    expect(grid.cells[0][2].char).toBe("T");
    expect(grid.cells[0][2].bold).toBe(true);
    // Row 1: separator
    expect(grid.cells[1][2].char).toBe("\u2500");
  });

  test("j scrolls down", () => {
    const modal = new ContentModal({ lines: LINES, title: "Test" });
    modal.open();
    modal.handleInput("j");
    // First content line should now be "Line two" (scrolled past "Line one")
    const grid = modal.getGrid(50);
    // Content starts at row 2 (title + separator), first visible is now line index 1
    expect(grid.cells[2][2].char).toBe("L"); // still L but from "Line two"
  });

  test("k scrolls up", () => {
    const modal = new ContentModal({ lines: LINES, title: "Test" });
    modal.open();
    modal.handleInput("j");
    modal.handleInput("j");
    modal.handleInput("k");
    // Should have scrolled down 2, up 1 = net 1
    const grid = modal.getGrid(50);
    expect(grid.cells[2][2].char).toBe("L"); // Line two
  });

  test("k at top does not scroll past 0", () => {
    const modal = new ContentModal({ lines: LINES, title: "Test" });
    modal.open();
    const action = modal.handleInput("k");
    expect(action.type).toBe("consumed");
  });

  test("q closes modal", () => {
    const modal = new ContentModal({ lines: LINES, title: "Test" });
    modal.open();
    const action = modal.handleInput("q");
    expect(action.type).toBe("closed");
  });

  test("escape closes modal", () => {
    const modal = new ContentModal({ lines: LINES, title: "Test" });
    modal.open();
    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
  });

  test("getCursorPosition returns null", () => {
    const modal = new ContentModal({ lines: LINES, title: "Test" });
    modal.open();
    expect(modal.getCursorPosition()).toBeNull();
  });

  test("preferredWidth returns wide value", () => {
    const modal = new ContentModal({ lines: LINES });
    expect(modal.preferredWidth(120)).toBe(84); // 120 * 0.7 = 84
    expect(modal.preferredWidth(200)).toBe(90); // capped at 90
    expect(modal.preferredWidth(60)).toBe(50);  // min 50
  });

  test("renders styled segments", () => {
    const modal = new ContentModal({ lines: LINES, title: "Test" });
    modal.open();
    // Scroll to line 3 (index 3): "Bold text"
    modal.handleInput("j");
    modal.handleInput("j");
    modal.handleInput("j");
    const grid = modal.getGrid(50);
    // Row 2: "Bold" (first segment with bold attr)
    expect(grid.cells[2][2].char).toBe("B");
    expect(grid.cells[2][2].bold).toBe(true);
    // " text" (second segment, no bold)
    expect(grid.cells[2][6].char).toBe(" ");
  });

  test("g scrolls to top", () => {
    const modal = new ContentModal({ lines: LINES, title: "Test" });
    modal.open();
    modal.handleInput("j");
    modal.handleInput("j");
    modal.handleInput("j");
    modal.handleInput("g");
    const grid = modal.getGrid(50);
    expect(grid.cells[2][2].char).toBe("L"); // Line one
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/content-modal.test.ts`
Expected: FAIL — `ContentModal` module not found.

- [ ] **Step 3: Implement ContentModal**

Create `src/content-modal.ts`:

```typescript
import type { CellGrid } from "./types";
import type { CellAttrs } from "./cell-grid";
import { createGrid, writeString } from "./cell-grid";
import {
  HEADER_ATTRS, DIM_ATTRS, BG_ATTRS,
  type ModalAction,
} from "./modal";

export interface StyledSegment {
  text: string;
  attrs?: CellAttrs;
}

export type StyledLine = StyledSegment[];

export interface ContentModalConfig {
  lines: StyledLine[];
  title?: string;
}

export class ContentModal {
  private _open = false;
  private scroll = 0;
  private config: ContentModalConfig;

  constructor(config: ContentModalConfig) {
    this.config = config;
  }

  open(): void {
    this._open = true;
    this.scroll = 0;
  }

  close(): void {
    this._open = false;
    this.scroll = 0;
  }

  isOpen(): boolean {
    return this._open;
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(50, Math.round(termCols * 0.7)), 90);
  }

  getCursorPosition(): { row: number; col: number } | null {
    return null;
  }

  getHeight(termRows: number): number {
    const contentRows = this.config.lines.length;
    const fixedRows = this.config.title ? 3 : 1; // title + separator + status bar (or just status bar)
    return Math.min(termRows - 6, contentRows + fixedRows);
  }

  handleInput(data: string): ModalAction {
    if (data === "q" || data === "\x1b" || data === "\x03") {
      return { type: "closed" };
    }

    const maxScroll = Math.max(0, this.config.lines.length - this.viewportHeight());

    if (data === "j" || data === "\x1b[B" || data === "\r") {
      this.scroll = Math.min(maxScroll, this.scroll + 1);
      return { type: "consumed" };
    }
    if (data === "k" || data === "\x1b[A") {
      this.scroll = Math.max(0, this.scroll - 1);
      return { type: "consumed" };
    }
    if (data === "d" || data === " ") {
      this.scroll = Math.min(maxScroll, this.scroll + Math.floor(this.viewportHeight() / 2));
      return { type: "consumed" };
    }
    if (data === "u") {
      this.scroll = Math.max(0, this.scroll - Math.floor(this.viewportHeight() / 2));
      return { type: "consumed" };
    }
    if (data === "g") {
      this.scroll = 0;
      return { type: "consumed" };
    }
    if (data === "G") {
      this.scroll = maxScroll;
      return { type: "consumed" };
    }

    return { type: "consumed" };
  }

  // Default height for getGrid — callers can pass termRows for responsive sizing
  private _termRows = 30;
  setTermRows(rows: number): void { this._termRows = rows; }

  private viewportHeight(): number {
    const fixedRows = this.config.title ? 3 : 1;
    return this.getHeight(this._termRows) - fixedRows;
  }

  getGrid(width: number): CellGrid {
    const height = this.getHeight(this._termRows);
    const grid = createGrid(width, height);
    const hasTitle = this.config.title !== undefined;
    const headerRows = hasTitle ? 2 : 0;
    const statusRow = height - 1;
    const vpHeight = height - headerRows - 1; // -1 for status bar

    // Background fill
    for (let r = 0; r < height; r++) {
      writeString(grid, r, 0, " ".repeat(width), BG_ATTRS);
    }

    // Title
    if (hasTitle) {
      writeString(grid, 0, 2, this.config.title!, HEADER_ATTRS);
      writeString(grid, 1, 2, "\u2500".repeat(width - 4), DIM_ATTRS);
    }

    // Content
    for (let vi = 0; vi < vpHeight; vi++) {
      const lineIdx = this.scroll + vi;
      if (lineIdx >= this.config.lines.length) break;
      const row = headerRows + vi;
      const segments = this.config.lines[lineIdx];
      let col = 2;
      for (const seg of segments) {
        if (col >= width - 1) break;
        const maxLen = width - col - 1;
        const text = seg.text.length > maxLen ? seg.text.slice(0, maxLen) : seg.text;
        writeString(grid, row, col, text, seg.attrs ?? BG_ATTRS);
        col += text.length;
      }
    }

    // Status bar
    const maxScroll = Math.max(0, this.config.lines.length - vpHeight);
    const pct = maxScroll > 0 ? Math.round((this.scroll / maxScroll) * 100) : 100;
    const status = `\u2191\u2193/jk scroll  q close`;
    const pctStr = `${pct}%`;
    writeString(grid, statusRow, 2, status, DIM_ATTRS);
    writeString(grid, statusRow, width - pctStr.length - 1, pctStr, DIM_ATTRS);

    return grid;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/content-modal.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Wire release notes in main.ts**

Replace `showVersionInfo()` function:

```typescript
async function showVersionInfo(): Promise<void> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/jarredkenny/jmux/releases?per_page=10`,
      { headers: { Accept: "application/vnd.github.v3+json" } },
    );
    if (!resp.ok) return;
    const releases = await resp.json() as Array<{
      tag_name: string; name?: string; published_at?: string; body?: string;
    }>;

    const green: CellAttrs = { fg: 2, fgMode: ColorMode.Palette, bg: MODAL_BG, bgMode: ColorMode.RGB };
    const bold: CellAttrs = { bold: true, bg: MODAL_BG, bgMode: ColorMode.RGB };
    const dim: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true, bg: MODAL_BG, bgMode: ColorMode.RGB };
    const normal: CellAttrs = { bg: MODAL_BG, bgMode: ColorMode.RGB };
    const currentTag = `v${VERSION}`;

    const lines: StyledLine[] = [[]];
    for (const r of releases) {
      const tag = r.tag_name;
      const date = (r.published_at || "").split("T")[0];
      const name = r.name || tag;
      const isCurrent = tag === currentTag;

      if (isCurrent) {
        lines.push([{ text: name, attrs: { ...green, bold: true } }, { text: "  \u2190 current", attrs: green }]);
      } else {
        lines.push([{ text: name, attrs: bold }]);
      }
      lines.push([{ text: date, attrs: dim }]);
      lines.push([]);

      const body = (r.body || "").trim();
      if (body) {
        for (const line of body.split("\n")) {
          const formatted = line
            .replace(/^## (.*)/, "$1")
            .replace(/^- /, "\u2022 ");
          const isHeader = line.startsWith("## ");
          lines.push([{ text: formatted, attrs: isHeader ? bold : normal }]);
        }
        lines.push([]);
      }
      lines.push([{ text: "\u2500".repeat(40), attrs: dim }]);
      lines.push([]);
    }
    lines.push([{ text: "github.com/jarredkenny/jmux/releases", attrs: dim }]);

    const modal = new ContentModal({ lines, title: "jmux changelog" });
    modal.setTermRows(process.stdout.rows || 24);
    modal.open();
    openModal(modal, () => {}); // no result expected
  } catch {
    // Network error — silently fail
  }
}
```

Add imports at top of main.ts:
```typescript
import { ContentModal, type StyledLine } from "./content-modal";
import { MODAL_BG } from "./modal";
```

- [ ] **Step 6: Wire welcome screen in main.ts**

Replace the welcome screen trigger (around line ~1139-1153):

```typescript
if (!existsSync(configPath)) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({}, null, 2) + "\n");

  const green: CellAttrs = { fg: 2, fgMode: ColorMode.Palette, bg: MODAL_BG, bgMode: ColorMode.RGB };
  const bold: CellAttrs = { bold: true, bg: MODAL_BG, bgMode: ColorMode.RGB };
  const dim: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true, bg: MODAL_BG, bgMode: ColorMode.RGB };
  const normal: CellAttrs = { bg: MODAL_BG, bgMode: ColorMode.RGB };
  const cyan: CellAttrs = { fg: 6, fgMode: ColorMode.Palette, bg: MODAL_BG, bgMode: ColorMode.RGB };
  const yellow: CellAttrs = { fg: 3, fgMode: ColorMode.Palette, bg: MODAL_BG, bgMode: ColorMode.RGB };

  const lines: StyledLine[] = [
    [{ text: "The terminal workspace for agentic development", attrs: dim }],
    [],
    [{ text: "\u2500".repeat(44), attrs: dim }],
    [],
    [{ text: "Essential keybindings", attrs: bold }],
    [],
    [{ text: "Ctrl-Shift-Up/Down", attrs: green }, { text: "     Switch between sessions", attrs: normal }],
    [{ text: "Ctrl-a", attrs: green }, { text: " then ", attrs: normal }, { text: "n", attrs: green }, { text: "          New session", attrs: normal }],
    [{ text: "Ctrl-a", attrs: green }, { text: " then ", attrs: normal }, { text: "c", attrs: green }, { text: "          New window (tab)", attrs: normal }],
    [{ text: "Ctrl-a", attrs: green }, { text: " then ", attrs: normal }, { text: "|", attrs: green }, { text: "          Split pane horizontally", attrs: normal }],
    [{ text: "Ctrl-a", attrs: green }, { text: " then ", attrs: normal }, { text: "-", attrs: green }, { text: "          Split pane vertically", attrs: normal }],
    [{ text: "Shift-Arrow", attrs: green }, { text: "            Move between panes", attrs: normal }],
    [{ text: "Ctrl-a", attrs: green }, { text: " then ", attrs: normal }, { text: "p", attrs: green }, { text: "          Command palette", attrs: normal }],
    [],
    [{ text: "\u2500".repeat(44), attrs: dim }],
    [],
    [{ text: "The sidebar", attrs: bold }, { text: " on the left shows all your sessions.", attrs: normal }],
    [{ text: "\u25CF", attrs: green }, { text: " Green dot = new output    ", attrs: normal }, { text: "!", attrs: yellow }, { text: " Orange = needs review", attrs: normal }],
    [{ text: "Click a session to switch to it.", attrs: normal }],
    [],
    [{ text: "\u2500".repeat(44), attrs: dim }],
    [],
    [{ text: "Next steps", attrs: bold }],
    [],
    [{ text: "1.", attrs: cyan }, { text: " Try ", attrs: normal }, { text: "Ctrl-a p", attrs: green }, { text: " to open the command palette", attrs: normal }],
    [{ text: "2.", attrs: cyan }, { text: " Run ", attrs: normal }, { text: "jmux --install-agent-hooks", attrs: green }, { text: " for Claude Code notifications", attrs: normal }],
    [{ text: "3.", attrs: cyan }, { text: " Full guide: ", attrs: normal }, { text: "github.com/jarredkenny/jmux", attrs: dim }],
  ];

  const modal = new ContentModal({ lines, title: "Welcome to jmux" });
  modal.setTermRows(process.stdout.rows || 24);
  modal.open();
  openModal(modal, () => {});
}
```

- [ ] **Step 7: Delete shell scripts**

```bash
rm config/release-notes.sh config/welcome.sh
```

- [ ] **Step 8: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/content-modal.ts src/__tests__/content-modal.test.ts src/main.ts
git rm config/release-notes.sh config/welcome.sh
git commit -m "feat: add ContentModal, wire release notes and welcome screen"
```

---

### Task 7: NewSessionModal — TDD + wire new-session command

**Files:**
- Create: `src/new-session-modal.ts`
- Create: `src/__tests__/new-session-modal.test.ts`
- Modify: `src/main.ts`
- Delete: `config/new-session.sh`

- [ ] **Step 1: Write NewSessionModal tests**

Create `src/__tests__/new-session-modal.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { NewSessionModal, type NewSessionProviders, type NewSessionResult } from "../new-session-modal";

function makeProviders(overrides?: Partial<NewSessionProviders>): NewSessionProviders {
  return {
    scanProjectDirs: () => ["/home/user/project-a", "/home/user/project-b", "/home/user/bare-repo"],
    isBareRepo: (dir) => dir === "/home/user/bare-repo",
    getWorktrees: () => [
      { name: "main", path: "/home/user/bare-repo/main" },
      { name: "feature", path: "/home/user/bare-repo/feature" },
    ],
    getRemoteBranches: () => ["main", "develop", "release/v1"],
    getDefaultBranch: () => "main",
    ...overrides,
  };
}

describe("NewSessionModal", () => {
  test("opens on directory picker step", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    expect(modal.isOpen()).toBe(true);
    const grid = modal.getGrid(60);
    // Header: "  New Session"
    expect(grid.cells[0][2].char).toBe("N");
  });

  test("selecting non-bare directory advances to name input", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    // Select first item (project-a, not bare)
    const action = modal.handleInput("\r");
    expect(action.type).toBe("consumed");
    // Now on name input step — grid should show name header
    const grid = modal.getGrid(60);
    expect(grid.cells[0][2].char).toBe("N"); // "New Session"
  });

  test("standard flow: select dir + enter name = standard result", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    // Select project-a (first item)
    modal.handleInput("\r");
    // Enter name "my-session"
    modal.handleInput("m");
    modal.handleInput("y");
    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    const result = (action as { type: "result"; value: NewSessionResult }).value;
    expect(result.type).toBe("standard");
    if (result.type === "standard") {
      expect(result.dir).toBe("/home/user/project-a");
      expect(result.name).toBe("my");
    }
  });

  test("bare repo flow: select dir → pick existing worktree = existing_worktree result", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    // Navigate to bare-repo (3rd item)
    modal.handleInput("\x1b[B"); // down
    modal.handleInput("\x1b[B"); // down — now on bare-repo
    modal.handleInput("\r"); // select
    // Now on worktree picker — items: "+ new worktree", "main", "feature"
    // Select "main" (2nd item, index 1)
    modal.handleInput("\x1b[B"); // skip "+ new worktree"
    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    const result = (action as { type: "result"; value: NewSessionResult }).value;
    expect(result.type).toBe("existing_worktree");
    if (result.type === "existing_worktree") {
      expect(result.branch).toBe("main");
      expect(result.path).toBe("/home/user/bare-repo/main");
    }
  });

  test("bare repo flow: new worktree → pick branch → enter name = new_worktree result", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    // Navigate to bare-repo
    modal.handleInput("\x1b[B");
    modal.handleInput("\x1b[B");
    modal.handleInput("\r");
    // Select "+ new worktree" (first item)
    modal.handleInput("\r");
    // Now on branch picker — select "develop" (2nd item)
    modal.handleInput("\x1b[B");
    modal.handleInput("\r");
    // Now on name input
    modal.handleInput("f");
    modal.handleInput("x");
    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    const result = (action as { type: "result"; value: NewSessionResult }).value;
    expect(result.type).toBe("new_worktree");
    if (result.type === "new_worktree") {
      expect(result.dir).toBe("/home/user/bare-repo");
      expect(result.baseBranch).toBe("develop");
      expect(result.name).toBe("fx");
    }
  });

  test("esc at step 1 closes wizard", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
  });

  test("esc at step 2 goes back to step 1", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    modal.handleInput("\r"); // select dir → name input
    const action = modal.handleInput("\x1b"); // back
    expect(action.type).toBe("consumed");
    // Should be back on dir picker
    const grid = modal.getGrid(60);
    // Query row should have the previous query state preserved
    // Check that we're showing directory items again
    expect(modal.isOpen()).toBe(true);
  });

  test("esc at step 3 goes back to step 2", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    // Go to bare repo → worktree picker → new worktree → branch picker
    modal.handleInput("\x1b[B");
    modal.handleInput("\x1b[B");
    modal.handleInput("\r"); // select bare-repo
    modal.handleInput("\r"); // select "+ new worktree"
    // Now on branch picker, esc should go back to worktree picker
    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("consumed");
    expect(modal.isOpen()).toBe(true);
  });

  test("close clears all state", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    modal.handleInput("\r"); // advance
    modal.close();
    expect(modal.isOpen()).toBe(false);
  });

  test("getCursorPosition delegates to inner modal", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
  });

  test("preferredWidth matches ListModal width", () => {
    const modal = new NewSessionModal(makeProviders());
    expect(modal.preferredWidth(100)).toBe(55);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/new-session-modal.test.ts`
Expected: FAIL — `NewSessionModal` module not found.

- [ ] **Step 3: Implement NewSessionModal**

Create `src/new-session-modal.ts`:

```typescript
import type { CellGrid } from "./types";
import { InputModal } from "./input-modal";
import { ListModal, type ListItem } from "./list-modal";
import type { ModalAction } from "./modal";
import { basename } from "path";

export interface NewSessionProviders {
  scanProjectDirs: () => string[];
  isBareRepo: (dir: string) => boolean;
  getWorktrees: (dir: string) => Array<{ name: string; path: string }>;
  getRemoteBranches: (dir: string) => string[];
  getDefaultBranch: (dir: string) => string;
}

export type NewSessionResult =
  | { type: "standard"; dir: string; name: string }
  | { type: "existing_worktree"; dir: string; path: string; branch: string }
  | { type: "new_worktree"; dir: string; baseBranch: string; name: string };

type StepId = "dir" | "worktree" | "base_branch" | "name";

interface StackEntry {
  modal: ListModal | InputModal;
  stepId: StepId;
}

const NEW_WORKTREE_ID = "__new_worktree__";

export class NewSessionModal {
  private _open = false;
  private providers: NewSessionProviders;
  private currentInner: ListModal | InputModal;
  private currentStep: StepId = "dir";
  private stepStack: StackEntry[] = [];

  // Accumulated state
  private selectedDir = "";
  private isBare = false;
  private selectedWorktree: { name: string; path: string } | null = null;
  private baseBranch = "";

  constructor(providers: NewSessionProviders) {
    this.providers = providers;
    this.currentInner = this.makeDirPicker();
  }

  open(): void {
    this._open = true;
    this.currentStep = "dir";
    this.stepStack = [];
    this.selectedDir = "";
    this.isBare = false;
    this.selectedWorktree = null;
    this.baseBranch = "";
    this.currentInner = this.makeDirPicker();
    this.currentInner.open();
  }

  close(): void {
    this._open = false;
    this.stepStack = [];
  }

  isOpen(): boolean {
    return this._open;
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(40, Math.round(termCols * 0.55)), 80);
  }

  getCursorPosition(): { row: number; col: number } | null {
    return this.currentInner.getCursorPosition();
  }

  getGrid(width: number): CellGrid {
    return this.currentInner.getGrid(width);
  }

  handleInput(data: string): ModalAction {
    // Intercept Esc before inner modal sees it
    if (data === "\x1b") {
      if (this.stepStack.length === 0) {
        return { type: "closed" };
      }
      const prev = this.stepStack.pop()!;
      this.currentInner = prev.modal;
      this.currentStep = prev.stepId;
      return { type: "consumed" };
    }

    const action = this.currentInner.handleInput(data);
    if (action.type === "result") {
      return this.advanceStep(action.value);
    }
    return action;
  }

  private advanceStep(value: unknown): ModalAction {
    switch (this.currentStep) {
      case "dir": {
        const item = value as ListItem;
        this.selectedDir = item.id;
        this.isBare = this.providers.isBareRepo(this.selectedDir);

        this.pushCurrentToStack();

        if (this.isBare) {
          this.currentStep = "worktree";
          this.currentInner = this.makeWorktreePicker();
          this.currentInner.open();
        } else {
          this.currentStep = "name";
          this.currentInner = this.makeNameInput(basename(this.selectedDir));
          this.currentInner.open();
        }
        return { type: "consumed" };
      }

      case "worktree": {
        const item = value as ListItem;
        if (item.id === NEW_WORKTREE_ID) {
          this.pushCurrentToStack();
          this.currentStep = "base_branch";
          this.currentInner = this.makeBranchPicker();
          this.currentInner.open();
          return { type: "consumed" };
        }
        // Existing worktree
        const worktrees = this.providers.getWorktrees(this.selectedDir);
        const wt = worktrees.find(w => w.name === item.id);
        return {
          type: "result",
          value: {
            type: "existing_worktree",
            dir: this.selectedDir,
            path: wt?.path ?? "",
            branch: item.id,
          } satisfies NewSessionResult,
        };
      }

      case "base_branch": {
        const item = value as ListItem;
        this.baseBranch = item.id;
        this.pushCurrentToStack();
        this.currentStep = "name";
        this.currentInner = this.makeNameInput("");
        this.currentInner.open();
        return { type: "consumed" };
      }

      case "name": {
        const name = value as string;
        if (this.isBare && this.baseBranch) {
          return {
            type: "result",
            value: {
              type: "new_worktree",
              dir: this.selectedDir,
              baseBranch: this.baseBranch,
              name,
            } satisfies NewSessionResult,
          };
        }
        return {
          type: "result",
          value: {
            type: "standard",
            dir: this.selectedDir,
            name,
          } satisfies NewSessionResult,
        };
      }
    }
  }

  private pushCurrentToStack(): void {
    this.stepStack.push({
      modal: this.currentInner,
      stepId: this.currentStep,
    });
  }

  private breadcrumb(): string {
    const parts: string[] = [];
    if (this.selectedDir) {
      parts.push(this.selectedDir.replace(process.env.HOME ?? "", "~"));
    }
    if (this.currentStep === "base_branch") {
      parts.push("new worktree");
    }
    if (this.currentStep === "name" && this.baseBranch) {
      parts.push(`new worktree from ${this.baseBranch}`);
    }
    return parts.join(" \u203a ") || "Search for a project directory";
  }

  private makeDirPicker(): ListModal {
    const dirs = this.providers.scanProjectDirs();
    const home = process.env.HOME ?? "";
    return new ListModal({
      header: "New Session",
      subheader: "Search for a project directory",
      items: dirs.map(d => ({
        id: d,
        label: d.replace(home, "~"),
      })),
    });
  }

  private makeWorktreePicker(): ListModal {
    const worktrees = this.providers.getWorktrees(this.selectedDir);
    const items: ListItem[] = [
      { id: NEW_WORKTREE_ID, label: "+ new worktree" },
      ...worktrees.map(w => ({ id: w.name, label: w.name })),
    ];
    return new ListModal({
      header: "New Session",
      subheader: this.breadcrumb(),
      items,
    });
  }

  private makeBranchPicker(): ListModal {
    const branches = this.providers.getRemoteBranches(this.selectedDir);
    const defaultBranch = this.providers.getDefaultBranch(this.selectedDir);
    return new ListModal({
      header: "New Session",
      subheader: this.breadcrumb(),
      items: branches.map(b => ({ id: b, label: b })),
      defaultQuery: defaultBranch,
    });
  }

  private makeNameInput(defaultName: string): InputModal {
    return new InputModal({
      header: "New Session",
      subheader: this.breadcrumb(),
      value: defaultName,
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/new-session-modal.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Add data provider functions and wire new-session in main.ts**

Add data provider functions in main.ts (before `handlePaletteAction`):

```typescript
import { NewSessionModal, type NewSessionResult } from "./new-session-modal";
import { spawnSync } from "bun";
import { resolve, basename, dirname } from "path";
import { homedir } from "os";

function getNewSessionProviders(): NewSessionProviders {
  const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
  return {
    scanProjectDirs: () => {
      let searchDirs: string[] = [];
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        searchDirs = (cfg.projectDirs ?? []).map((d: string) =>
          d.replace("~", homedir()),
        );
      } catch {}
      if (searchDirs.length === 0) {
        searchDirs = ["Code", "Projects", "src", "work", "dev"].map(d =>
          resolve(homedir(), d),
        );
      }
      const result = spawnSync(["find", ...searchDirs, "-maxdepth", "4", "-name", ".git"], {
        stdout: "pipe", stderr: "ignore",
      });
      const stdout = result.stdout.toString().trim();
      if (!stdout) return [homedir()];
      const dirs = stdout.split("\n").map(p => p.replace(/\/\.git$/, "")).sort();
      return [homedir(), ...new Set(dirs)];
    },
    isBareRepo: (dir) => {
      try {
        const result = spawnSync(["git", "--git-dir", `${dir}/.git`, "config", "--get", "core.bare"], {
          stdout: "pipe", stderr: "ignore",
        });
        return result.stdout.toString().trim() === "true";
      } catch { return false; }
    },
    getWorktrees: (dir) => {
      const result = spawnSync(["git", "--git-dir", `${dir}/.git`, "worktree", "list", "--porcelain"], {
        stdout: "pipe", stderr: "ignore",
      });
      const lines = result.stdout.toString().split("\n");
      const worktrees: Array<{ name: string; path: string }> = [];
      let currentPath = "";
      for (const line of lines) {
        if (line.startsWith("worktree ")) currentPath = line.slice(9);
        if (line.startsWith("branch refs/heads/")) {
          worktrees.push({ name: line.slice(18), path: currentPath });
        }
      }
      return worktrees;
    },
    getRemoteBranches: (dir) => {
      const result = spawnSync(["git", "--git-dir", `${dir}/.git`, "for-each-ref",
        "--format=%(refname:short)", "refs/remotes/origin/"], {
        stdout: "pipe", stderr: "ignore",
      });
      return result.stdout.toString().trim().split("\n")
        .map(b => b.replace("origin/", ""))
        .filter(b => b && b !== "HEAD")
        .sort();
    },
    getDefaultBranch: (dir) => {
      for (const b of ["main", "master", "develop"]) {
        const result = spawnSync(["git", "--git-dir", `${dir}/.git`, "rev-parse", "--verify", `refs/remotes/origin/${b}`], {
          stdout: "ignore", stderr: "ignore",
        });
        if (result.exitCode === 0) return b;
      }
      return "";
    },
  };
}
```

Replace the `new-session` case in `handlePaletteAction()`:

```typescript
case "new-session": {
  const modal = new NewSessionModal(getNewSessionProviders());
  modal.open();
  openModal(modal, async (value) => {
    const result = value as NewSessionResult;
    const parentClient = ptyClientName;
    if (!parentClient) return;

    switch (result.type) {
      case "standard":
        await control.sendCommand(`new-session -d -s '${result.name}' -c '${result.dir}'`);
        await control.sendCommand(`switch-client -c ${parentClient} -t '${result.name}'`);
        break;
      case "existing_worktree":
        await control.sendCommand(`new-session -d -s '${result.branch}' -c '${result.path}'`);
        await control.sendCommand(`switch-client -c ${parentClient} -t '${result.branch}'`);
        break;
      case "new_worktree": {
        const wtPath = `${result.dir}/${result.name}`;
        const cmd = `wtm create ${result.name} --from ${result.baseBranch} --no-shell; cd ${result.name}; exec $SHELL`;
        await control.sendCommand(`new-session -d -s '${result.name}' -c '${result.dir}' '${cmd}'`);
        const waitCmd = `while [ ! -d '${wtPath}' ]; do sleep 0.2; done; cd '${wtPath}' && exec $SHELL`;
        await control.sendCommand(`split-window -h -d -t '${result.name}' -c '${result.dir}' '${waitCmd}'`);
        await control.sendCommand(`select-pane -t '${result.name}.0'`);
        await control.sendCommand(`switch-client -c ${parentClient} -t '${result.name}'`);
        break;
      }
    }
  });
  return;
}
```

- [ ] **Step 6: Delete new-session.sh**

```bash
rm config/new-session.sh
```

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/new-session-modal.ts src/__tests__/new-session-modal.test.ts src/main.ts
git rm config/new-session.sh
git commit -m "feat: add NewSessionModal wizard, wire new-session command"
```

---

### Task 8: Settings consolidation + final cleanup

**Files:**
- Modify: `src/main.ts`
- Delete: `config/settings.sh`

- [ ] **Step 1: Add new settings commands to buildPaletteCommands**

In `buildPaletteCommands()`, replace the `setting-project-dirs` entry and add new settings commands:

```typescript
// Replace old setting-project-dirs with new settings
commands.push({
  id: "setting-wtm",
  label: `wtm integration: ${settings.wtmIntegration !== false ? "on" : "off"}`,
  category: "setting",
});
commands.push({
  id: "setting-claude-command",
  label: "Claude command",
  category: "setting",
});
commands.push({
  id: "setting-project-dirs",
  label: "Project directories",
  category: "setting",
});
```

Where `settings` is loaded from the config file. Read the current settings at the top of `buildPaletteCommands`:

```typescript
let settings: Record<string, any> = {};
try {
  const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
  if (existsSync(cfgPath)) settings = JSON.parse(readFileSync(cfgPath, "utf-8"));
} catch {}
```

- [ ] **Step 2: Handle new settings commands in handlePaletteAction**

Replace the old `setting-project-dirs` case and the `setting-claude-command` sublist handler:

```typescript
case "setting-wtm": {
  const current = settings.wtmIntegration !== false;
  await applySetting("wtmIntegration", !current, "boolean");
  return;
}
case "setting-claude-command": {
  const current = settings.claudeCommand ?? "claude";
  const modal = new InputModal({
    header: "Claude Command",
    subheader: "Command to launch Claude Code from toolbar",
    value: String(current),
  });
  modal.open();
  openModal(modal, async (value) => {
    await applySetting("claudeCommand", value as string, "string");
  });
  return;
}
case "setting-project-dirs": {
  const dirs = settings.projectDirs ?? ["~/Code", "~/Projects", "~/src", "~/work", "~/dev"];
  const modal = new InputModal({
    header: "Project Directories",
    subheader: "Comma-separated list of directories to search",
    value: dirs.join(", "),
  });
  modal.open();
  openModal(modal, async (value) => {
    const newDirs = (value as string).split(",").map(s => s.trim()).filter(Boolean);
    await applySetting("projectDirs", newDirs, "array");
  });
  return;
}
```

Update `applySetting` to handle `"boolean"` and `"array"` types:

```typescript
async function applySetting(key: string, value: string | number | boolean | string[], type: string): Promise<void> {
  const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
  try {
    let config: Record<string, any> = {};
    if (existsSync(cfgPath)) {
      config = JSON.parse(readFileSync(cfgPath, "utf-8"));
    }
    if (type === "number") {
      config[key] = typeof value === "number" ? value : parseInt(String(value), 10);
    } else if (type === "boolean") {
      config[key] = value;
    } else if (type === "array") {
      config[key] = value;
    } else {
      config[key] = value;
    }
    const dir = dirname(cfgPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n");
  } catch {}
}
```

Remove the old `setting-claude-command` sublist handler that used `sublistOptionId`.

- [ ] **Step 3: Remove settings toolbar action**

In `handleToolbarAction()`, remove the `"settings"` case from the second switch block:

```typescript
// Non-window actions — popups need a real PTY
switch (id) {
  default:
    return;
}
```

Or simplify by removing the second switch entirely if `"settings"` was the only case.

- [ ] **Step 4: Remove spawnTmuxPopup function**

Delete the `spawnTmuxPopup` function (lines ~763-771). All call sites should have been replaced in prior tasks. Search main.ts for any remaining `spawnTmuxPopup` references — there should be none.

- [ ] **Step 5: Delete settings.sh**

```bash
rm config/settings.sh
```

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git rm config/settings.sh
git commit -m "feat: consolidate settings into palette, remove spawnTmuxPopup and remaining shell scripts"
```
