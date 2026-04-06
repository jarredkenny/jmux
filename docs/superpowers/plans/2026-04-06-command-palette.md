# Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-process command palette to jmux — a top-anchored dropdown overlay with fuzzy search across sessions, windows, panes, and settings.

**Architecture:** New `CommandPalette` class renders a `CellGrid` overlay. `InputRouter` gains a palette mode that redirects keyboard input. `compositeGrids` composites the palette over the toolbar and top of the main area. `SIGUSR1` signal triggers open from tmux keybinding; `Ctrl-a p` detected inline by the palette for close.

**Tech Stack:** TypeScript, Bun runtime, bun:test, CellGrid rendering system

**Spec:** `docs/superpowers/specs/2026-04-06-command-palette-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/command-palette.ts` | Create | Palette state, fuzzy matching, input handling, grid rendering |
| `src/__tests__/command-palette.test.ts` | Create | Tests for fuzzy matching, input handling, state transitions, grid output |
| `src/input-router.ts` | Modify | Add palette mode: route keyboard to palette when open |
| `src/__tests__/input-router.test.ts` | Modify | Add tests for palette mode routing |
| `src/renderer.ts` | Modify | `compositeGrids` accepts palette overlay; `render` handles palette cursor |
| `src/__tests__/renderer.test.ts` | Modify | Add tests for palette overlay compositing |
| `src/main.ts` | Modify | SIGUSR1 handler, palette orchestration, command builders, action dispatch |
| `config/defaults.conf` | Modify | Bind `Ctrl-a p` to `run-shell -b "kill -USR1 $JMUX_PID"` |
| `src/types.ts` | Modify | Export `PaletteCommand`, `PaletteSublistOption`, `PaletteResult`, `PaletteAction` types |

---

### Task 1: Types and Fuzzy Matching

**Files:**
- Modify: `src/types.ts`
- Create: `src/command-palette.ts`
- Create: `src/__tests__/command-palette.test.ts`

This task adds the shared types and the fuzzy matching function — the core algorithm the palette depends on. No rendering, no input handling yet.

- [ ] **Step 1: Add palette types to `src/types.ts`**

Append after the `SessionInfo` interface:

```typescript
export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  sublist?: PaletteSublistOption[];
}

export interface PaletteSublistOption {
  id: string;
  label: string;
  current?: boolean;
}

export interface PaletteResult {
  commandId: string;
  sublistOptionId?: string;
}

export type PaletteAction =
  | { type: "consumed" }
  | { type: "closed" }
  | { type: "execute"; result: PaletteResult };
```

- [ ] **Step 2: Write failing tests for fuzzy matching**

Create `src/__tests__/command-palette.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { fuzzyMatch, type FuzzyResult } from "../command-palette";

describe("fuzzyMatch", () => {
  test("matches exact substring", () => {
    const result = fuzzyMatch("split", "Split horizontal");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([0, 1, 2, 3, 4]);
  });

  test("matches characters in order across word boundaries", () => {
    const result = fuzzyMatch("nw", "New window");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([0, 4]);
  });

  test("is case-insensitive", () => {
    const result = fuzzyMatch("SPLIT", "Split horizontal");
    expect(result).not.toBeNull();
  });

  test("returns null when characters are not in order", () => {
    const result = fuzzyMatch("zx", "Split horizontal");
    expect(result).toBeNull();
  });

  test("returns null for empty label", () => {
    const result = fuzzyMatch("a", "");
    expect(result).toBeNull();
  });

  test("matches everything for empty query", () => {
    const result = fuzzyMatch("", "Split horizontal");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([]);
    expect(result!.score).toBe(0);
  });

  test("consecutive matches score higher than spread matches", () => {
    const consecutive = fuzzyMatch("sp", "Split horizontal");
    const spread = fuzzyMatch("sp", "Session: project");
    expect(consecutive).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(consecutive!.score).toBeGreaterThan(spread!.score);
  });

  test("word boundary match scores higher", () => {
    const boundary = fuzzyMatch("sh", "Split horizontal");
    const mid = fuzzyMatch("sh", "pushed");
    expect(boundary).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(boundary!.score).toBeGreaterThan(mid!.score);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test src/__tests__/command-palette.test.ts`
Expected: FAIL — `fuzzyMatch` does not exist yet.

- [ ] **Step 4: Implement fuzzy matching**

Create `src/command-palette.ts` with the fuzzy matching function:

```typescript
import type { PaletteCommand, PaletteSublistOption, PaletteResult, PaletteAction } from "./types";
import type { CellGrid } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import { ColorMode } from "./types";

export interface FuzzyResult {
  score: number;
  indices: number[]; // positions of matched characters in the label
}

export function fuzzyMatch(query: string, label: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, indices: [] };
  if (label.length === 0) return null;

  const lowerQuery = query.toLowerCase();
  const lowerLabel = label.toLowerCase();
  const indices: number[] = [];
  let qi = 0;

  for (let li = 0; li < lowerLabel.length && qi < lowerQuery.length; li++) {
    if (lowerLabel[li] === lowerQuery[qi]) {
      indices.push(li);
      qi++;
    }
  }

  if (qi < lowerQuery.length) return null;

  // Score: consecutive matches bonus + word boundary bonus + shorter label bonus
  let score = 0;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) score += 10; // consecutive
  }
  for (const idx of indices) {
    if (idx === 0 || label[idx - 1] === " " || label[idx - 1] === "-" || label[idx - 1] === "_") {
      score += 5; // word boundary
    }
  }
  score += Math.max(0, 50 - label.length); // shorter label bonus

  return { score, indices };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/__tests__/command-palette.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/command-palette.ts src/__tests__/command-palette.test.ts
git commit -m "feat(command-palette): add types and fuzzy matching"
```

---

### Task 2: Palette State and Input Handling

**Files:**
- Modify: `src/command-palette.ts`
- Modify: `src/__tests__/command-palette.test.ts`

This task adds the `CommandPalette` class with state management and input handling — open/close, typing, navigation, sub-list drilling, `Ctrl-a p` buffering. No rendering yet.

- [ ] **Step 1: Write failing tests for palette input handling**

Append to `src/__tests__/command-palette.test.ts`:

```typescript
import { fuzzyMatch, CommandPalette, type FuzzyResult } from "../command-palette";
import type { PaletteCommand } from "../types";

const testCommands: PaletteCommand[] = [
  { id: "split-h", label: "Split horizontal", category: "pane" },
  { id: "split-v", label: "Split vertical", category: "pane" },
  { id: "new-window", label: "New window", category: "window" },
  { id: "setting-width", label: "Sidebar width", category: "setting", sublist: [
    { id: "22", label: "22" },
    { id: "26", label: "26", current: true },
    { id: "30", label: "30" },
  ]},
];

describe("CommandPalette", () => {
  test("starts closed", () => {
    const palette = new CommandPalette();
    expect(palette.isOpen()).toBe(false);
  });

  test("open/close lifecycle", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    expect(palette.isOpen()).toBe(true);
    palette.close();
    expect(palette.isOpen()).toBe(false);
  });

  test("typing filters results", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("s");
    palette.handleInput("p");
    const results = palette.getFilteredResults();
    expect(results.length).toBe(2);
    expect(results[0].command.id).toBe("split-h");
    expect(results[1].command.id).toBe("split-v");
  });

  test("backspace removes last character", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("s");
    palette.handleInput("p");
    palette.handleInput("\x7f"); // backspace
    const results = palette.getFilteredResults();
    // "s" matches Split horizontal, Split vertical, Sidebar width
    expect(results.length).toBe(3);
  });

  test("backspace is no-op when query empty", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const action = palette.handleInput("\x7f");
    expect(action.type).toBe("consumed");
    expect(palette.isOpen()).toBe(true);
  });

  test("down arrow moves selection", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    expect(palette.getSelectedIndex()).toBe(0);
    palette.handleInput("\x1b[B"); // down
    expect(palette.getSelectedIndex()).toBe(1);
  });

  test("up arrow wraps to bottom", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    expect(palette.getSelectedIndex()).toBe(0);
    palette.handleInput("\x1b[A"); // up
    expect(palette.getSelectedIndex()).toBe(testCommands.length - 1);
  });

  test("enter on regular command returns execute", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const action = palette.handleInput("\r"); // enter
    expect(action.type).toBe("execute");
    if (action.type === "execute") {
      expect(action.result.commandId).toBe("split-h");
      expect(action.result.sublistOptionId).toBeUndefined();
    }
  });

  test("enter on command with sublist drills in", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    // Navigate to "Sidebar width" (index 3)
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    const action = palette.handleInput("\r");
    expect(action.type).toBe("consumed"); // drilled in, not executed
    expect(palette.isInSublist()).toBe(true);
  });

  test("enter in sublist returns execute with sublistOptionId", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    // Navigate to "Sidebar width" and drill in
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\r"); // drill in
    // Select "22" (first option, already selected)
    const action = palette.handleInput("\r");
    expect(action.type).toBe("execute");
    if (action.type === "execute") {
      expect(action.result.commandId).toBe("setting-width");
      expect(action.result.sublistOptionId).toBe("22");
    }
  });

  test("escape in sublist returns to main list", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\r"); // drill in
    expect(palette.isInSublist()).toBe(true);
    palette.handleInput("\x1b"); // escape
    expect(palette.isInSublist()).toBe(false);
    expect(palette.isOpen()).toBe(true);
  });

  test("escape at top level closes palette", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const action = palette.handleInput("\x1b"); // escape
    expect(action.type).toBe("closed");
    expect(palette.isOpen()).toBe(false);
  });

  test("Ctrl-a then p closes palette", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const action1 = palette.handleInput("\x01"); // Ctrl-a
    expect(action1.type).toBe("consumed"); // buffered
    const action2 = palette.handleInput("p");
    expect(action2.type).toBe("closed");
    expect(palette.isOpen()).toBe(false);
  });

  test("Ctrl-a then non-p discards both bytes", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("\x01"); // Ctrl-a
    const action = palette.handleInput("x"); // not p
    expect(action.type).toBe("consumed");
    expect(palette.isOpen()).toBe(true);
    expect(palette.getQuery()).toBe(""); // "x" was not appended
  });

  test("selection resets to 0 when query changes", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("\x1b[B"); // move to index 1
    palette.handleInput("\x1b[B"); // move to index 2
    palette.handleInput("n"); // type — resets selection
    expect(palette.getSelectedIndex()).toBe(0);
  });

  test("sublist filtering works", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    // Navigate to "Sidebar width" and drill in
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\r"); // drill in
    palette.handleInput("3"); // type "3"
    const results = palette.getFilteredResults();
    expect(results.length).toBe(1);
    expect(results[0].command.id).toBe("30");
  });
});
```

Also update the import at the top of the file — change the first import line:

```typescript
import { fuzzyMatch, CommandPalette, type FuzzyResult } from "../command-palette";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/command-palette.test.ts`
Expected: FAIL — `CommandPalette` class does not exist yet.

- [ ] **Step 3: Implement CommandPalette class**

Add to `src/command-palette.ts` after the `fuzzyMatch` function:

```typescript
interface FilteredItem {
  command: PaletteCommand; // in sublist mode, wraps a PaletteSublistOption
  match: FuzzyResult;
}

export class CommandPalette {
  private _open = false;
  private query = "";
  private selectedIndex = 0;
  private commands: PaletteCommand[] = [];
  private filtered: FilteredItem[] = [];
  private ctrlABuffered = false;

  // Sub-list state
  private sublistParent: PaletteCommand | null = null;
  private savedQuery = "";
  private savedIndex = 0;

  open(commands: PaletteCommand[]): void {
    this.commands = commands;
    this.query = "";
    this.selectedIndex = 0;
    this.sublistParent = null;
    this.savedQuery = "";
    this.savedIndex = 0;
    this.ctrlABuffered = false;
    this._open = true;
    this.refilter();
  }

  close(): void {
    this._open = false;
    this.query = "";
    this.selectedIndex = 0;
    this.commands = [];
    this.filtered = [];
    this.sublistParent = null;
    this.ctrlABuffered = false;
  }

  isOpen(): boolean {
    return this._open;
  }

  isInSublist(): boolean {
    return this.sublistParent !== null;
  }

  getQuery(): string {
    return this.query;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  getFilteredResults(): FilteredItem[] {
    return this.filtered;
  }

  getSublistParent(): PaletteCommand | null {
    return this.sublistParent;
  }

  getCursorCol(): number {
    // prompt "▷ " = 2 chars + query length
    const prefix = this.sublistParent
      ? this.sublistParent.label.length + 3 // "Label › " = label + " › "
      : 2; // "▷ "
    return prefix + this.query.length;
  }

  handleInput(data: string): PaletteAction {
    if (!this._open) return { type: "consumed" };

    // Ctrl-a buffering
    if (this.ctrlABuffered) {
      this.ctrlABuffered = false;
      if (data === "p") {
        this.close();
        return { type: "closed" };
      }
      return { type: "consumed" }; // discard non-p after Ctrl-a
    }

    if (data === "\x01") { // Ctrl-a
      this.ctrlABuffered = true;
      return { type: "consumed" };
    }

    // Escape
    if (data === "\x1b") {
      if (this.sublistParent) {
        // Back to main list
        this.sublistParent = null;
        this.query = this.savedQuery;
        this.selectedIndex = this.savedIndex;
        this.refilter();
        return { type: "consumed" };
      }
      this.close();
      return { type: "closed" };
    }

    // Enter
    if (data === "\r") {
      if (this.filtered.length === 0) return { type: "consumed" };
      const selected = this.filtered[this.selectedIndex];
      if (!selected) return { type: "consumed" };

      if (this.sublistParent) {
        // In sublist — execute with sublistOptionId
        return {
          type: "execute",
          result: {
            commandId: this.sublistParent.id,
            sublistOptionId: selected.command.id,
          },
        };
      }

      if (selected.command.sublist) {
        // Drill into sublist
        this.savedQuery = this.query;
        this.savedIndex = this.selectedIndex;
        this.sublistParent = selected.command;
        this.query = "";
        this.selectedIndex = 0;
        this.refilter();
        return { type: "consumed" };
      }

      // Regular command
      return {
        type: "execute",
        result: { commandId: selected.command.id },
      };
    }

    // Arrow keys
    if (data === "\x1b[A") { // up
      if (this.filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
      }
      return { type: "consumed" };
    }
    if (data === "\x1b[B") { // down
      if (this.filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
      }
      return { type: "consumed" };
    }

    // Backspace
    if (data === "\x7f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selectedIndex = 0;
        this.refilter();
      }
      return { type: "consumed" };
    }

    // Tab — no-op
    if (data === "\t") return { type: "consumed" };

    // Printable characters
    if (data.length === 1 && data >= " " && data <= "~") {
      this.query += data;
      this.selectedIndex = 0;
      this.refilter();
      return { type: "consumed" };
    }

    // Anything else — consume silently
    return { type: "consumed" };
  }

  private refilter(): void {
    const source = this.sublistParent
      ? (this.sublistParent.sublist ?? []).map((opt) => ({
          id: opt.id,
          label: opt.label,
          category: opt.current ? "current" : "",
        } as PaletteCommand))
      : this.commands;

    if (this.query.length === 0) {
      this.filtered = source.map((cmd) => ({
        command: cmd,
        match: { score: 0, indices: [] },
      }));
      return;
    }

    const matches: FilteredItem[] = [];
    for (const cmd of source) {
      const match = fuzzyMatch(this.query, cmd.label);
      if (match) {
        matches.push({ command: cmd, match });
      }
    }
    matches.sort((a, b) => b.match.score - a.match.score);
    this.filtered = matches;

    // Clamp selection
    if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = Math.max(0, this.filtered.length - 1);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/command-palette.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/command-palette.ts src/__tests__/command-palette.test.ts
git commit -m "feat(command-palette): add state management and input handling"
```

---

### Task 3: Palette Grid Rendering

**Files:**
- Modify: `src/command-palette.ts`
- Modify: `src/__tests__/command-palette.test.ts`

This task adds `getGrid()` and `getHeight()` — the palette renders itself into a `CellGrid` that will later be composited by the renderer.

- [ ] **Step 1: Write failing tests for grid rendering**

Append to `src/__tests__/command-palette.test.ts`:

```typescript
describe("CommandPalette rendering", () => {
  test("getHeight returns input row + result rows + border row", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    // 4 commands + 1 input row + 1 border row = 6
    expect(palette.getHeight()).toBe(6);
  });

  test("getHeight caps at MAX_VISIBLE_RESULTS + 2", () => {
    const manyCommands: PaletteCommand[] = [];
    for (let i = 0; i < 20; i++) {
      manyCommands.push({ id: `cmd-${i}`, label: `Command ${i}`, category: "other" });
    }
    const palette = new CommandPalette();
    palette.open(manyCommands);
    // 10 visible + 1 input + 1 border = 12
    expect(palette.getHeight()).toBe(12);
  });

  test("getGrid returns grid with correct dimensions", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const grid = palette.getGrid(60);
    expect(grid.cols).toBe(60);
    expect(grid.rows).toBe(palette.getHeight());
  });

  test("getGrid input row shows prompt and query", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("s");
    palette.handleInput("p");
    const grid = palette.getGrid(60);
    // Row 0: "▷ sp" — prompt at col 0, space at col 1, query starts at col 2
    expect(grid.cells[0][0].char).toBe("▷");
    expect(grid.cells[0][2].char).toBe("s");
    expect(grid.cells[0][3].char).toBe("p");
  });

  test("getGrid shows selected row indicator", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const grid = palette.getGrid(60);
    // Row 1 (first result) should have "▸" at col 1
    expect(grid.cells[1][1].char).toBe("▸");
  });

  test("getGrid shows category tags right-aligned", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const grid = palette.getGrid(60);
    // First result is "Split horizontal" category "pane"
    // "pane" is 4 chars, right-aligned with 1 col padding = col 60-4-1 = 55
    expect(grid.cells[1][55].char).toBe("p");
    expect(grid.cells[1][56].char).toBe("a");
    expect(grid.cells[1][57].char).toBe("n");
    expect(grid.cells[1][58].char).toBe("e");
  });

  test("getGrid border row shows horizontal line", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const grid = palette.getGrid(60);
    const borderRow = palette.getHeight() - 1;
    expect(grid.cells[borderRow][0].char).toBe("─");
  });

  test("getGrid sublist shows breadcrumb in input row", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    // Navigate to "Sidebar width" (index 3) and drill in
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\r");
    const grid = palette.getGrid(60);
    // Input row should show "Sidebar width › "
    expect(grid.cells[0][0].char).toBe("S");
    expect(grid.cells[0][1].char).toBe("i");
  });

  test("getGrid shows no matches message", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("z");
    palette.handleInput("z");
    palette.handleInput("z");
    const grid = palette.getGrid(60);
    // Should show "No matches" in results area — height is input + 1 result row + border = 3
    expect(palette.getHeight()).toBe(3);
    // Row 1 should contain "No matches"
    const row1text = grid.cells[1].map(c => c.char).join("").trim();
    expect(row1text).toContain("No matches");
  });

  test("getCursorCol returns correct position", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    expect(palette.getCursorCol()).toBe(2); // "▷ " = 2
    palette.handleInput("a");
    palette.handleInput("b");
    expect(palette.getCursorCol()).toBe(4); // "▷ ab" = 4
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/command-palette.test.ts`
Expected: FAIL — `getGrid` and `getHeight` not implemented yet.

- [ ] **Step 3: Implement `getGrid` and `getHeight`**

Add these methods to the `CommandPalette` class in `src/command-palette.ts`, and add the necessary constants at the top of the file (after the imports):

```typescript
const MAX_VISIBLE_RESULTS = 10;

const PALETTE_BG = (0x16 << 16) | (0x1b << 8) | 0x22;
const SELECTED_BG = (0x1e << 16) | (0x2a << 8) | 0x35;

const INPUT_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};

const QUERY_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};

const RESULT_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};

const SELECTED_ATTRS: CellAttrs = {
  fg: 7,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

const MATCH_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};

const SELECTED_MATCH_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bold: true,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

const CATEGORY_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};

const SELECTED_CATEGORY_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};

const BORDER_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
};

const BREADCRUMB_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};

const NO_MATCHES_ATTRS: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};

const CURRENT_TAG_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: PALETTE_BG,
  bgMode: ColorMode.RGB,
};

const SELECTED_CURRENT_TAG_ATTRS: CellAttrs = {
  fg: 2,
  fgMode: ColorMode.Palette,
  dim: true,
  bg: SELECTED_BG,
  bgMode: ColorMode.RGB,
};
```

Then add these methods to the `CommandPalette` class:

```typescript
  getHeight(): number {
    const resultRows = this.filtered.length === 0
      ? 1 // "No matches" row
      : Math.min(this.filtered.length, MAX_VISIBLE_RESULTS);
    return 1 + resultRows + 1; // input + results + border
  }

  getGrid(width: number): CellGrid {
    const height = this.getHeight();
    const grid = createGrid(width, height);

    // Fill background
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        grid.cells[y][x].bg = PALETTE_BG;
        grid.cells[y][x].bgMode = ColorMode.RGB;
      }
    }

    // Input row (row 0)
    if (this.sublistParent) {
      const breadcrumb = this.sublistParent.label + " › ";
      writeString(grid, 0, 0, breadcrumb, BREADCRUMB_ATTRS);
      writeString(grid, 0, breadcrumb.length, this.query, QUERY_ATTRS);
    } else {
      writeString(grid, 0, 0, "▷", INPUT_ATTRS);
      writeString(grid, 0, 2, this.query, QUERY_ATTRS);
    }

    // Result rows
    if (this.filtered.length === 0) {
      writeString(grid, 1, 3, "No matches", NO_MATCHES_ATTRS);
    } else {
      const visibleCount = Math.min(this.filtered.length, MAX_VISIBLE_RESULTS);
      for (let i = 0; i < visibleCount; i++) {
        const row = i + 1;
        const item = this.filtered[i];
        const isSelected = i === this.selectedIndex;

        // Selected row background
        if (isSelected) {
          for (let x = 0; x < width; x++) {
            grid.cells[row][x].bg = SELECTED_BG;
            grid.cells[row][x].bgMode = ColorMode.RGB;
          }
        }

        // Selection indicator
        if (isSelected) {
          writeString(grid, row, 1, "▸", isSelected ? SELECTED_ATTRS : RESULT_ATTRS);
        }

        // Label with match highlighting — cell by cell
        const label = this.truncateLabel(item.command.label, width, item.command.category);
        const matchSet = new Set(item.match.indices);
        const labelStart = 3;
        for (let ci = 0; ci < label.length; ci++) {
          const col = labelStart + ci;
          if (col >= width) break;
          const isMatch = matchSet.has(ci);
          const cell = grid.cells[row][col];
          cell.char = label[ci];
          if (isSelected) {
            Object.assign(cell, isMatch ? { ...SELECTED_MATCH_ATTRS } : { ...SELECTED_ATTRS });
          } else {
            Object.assign(cell, isMatch ? { ...MATCH_ATTRS } : { ...RESULT_ATTRS });
          }
        }

        // Category tag (right-aligned) — or "current" tag in sublist mode
        const tag = this.sublistParent && item.command.category === "current"
          ? "current"
          : this.sublistParent ? "" : item.command.category;
        if (tag) {
          const tagCol = width - tag.length - 1;
          if (tagCol > labelStart + label.length) {
            const tagAttrs = tag === "current"
              ? (isSelected ? SELECTED_CURRENT_TAG_ATTRS : CURRENT_TAG_ATTRS)
              : (isSelected ? SELECTED_CATEGORY_ATTRS : CATEGORY_ATTRS);
            writeString(grid, row, tagCol, tag, tagAttrs);
          }
        }
      }
    }

    // Border row (last row)
    const borderRow = height - 1;
    for (let x = 0; x < width; x++) {
      grid.cells[borderRow][x].bg = 0;
      grid.cells[borderRow][x].bgMode = ColorMode.Default;
    }
    writeString(grid, borderRow, 0, "─".repeat(width), BORDER_ATTRS);

    return grid;
  }

  private truncateLabel(label: string, width: number, category: string): string {
    const tagReserved = category ? category.length + 3 : 1; // tag + spacing
    const maxLen = width - 3 - tagReserved; // 3 = left padding "▸ "
    if (label.length > maxLen) {
      return label.slice(0, maxLen - 1) + "…";
    }
    return label;
  }
```

Note: for `Object.assign` to work properly with `CellAttrs` on `Cell`, spread the attrs explicitly. The cell already has the right structure from `createGrid`. Assign individual properties:

Replace the `Object.assign` calls with direct property setting using a helper:

```typescript
// Add as a private method or local helper at the top of the file:
function applyCellAttrs(cell: Cell, attrs: CellAttrs): void {
  if (attrs.fg !== undefined) cell.fg = attrs.fg;
  if (attrs.bg !== undefined) cell.bg = attrs.bg;
  if (attrs.fgMode !== undefined) cell.fgMode = attrs.fgMode;
  if (attrs.bgMode !== undefined) cell.bgMode = attrs.bgMode;
  if (attrs.bold !== undefined) cell.bold = attrs.bold;
  if (attrs.italic !== undefined) cell.italic = attrs.italic;
  if (attrs.underline !== undefined) cell.underline = attrs.underline;
  if (attrs.dim !== undefined) cell.dim = attrs.dim;
}
```

Then replace the `Object.assign` calls in the cell-by-cell rendering:

```typescript
        for (let ci = 0; ci < label.length; ci++) {
          const col = labelStart + ci;
          if (col >= width) break;
          const isMatch = matchSet.has(ci);
          const cell = grid.cells[row][col];
          cell.char = label[ci];
          applyCellAttrs(cell, isSelected
            ? (isMatch ? SELECTED_MATCH_ATTRS : SELECTED_ATTRS)
            : (isMatch ? MATCH_ATTRS : RESULT_ATTRS));
        }
```

Also add the `Cell` import to the top of the file:

```typescript
import type { PaletteCommand, PaletteSublistOption, PaletteResult, PaletteAction, Cell } from "./types";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/command-palette.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/command-palette.ts src/__tests__/command-palette.test.ts
git commit -m "feat(command-palette): add grid rendering with match highlighting"
```

---

### Task 4: InputRouter Palette Mode

**Files:**
- Modify: `src/input-router.ts`
- Modify: `src/__tests__/input-router.test.ts`

Add palette mode to the InputRouter — when open, keyboard input routes to a palette callback instead of the PTY.

- [ ] **Step 1: Write failing tests for palette mode**

Append to `src/__tests__/input-router.test.ts`:

```typescript
describe("palette mode", () => {
  test("routes keyboard input to onPaletteInput when palette is open", () => {
    let paletteData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onPaletteInput: (d) => { paletteData += d; },
      },
      true,
    );
    router.setPaletteOpen(true);
    router.handleInput("hello");
    expect(paletteData).toBe("hello");
    expect(ptyData).toBe("");
  });

  test("still sends Ctrl-Shift arrows to session handlers when palette is open", () => {
    let prevCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPaletteInput: () => {},
        onSessionPrev: () => { prevCalled = true; },
      },
      true,
    );
    router.setPaletteOpen(true);
    router.handleInput("\x1b[1;6A");
    expect(prevCalled).toBe(true);
  });

  test("sidebar clicks still work when palette is open", () => {
    let clickedRow = -1;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: (row) => { clickedRow = row; },
        onPaletteInput: () => {},
      },
      true,
    );
    router.setPaletteOpen(true);
    // Simulate left-click at sidebar col 5, row 3
    router.handleInput("\x1b[<0;5;3M");
    expect(clickedRow).toBe(2); // 0-indexed
  });

  test("toolbar clicks are ignored when palette is open", () => {
    let toolbarClicked = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPaletteInput: () => {},
        onToolbarClick: () => { toolbarClicked = true; },
      },
      true,
    );
    router.setPaletteOpen(true);
    // Simulate click on toolbar row (y=1) in main area
    router.handleInput("\x1b[<0;30;1M");
    expect(toolbarClicked).toBe(false);
  });

  test("main area mouse events are ignored when palette is open", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onPaletteInput: () => {},
      },
      true,
    );
    router.setPaletteOpen(true);
    // Simulate click in main area
    router.handleInput("\x1b[<0;30;5M");
    expect(ptyData).toBe("");
  });

  test("routes to PTY when palette is closed", () => {
    let ptyData = "";
    let paletteData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onPaletteInput: (d) => { paletteData += d; },
      },
      true,
    );
    router.setPaletteOpen(true);
    router.setPaletteOpen(false);
    router.handleInput("hello");
    expect(ptyData).toBe("hello");
    expect(paletteData).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: FAIL — `setPaletteOpen` and `onPaletteInput` don't exist.

- [ ] **Step 3: Implement palette mode in InputRouter**

In `src/input-router.ts`, add `onPaletteInput` to `InputRouterOptions`:

```typescript
export interface InputRouterOptions {
  sidebarCols: number;
  onPtyData: (data: string) => void;
  onSidebarClick: (row: number) => void;
  onSidebarScroll?: (delta: number) => void;
  onToolbarClick?: (col: number) => void;
  onHover?: (target: { area: "sidebar"; row: number } | { area: "toolbar"; col: number } | null) => void;
  onSessionPrev?: () => void;
  onSessionNext?: () => void;
  onPaletteInput?: (data: string) => void;
}
```

Add `paletteOpen` state and `setPaletteOpen` method to the class:

```typescript
export class InputRouter {
  private opts: InputRouterOptions;
  private sidebarVisible: boolean;
  private paletteOpen = false;

  constructor(opts: InputRouterOptions, sidebarVisible: boolean) {
    this.opts = opts;
    this.sidebarVisible = sidebarVisible;
  }

  setSidebarVisible(visible: boolean): void {
    this.sidebarVisible = visible;
  }

  setPaletteOpen(open: boolean): void {
    this.paletteOpen = open;
  }
```

Modify `handleInput` — after the Ctrl-Shift arrow checks (which remain global), add palette routing before the mouse/PTY passthrough:

```typescript
  handleInput(data: string): void {
    // Always-active hotkeys: Ctrl-Shift-Up/Down for session switching
    if (data === "\x1b[1;6A") {
      this.opts.onSessionPrev?.();
      return;
    }
    if (data === "\x1b[1;6B") {
      this.opts.onSessionNext?.();
      return;
    }

    // Check for SGR mouse events
    const mouse = parseSgrMouse(data);

    // Palette mode: route keyboard to palette, allow sidebar mouse, block rest
    if (this.paletteOpen) {
      if (mouse && this.sidebarVisible) {
        const isMotion = (mouse.button & 32) !== 0;
        const isWheel = (mouse.button & 64) !== 0;
        if (mouse.x <= this.opts.sidebarCols) {
          if (isWheel) {
            const delta = (mouse.button & 1) ? 3 : -3;
            this.opts.onSidebarScroll?.(delta);
            return;
          }
          if (!mouse.release && !isMotion) {
            this.opts.onSidebarClick(mouse.y - 1);
          }
          return;
        }
        return; // Ignore toolbar and main area mouse events
      }
      if (!mouse) {
        this.opts.onPaletteInput?.(data);
      }
      return;
    }

    // ... rest of existing handleInput unchanged (mouse handling + PTY passthrough)
```

The full method is: global hotkeys → palette mode check → existing mouse/PTY logic.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/input-router.ts src/__tests__/input-router.test.ts
git commit -m "feat(command-palette): add palette mode to InputRouter"
```

---

### Task 5: Renderer Overlay Compositing

**Files:**
- Modify: `src/renderer.ts`
- Modify: `src/__tests__/renderer.test.ts`

Modify `compositeGrids` to accept and composite a palette overlay grid, and update `render` for palette cursor positioning.

- [ ] **Step 1: Write failing tests for palette overlay**

Append to `src/__tests__/renderer.test.ts`:

```typescript
describe("compositeGrids with palette overlay", () => {
  test("palette replaces toolbar row", () => {
    const sidebar = createGrid(4, 4);
    const main = createGrid(10, 3);
    writeString(main, 0, 0, "main line1");

    // Minimal toolbar config
    const toolbar = {
      buttons: [],
      mainCols: 10,
      tabs: [],
    };

    // Palette grid: 2 rows (input + border), 10 cols
    const palette = createGrid(10, 2);
    writeString(palette, 0, 0, "▷ query");
    writeString(palette, 1, 0, "──────────");

    const result = compositeGrids(main, sidebar, toolbar, palette);
    // Row 0: sidebar + border + palette row 0
    // Palette input line should replace toolbar
    expect(result.cells[0][5].char).toBe("▷"); // col 5 = sidebar(4) + border(1) + palette col 0
  });

  test("palette overlays main content rows", () => {
    const sidebar = createGrid(4, 5);
    const main = createGrid(10, 4);
    writeString(main, 0, 0, "visible");
    writeString(main, 1, 0, "covered");

    const toolbar = {
      buttons: [],
      mainCols: 10,
      tabs: [],
    };

    // 3-row palette: input + 1 result + border
    const palette = createGrid(10, 3);
    writeString(palette, 0, 0, "▷ input");
    writeString(palette, 1, 0, " result");
    writeString(palette, 2, 0, "──────────");

    const result = compositeGrids(main, sidebar, toolbar, palette);
    // Row 0 (toolbar) → palette row 0
    expect(result.cells[0][5].char).toBe("▷");
    // Row 1 (main row 0) → palette row 1 (overlaid)
    expect(result.cells[1][6].char).toBe("r"); // " result" at col 1
    // Row 2 (main row 1) → palette row 2 (border)
    expect(result.cells[2][5].char).toBe("─");
    // Row 3 (main row 2) → normal main content
    // (main row 2 was empty, so it's spaces)
  });

  test("palette null falls back to normal toolbar", () => {
    const sidebar = createGrid(4, 3);
    const main = createGrid(10, 2);

    const toolbar = {
      buttons: [{ label: "＋", id: "new" }],
      mainCols: 10,
      tabs: [],
    };

    const result = compositeGrids(main, sidebar, toolbar, null);
    // Toolbar should render normally — find the ＋ button
    // Button is right-aligned: "＋" = 2 display cols + 2 padding = 4
    // At mainCols(10) - 4 = col 6, offset by sidebar(4)+border(1) = col 11
    // Just verify it's not broken — toolbar row has content
    expect(result.rows).toBe(3); // 2 main + 1 toolbar
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/renderer.test.ts`
Expected: FAIL — `compositeGrids` doesn't accept a 4th argument yet.

- [ ] **Step 3: Modify `compositeGrids` to accept palette overlay**

In `src/renderer.ts`, update the function signature:

```typescript
export function compositeGrids(
  main: CellGrid,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  paletteOverlay?: CellGrid | null,
): CellGrid {
```

In the compositing loop, replace the toolbar row rendering block and add overlay logic. The existing code at `if (toolbar && y === 0)` needs to branch:

```typescript
    if (toolbar && y === 0) {
      if (paletteOverlay) {
        // Palette row 0 replaces toolbar
        for (let x = 0; x < paletteOverlay.cols && x < (toolbar.mainCols); x++) {
          grid.cells[0][borderCol + 1 + x] = { ...paletteOverlay.cells[0][x] };
        }
      } else {
        // Existing toolbar rendering code (tabs + buttons) — unchanged
        // ... all the existing tab/button rendering ...
      }
    } else {
      // Main content — offset by toolbar row
      const mainY = toolbar ? y - 1 : y;
      if (mainY >= 0 && mainY < main.rows) {
        // Check if this row should be overlaid by the palette
        if (paletteOverlay && toolbar && y < paletteOverlay.rows) {
          // Palette overlay row
          for (let x = 0; x < paletteOverlay.cols && x < (toolbar.mainCols); x++) {
            grid.cells[y][borderCol + 1 + x] = { ...paletteOverlay.cells[y][x] };
          }
        } else {
          for (let x = 0; x < main.cols; x++) {
            grid.cells[y][borderCol + 1 + x] = { ...main.cells[mainY][x] };
          }
        }
      }
    }
```

- [ ] **Step 4: Update `Renderer.render` for palette cursor positioning**

In the `render` method, update the cursor positioning at the end:

```typescript
  render(
    main: CellGrid,
    cursor: CursorPosition,
    sidebar: CellGrid | null,
    toolbar?: ToolbarConfig | null,
    paletteCursor?: { col: number } | null,
  ): void {
    const grid = compositeGrids(main, sidebar, toolbar,
      paletteCursor ? undefined : null); // placeholder — actual palette grid passed via compositeGrids
```

Actually, cleaner approach: pass the palette grid through `compositeGrids` and the cursor separately to `render`. Update the signature:

```typescript
  render(
    main: CellGrid,
    cursor: CursorPosition,
    sidebar: CellGrid | null,
    toolbar?: ToolbarConfig | null,
    paletteOverlay?: CellGrid | null,
    paletteCursorCol?: number | null,
  ): void {
    const grid = compositeGrids(main, sidebar, toolbar, paletteOverlay);
    const cursorOffset = sidebar ? sidebar.cols + 1 : 0;
    const buf: string[] = [];

    // ... existing row rendering loop unchanged ...

    // Reset attributes, position cursor
    const cursorRowOffset = toolbar ? 1 : 0;
    buf.push("\x1b[0m");
    if (paletteCursorCol != null) {
      // Palette cursor: row 1 (first screen row), column offset by sidebar
      buf.push(`\x1b[1;${paletteCursorCol + cursorOffset + 1}H`);
    } else {
      buf.push(
        `\x1b[${cursor.y + cursorRowOffset + 1};${cursor.x + cursorOffset + 1}H`,
      );
    }

    process.stdout.write(buf.join(""));
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/__tests__/renderer.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Run all existing tests to check nothing is broken**

Run: `bun test`
Expected: All tests PASS. The existing `compositeGrids` calls still work since the new parameter is optional.

- [ ] **Step 7: Commit**

```bash
git add src/renderer.ts src/__tests__/renderer.test.ts
git commit -m "feat(command-palette): add palette overlay compositing to renderer"
```

---

### Task 6: SIGUSR1 Signal and Tmux Keybinding

**Files:**
- Modify: `src/main.ts`
- Modify: `config/defaults.conf`

Wire up the signal handler and tmux keybinding so `Ctrl-a p` triggers the palette toggle.

- [ ] **Step 1: Set `JMUX_PID` in tmux environment**

In `src/main.ts`, in the `start()` function, after the existing `set-environment` calls (around line 873), add:

```typescript
  await control.sendCommand(`set-environment -g JMUX_PID ${process.pid}`);
```

- [ ] **Step 2: Add SIGUSR1 handler**

In `src/main.ts`, after the `inputRouter` definition (around line 525), add:

```typescript
// --- Command Palette ---
// Note: add `import { CommandPalette } from "./command-palette";` to the top-level
// imports at the top of main.ts, alongside the other imports.

const palette = new CommandPalette();

function togglePalette(): void {
  if (palette.isOpen()) {
    closePalette();
  } else {
    openPalette();
  }
}

function openPalette(): void {
  const commands = buildPaletteCommands();
  palette.open(commands);
  inputRouter.setPaletteOpen(true);
  renderFrame();
}

function closePalette(): void {
  palette.close();
  inputRouter.setPaletteOpen(false);
  renderFrame();
}

process.on("SIGUSR1", () => {
  togglePalette();
});
```

Note: the `buildPaletteCommands` function and `renderFrame` integration will be completed in Task 7. For now, add a stub:

```typescript
function buildPaletteCommands(): import("./types").PaletteCommand[] {
  return []; // populated in Task 7
}
```

- [ ] **Step 3: Bind `Ctrl-a p` in tmux config**

In `config/defaults.conf`, replace line 9 (`unbind p  # free up for future use`) with:

```tmux
bind-key p run-shell -b "kill -USR1 $JMUX_PID"
```

- [ ] **Step 4: Add palette input routing callback**

In `src/main.ts`, add `onPaletteInput` to the `InputRouter` constructor options:

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
        case "execute":
          closePalette();
          handlePaletteAction(action.result);
          break;
      }
    },
```

Add the `handlePaletteAction` stub (completed in Task 7):

```typescript
function handlePaletteAction(result: import("./types").PaletteResult): void {
  // Dispatch actions — implemented in Task 7
}
```

- [ ] **Step 5: Close palette on resize**

In the `SIGWINCH` handler in `src/main.ts`, add before the existing resize logic:

```typescript
  if (palette.isOpen()) {
    closePalette();
  }
```

- [ ] **Step 6: Update `renderFrame` to pass palette grid**

Modify `renderFrame()` in `src/main.ts`:

```typescript
function renderFrame(): void {
  const grid = bridge.getGrid();
  const cursor = bridge.getCursor();
  const tb = toolbarEnabled ? makeToolbar() : null;
  const paletteGrid = palette.isOpen() ? palette.getGrid(mainCols) : null;
  const paletteCursorCol = palette.isOpen() ? palette.getCursorCol() : null;
  renderer.render(
    grid, cursor,
    sidebarShown ? sidebar.getGrid() : null,
    tb,
    paletteGrid,
    paletteCursorCol,
  );
}
```

- [ ] **Step 7: Build and verify**

Run: `bun build src/main.ts --outdir dist --target bun`
Expected: Build succeeds with no errors.

- [ ] **Step 8: Commit**

```bash
git add src/main.ts config/defaults.conf
git commit -m "feat(command-palette): wire up SIGUSR1 signal and keybinding"
```

---

### Task 7: Command Registry and Action Dispatch

**Files:**
- Modify: `src/main.ts`

This task populates `buildPaletteCommands` with all commands from the spec and implements `handlePaletteAction` to dispatch each action.

- [ ] **Step 1: Implement `buildPaletteCommands`**

Replace the stub in `src/main.ts`:

```typescript
function buildPaletteCommands(): import("./types").PaletteCommand[] {
  const commands: import("./types").PaletteCommand[] = [];

  // Dynamic: switch to session (excluding current)
  for (const session of currentSessions) {
    if (session.id === currentSessionId) continue;
    commands.push({
      id: `switch-session:${session.id}`,
      label: `Switch to ${session.name}`,
      category: "session",
    });
  }

  // Dynamic: switch to window (excluding active)
  for (const win of currentWindows) {
    if (win.active) continue;
    commands.push({
      id: `switch-window:${win.windowId}`,
      label: `Switch to ${win.name}`,
      category: "window",
    });
  }

  // Static commands
  commands.push(
    { id: "new-session", label: "New session", category: "session" },
    { id: "kill-session", label: "Kill session", category: "session" },
    { id: "rename-session", label: "Rename session", category: "session" },
    { id: "new-window", label: "New window", category: "window" },
    { id: "close-window", label: "Close window", category: "window" },
    { id: "move-window", label: "Move window to session", category: "window" },
    { id: "split-h", label: "Split horizontal", category: "pane" },
    { id: "split-v", label: "Split vertical", category: "pane" },
    { id: "zoom-pane", label: "Zoom pane", category: "pane" },
    { id: "close-pane", label: "Close pane", category: "pane" },
    { id: "window-picker", label: "Window picker", category: "other" },
    { id: "open-claude", label: "Open Claude", category: "other" },
  );

  // Settings with sub-lists
  const currentWidth = sidebarWidth;
  commands.push({
    id: "setting-sidebar-width",
    label: "Sidebar width",
    category: "setting",
    sublist: [20, 22, 24, 26, 28, 30, 34].map((w) => ({
      id: String(w),
      label: String(w),
      current: w === currentWidth,
    })),
  });

  commands.push({
    id: "setting-claude-command",
    label: "Claude command",
    category: "setting",
    sublist: [
      { id: "claude", label: "claude", current: claudeCommand === "claude" },
      { id: "claude --dangerously-skip-permissions", label: "claude --dangerously-skip-permissions", current: claudeCommand === "claude --dangerously-skip-permissions" },
    ],
  });

  // Project directories — falls back to settings popup for complex editing
  commands.push({
    id: "setting-project-dirs",
    label: "Project directories",
    category: "setting",
  });

  return commands;
}
```

- [ ] **Step 2: Implement `handlePaletteAction`**

Replace the stub:

```typescript
async function handlePaletteAction(result: import("./types").PaletteResult): Promise<void> {
  const { commandId, sublistOptionId } = result;

  // Dynamic commands
  if (commandId.startsWith("switch-session:")) {
    const sessionId = commandId.slice("switch-session:".length);
    await switchSession(sessionId);
    return;
  }
  if (commandId.startsWith("switch-window:")) {
    const windowId = commandId.slice("switch-window:".length);
    await handleTabClick(windowId);
    return;
  }

  // Setting commands with sub-list values
  if (commandId === "setting-sidebar-width" && sublistOptionId) {
    const newWidth = parseInt(sublistOptionId, 10);
    if (!isNaN(newWidth)) {
      await applySetting("sidebarWidth", newWidth, "number");
    }
    return;
  }
  if (commandId === "setting-claude-command" && sublistOptionId) {
    await applySetting("claudeCommand", sublistOptionId, "string");
    return;
  }

  // Static commands — reuse existing handlers
  if (!ptyClientName) await resolveClientName();
  if (!ptyClientName) return;

  switch (commandId) {
    case "new-session":
      handleToolbarAction("settings"); // reuse settings popup for now — actually launch new-session popup
      // Better: launch the new-session popup directly
      Bun.spawn(["tmux", ...(socketName ? ["-L", socketName] : []),
        "display-popup", "-c", ptyClientName, "-E", "-w", "60%", "-h", "70%",
        "-b", "heavy", "-S", "fg=#4f565d", resolve(jmuxDir, "config", "new-session.sh")],
        { stdout: "ignore", stderr: "ignore" });
      return;
    case "kill-session":
      await control.sendCommand(`kill-session -t '${currentSessionId}'`);
      return;
    case "rename-session":
      Bun.spawn(["tmux", ...(socketName ? ["-L", socketName] : []),
        "display-popup", "-c", ptyClientName, "-E", "-w", "40%", "-h", "8",
        "-b", "heavy", "-S", "fg=#4f565d", resolve(jmuxDir, "config", "rename-session.sh")],
        { stdout: "ignore", stderr: "ignore" });
      return;
    case "new-window":
      await handleToolbarAction("new-window");
      return;
    case "close-window":
      await control.sendCommand(`kill-window`);
      fetchWindows();
      return;
    case "move-window":
      Bun.spawn(["tmux", ...(socketName ? ["-L", socketName] : []),
        "display-popup", "-c", ptyClientName, "-E", "-w", "40%", "-h", "50%",
        "-b", "heavy", "-S", "fg=#4f565d", resolve(jmuxDir, "config", "move-window.sh")],
        { stdout: "ignore", stderr: "ignore" });
      return;
    case "split-h":
      await handleToolbarAction("split-h");
      return;
    case "split-v":
      await handleToolbarAction("split-v");
      return;
    case "zoom-pane":
      await control.sendCommand("resize-pane -Z");
      fetchWindows();
      return;
    case "close-pane":
      await control.sendCommand("kill-pane");
      return;
    case "window-picker":
      Bun.spawn(["tmux", ...(socketName ? ["-L", socketName] : []),
        "display-popup", "-c", ptyClientName, "-E", "-x", "0", "-y", "0", "-w", "30%", "-h", "100%",
        "-b", "heavy", "-S", "fg=#4f565d",
        "sh", "-c", `tmux list-windows -F '#I: #W#{?window_active, *, }' | fzf --reverse --no-info --prompt=' Window> ' --pointer='▸' --color='bg:#0c1117,fg:#6b7280,hl:#fbd4b8,fg+:#b5bcc9,hl+:#fbd4b8,pointer:#9fe8c3,prompt:#9fe8c3' | cut -d: -f1 | xargs -I{} tmux select-window -t :{}`],
        { stdout: "ignore", stderr: "ignore" });
      return;
    case "open-claude":
      await handleToolbarAction("claude");
      return;
    case "setting-project-dirs":
      // Complex setting — fall back to settings popup
      Bun.spawn(["tmux", ...(socketName ? ["-L", socketName] : []),
        "display-popup", "-c", ptyClientName, "-E", "-w", "50%", "-h", "40%",
        "-b", "heavy", "-S", "fg=#4f565d", resolve(jmuxDir, "config", "settings.sh")],
        { stdout: "ignore", stderr: "ignore" });
      return;
  }
}
```

- [ ] **Step 3: Add `applySetting` helper**

Add this helper function near the other helpers in `src/main.ts`:

```typescript
async function applySetting(key: string, value: string | number, type: string): Promise<void> {
  const configPath = resolve(homedir(), ".config", "jmux", "config.json");
  try {
    let config: Record<string, any> = {};
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    }
    if (type === "number") {
      config[key] = typeof value === "number" ? value : parseInt(String(value), 10);
    } else {
      config[key] = value;
    }
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    // Config file watcher will pick up the change and trigger resize/reload
  } catch {
    // Non-critical — settings may not save
  }
}
```

- [ ] **Step 4: Build and verify**

Run: `bun build src/main.ts --outdir dist --target bun`
Expected: Build succeeds.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(command-palette): add command registry and action dispatch"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/cheat-sheet.md`
- Modify: `docs/getting-started.md`
- Modify: `src/main.ts` (HELP constant)

Add `Ctrl-a p` (Command palette) to all documentation.

- [ ] **Step 1: Update README.md**

In the Utilities section of the keybindings table, add a row:

```markdown
| `Ctrl-a p` | Command palette |
```

- [ ] **Step 2: Update docs/cheat-sheet.md**

In the Utilities section, add:

```markdown
| `Ctrl-a p` | Command palette (fuzzy search all actions) |
```

- [ ] **Step 3: Update docs/getting-started.md**

In the Utilities section of essential keybindings, add:

```markdown
| Command palette | `Ctrl-a` then `p` |
```

In the tips section, add:

```markdown
- **Command palette** (`Ctrl-a` then `p`) lets you fuzzy-search sessions, windows, pane actions, and settings — like Raycast for your terminal
```

- [ ] **Step 4: Update HELP constant in src/main.ts**

Add to the Keybindings section:

```
  Ctrl-a p                 Command palette
```

- [ ] **Step 5: Build**

Run: `bun build src/main.ts --outdir dist --target bun`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/cheat-sheet.md docs/getting-started.md src/main.ts
git commit -m "docs: add command palette keybinding to all documentation"
```

---

### Task 9: Manual Integration Testing

**Files:** None (testing only)

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS.

- [ ] **Step 2: Build and run**

```bash
bun build src/main.ts --outdir dist --target bun
bun dist/main.js
```

- [ ] **Step 3: Test open/close**

1. Press `Ctrl-a p` — palette should appear replacing the toolbar, with all commands listed
2. Press `Escape` — palette should close, toolbar should reappear
3. Press `Ctrl-a p` again, then `Ctrl-a p` — should toggle closed

- [ ] **Step 4: Test fuzzy search**

1. Open palette, type "split" — should show "Split horizontal" and "Split vertical"
2. Type "nw" — should show "New window"
3. Backspace to clear, verify all commands reappear

- [ ] **Step 5: Test navigation and execution**

1. Use arrow keys to navigate results, verify selection indicator moves
2. Select "New window" and press Enter — new window should be created
3. Open palette, select "Zoom pane" — pane should zoom, tab should show ⤢
4. Select a "Switch to..." session — should switch sessions

- [ ] **Step 6: Test settings sub-list**

1. Open palette, type "sidebar", select "Sidebar width"
2. Verify breadcrumb shows "Sidebar width ›"
3. Select a different width value
4. Verify sidebar width changes (config file watcher triggers resize)
5. Press Escape in sub-list to verify it returns to main list

- [ ] **Step 7: Test edge cases**

1. Resize terminal while palette is open — palette should close
2. Open palette with many sessions — verify all appear as switch targets
3. Type a query with no matches — verify "No matches" message appears
