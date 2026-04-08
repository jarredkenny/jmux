# Native Modal System

Replace all tmux popup modals (fzf shell scripts via `display-popup`) with native jmux modals drawn and managed directly by the renderer, consistent with the command palette.

## Motivation

The current modals shell out to tmux `display-popup` running fzf-based bash scripts. This creates several problems:

- Dependency on fzf for basic UI interactions
- Modals render inside tmux's popup layer, outside jmux's rendering pipeline — subject to the same width-disagreement bugs as pane content
- No back-navigation in multi-step flows (Esc exits entirely)
- Visual inconsistency between the command palette (native) and other modals (fzf)
- Shell scripts are harder to test and maintain than TypeScript

## Architecture

### Modal Interface

All modals (including the existing CommandPalette) share a common interface. No base class — just a TypeScript interface that CommandPalette already satisfies by duck typing.

```typescript
// modal.ts

export type ModalAction =
  | { type: "consumed" }               // input processed, re-render
  | { type: "closed" }                 // dismissed, no result
  | { type: "result"; value: unknown } // completed with typed result

export interface Modal {
  isOpen(): boolean;
  preferredWidth(termCols: number): number;
  getGrid(width: number): CellGrid;
  getCursorPosition(): { row: number; col: number } | null;
  handleInput(data: string): ModalAction;
  close(): void;
}
```

### Integration with main.ts

Replace the palette-specific wiring with a generic `activeModal` slot:

```typescript
let activeModal: Modal | null = null;
```

The renderer, input router, and overlay compositing all operate on `activeModal` instead of `palette` directly. The command palette becomes one modal among many — opened via `activeModal = palette`, closed by setting `activeModal = null`.

When a palette command needs a follow-up modal (e.g., rename opens an InputModal), the palette closes and the new modal opens in its place.

The overlay rendering in `compositeGrids` does not change — it already accepts any `CellGrid`. The only wiring change is in main.ts: `palette.isOpen()` / `palette.handleInput()` become `activeModal?.isOpen()` / `activeModal?.handleInput()`.

**Width sizing:** Each modal owns its preferred width via `preferredWidth(termCols)`. main.ts calls this before `getGrid()`:

```typescript
const width = activeModal.preferredWidth(process.stdout.columns || 80);
const grid = activeModal.getGrid(width);
```

This keeps sizing logic next to the modal that understands its own layout, rather than accumulating width formulas in main.ts.

**Renderer renames:** The renderer's palette-specific parameter names become modal-generic to reflect that any modal can use the overlay slot:

| Current | Renamed to |
|---|---|
| `compositeGrids(..., paletteOverlay)` | `compositeGrids(..., modalOverlay)` |
| `Renderer.render(..., paletteOverlay, paletteCursor)` | `Renderer.render(..., modalOverlay, modalCursor)` |
| `getPalettePosition(...)` | `getModalPosition(...)` |

`getCursorPosition()` returns `{ row, col }` relative to the modal content grid, or `null` for modals with no text cursor. main.ts adds the overlay position offset (same as it does for the palette today).

**Result handling via callback:** When opening a modal, main.ts stores a result callback alongside it. This avoids needing to track "which modal is this for" — each call site provides its own handler:

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

Usage at each call site:

```typescript
// Rename session
const modal = new InputModal({ header: "Rename Session", value: currentName });
modal.open();
openModal(modal, async (name) => {
  await control.sendCommand(`rename-session '${name}'`);
});

// Command palette — same slot, palette-specific handler
palette.open(buildPaletteCommands());
openModal(palette, (result) => {
  handlePaletteAction(result as PaletteResult);
});
```

The palette's `PaletteAction` type changes from `{ type: "execute"; result }` to `{ type: "result"; value }` to match the shared `ModalAction` type. This is a rename, not a behavior change.

### Shared Constants

`modal.ts` exports the shared color constants used by all modals:

- `MODAL_BG`: `#161b22` (matches palette)
- `SELECTED_BG`: `#1e2a35` (matches palette)
- Standard attribute sets for headers, subheaders, input lines, dim text, match highlighting

These are currently defined in `command-palette.ts` and should be moved to `modal.ts` so all modals share them. CommandPalette imports from `modal.ts`.

## Modal Types

### InputModal

Text input field with header, optional subheader, and pre-filled value.

**Used by:** rename session, rename window, session name entry (wizard step), worktree name entry (wizard step), claude command setting, project directories setting.

**Layout (content grid):**

```
Row 0: "  Rename Session"          (header, bold)
Row 1: "  Current: my-session"     (subheader, dim) — optional
Row 2: "  > my-session_"           (input line with cursor)
```

**Constructor:**

```typescript
interface InputModalConfig {
  header: string;
  subheader?: string;
  value?: string;       // pre-filled text
  placeholder?: string; // shown when value is empty
}
```

**Result:** `string` (the entered text).

**Input handling:** Printable characters, backspace, Enter (submit if non-empty), Esc (close with no result). Same text editing behavior as the palette query field.

**Height:** 2-3 rows depending on whether subheader is present.

**`preferredWidth(termCols)`:** `Math.min(Math.max(40, Math.round(termCols * 0.45)), 60)`.

**Cursor:** Positioned on the input line at the end of the current text.

### ListModal

Fuzzy-filterable list with query input and scrollable results.

**Used by:** directory picker, move-window session picker, worktree picker, branch picker.

**Layout:**

```
Row 0:  "  Move Window"              (header, bold)
Row 1:  "  Moving: my-window -> ?"   (subheader, dim) — optional
Row 2:  "  > query_"                 (filter input with cursor)
Row 3:  "    session-alpha"           (result)
Row 4:  "  > session-beta"           (selected result)
Row 5:  "    session-gamma"           (result)
```

**Constructor:**

```typescript
interface ListModalConfig {
  header: string;
  subheader?: string;
  items: ListItem[];
  defaultQuery?: string; // pre-fill the filter
}

interface ListItem {
  id: string;
  label: string;
  annotation?: string;  // right-aligned dim text
}
```

**Result:** `ListItem` (the selected item).

**Input handling:** Same as CommandPalette — printable chars filter the list, arrow keys navigate, Enter selects, Esc closes. Reuses `fuzzyMatch` from `command-palette.ts` (already exported).

**Scroll:** Same mechanics as CommandPalette. Up to 16 visible results (MAX_VISIBLE_RESULTS). Height adapts to actual item count (header rows + min(items, 16)).

**`preferredWidth(termCols)`:** `Math.min(Math.max(40, Math.round(termCols * 0.55)), 80)` — same as palette.

**Cursor:** On the query input line.

### ContentModal

Scrollable read-only styled text viewer.

**Used by:** release notes, welcome screen.

**Layout:**

```
Row 0:     "  jmux changelog"                    (title)
Row 1:     "  ────────────────────────"           (separator)
Row 2..N:  content lines (scrolled)
Row last:  "  up/dn/jk scroll  q close     100%" (status bar, dim)
```

**Constructor:**

```typescript
interface ContentModalConfig {
  lines: StyledLine[];
  title?: string;
}

type StyledLine = StyledSegment[];

interface StyledSegment {
  text: string;
  attrs?: CellAttrs;
}
```

**Input handling:** j/k or arrow down/up (scroll one line), d/space (half page down), u (half page up), g (top), G (bottom), q/Esc (close).

**Result:** None — always closes with `{ type: "closed" }`.

**Height:** Responsive — `Math.min(termRows - 6, lines.length + 2)`, capped to leave margin.

**`preferredWidth(termCols)`:** `Math.min(Math.max(50, Math.round(termCols * 0.7)), 90)` — wider than other modals.

**Cursor:** `null` (no text cursor shown).

**Content building:** main.ts builds the `StyledLine[]` before opening the modal.

- **Release notes:** Fetch from GitHub API (`/repos/jarredkenny/jmux/releases`), format with bold headers, bullet points, dimmed dates, "current" marker. Same formatting as current `release-notes.sh` but using `CellAttrs` instead of ANSI codes.
- **Welcome:** Static `StyledLine[]` content matching current `welcome.sh` layout.

**Loading latency for release notes:** The current flow (tmux popup + shell script) hides the fetch latency because the popup appears instantly and the script renders after fetching. With native modals, main.ts must `await fetch(...)` before opening the ContentModal. This creates a visible delay (typically sub-second) where nothing appears on screen. Accept this for now — a sub-second delay on a user-initiated action is fine. If it becomes noticeable on slow connections, a future improvement could open the ContentModal immediately with a "Loading..." placeholder line and replace the content once the fetch resolves.

### NewSessionModal (Wizard)

Multi-step flow that internally composes ListModal and InputModal instances, advancing through steps as each completes.

**Step flow:**

```
Step 1: Pick directory (ListModal)
         |
         v
    bare repo? ──No──> Step 2a: Enter name (InputModal)
         |                         |
        Yes                        v
         |                     Result: { type: "standard", dir, name }
         v
Step 2b: Pick worktree (ListModal)
         |
    "+ new worktree"          existing worktree
         |                         |
         v                         v
Step 3a: Pick base branch     Result: { type: "existing_worktree", dir, path, branch }
         (ListModal)
         |
         v
Step 3b: Enter name (InputModal)
         |
         v
    Result: { type: "new_worktree", dir, baseBranch, name }
```

**Internal design:**

The wizard holds a `currentInner: ListModal | InputModal` reference for the active step and a `stepStack: Array<{ modal, stepId, data }>` for back-navigation. `getGrid()` delegates to `currentInner.getGrid()`. `handleInput()` does NOT blindly delegate — it intercepts Esc before forwarding.

**Input handling:**

```typescript
handleInput(data: string): ModalAction {
  // Intercept Esc before the inner modal sees it
  if (data === "\x1b") {
    if (this.stepStack.length === 0) {
      return { type: "closed" };  // Esc at step 1 — close wizard
    }
    // Pop previous step from stack, restore its modal
    const prev = this.stepStack.pop()!;
    this.currentInner = prev.modal;
    this.currentStep = prev.stepId;
    return { type: "consumed" };
  }

  // All other input delegates to inner modal
  const action = this.currentInner.handleInput(data);
  if (action.type === "result") {
    return this.advanceStep(action.value);
  }
  return action;
}
```

**Step transitions:** When the inner modal returns a result, the wizard pushes the current inner modal onto the stack (preserving its state for back-navigation), then creates a new inner modal for the next step. The outgoing inner modal is NOT closed — it stays on the stack with its query text, selection, and scroll position intact.

**Cleanup:** When the wizard itself closes (Esc at step 1, or final result returned), `close()` clears the entire stack. Inner modals don't hold external resources, so no explicit cleanup is needed beyond dropping the references.

**Subheader as breadcrumb:** Each step shows previous selections as context in the subheader:

```
Step 1:  header="New Session"          subheader="Search for a project directory"
Step 2b: header="New Session"          subheader="~/Code/personal/jmux"
Step 3a: header="New Session"          subheader="~/Code/personal/jmux > new worktree"
Step 3b: header="New Session"          subheader="~/Code/personal/jmux > new worktree from main"
```

**Data providers** — sync functions injected by main.ts at construction:

```typescript
interface NewSessionProviders {
  scanProjectDirs: () => string[];
  isBareRepo: (dir: string) => boolean;
  getWorktrees: (dir: string) => Array<{ name: string; path: string }>;
  getRemoteBranches: (dir: string) => string[];
  getDefaultBranch: (dir: string) => string;
}
```

These run local filesystem/git commands synchronously via `Bun.spawnSync`. Sub-100ms latency, same as the current fzf flow.

**Result type:**

```typescript
type NewSessionResult =
  | { type: "standard"; dir: string; name: string }
  | { type: "existing_worktree"; dir: string; path: string; branch: string }
  | { type: "new_worktree"; dir: string; baseBranch: string; name: string }
```

main.ts pattern-matches on the result type and runs the appropriate tmux commands — identical to what the shell scripts do today:

- `standard`: `new-session -d -s NAME -c DIR` + `switch-client`
- `existing_worktree`: same as standard, using worktree path and branch name
- `new_worktree`: `new-session -d -s NAME -c DIR "wtm create NAME --from BRANCH --no-shell; ..."` + `split-window` waiting for worktree + `switch-client`

## Migration: Settings Consolidation

Settings move fully into the command palette. The settings.sh script and the toolbar "settings" action are removed.

| Setting | Mechanism |
|---|---|
| Sidebar width | Palette sublist (already exists, no change) |
| wtm integration | New palette command — toggles on select, no modal needed |
| Claude command | New palette command — opens InputModal with current value |
| Project directories | New palette command — opens InputModal with current comma-separated value |

For InputModal-backed settings, the palette command handler opens the InputModal. When the InputModal returns a result, main.ts writes the value to `~/.config/jmux/config.json` using the existing `applySetting` function.

## Migration: Window Picker Consolidation

Windows become dynamic palette commands, following the same pattern as session switching:

```typescript
for (const tab of currentTabs) {
  if (tab.active) continue;
  commands.push({
    id: `window:${tab.windowId}`,
    label: `Window ${tab.index}: ${tab.name}`,
    category: "window",
  });
}
```

The palette command handler sends `select-window -t :INDEX`. The standalone "Window picker" command and its inline fzf invocation are removed.

## File Changes

### New Files

| File | Purpose |
|---|---|
| `src/modal.ts` | Modal interface, ModalAction type, shared color/attr constants |
| `src/input-modal.ts` | InputModal class |
| `src/list-modal.ts` | ListModal class |
| `src/content-modal.ts` | ContentModal class |
| `src/new-session-modal.ts` | NewSessionModal wizard |

### Modified Files

| File | Changes |
|---|---|
| `src/main.ts` | Replace palette-specific wiring with `activeModal` slot. Add `openModal`/`closeModal` helpers with result callback. Add modal openers for each command. Add data provider functions for NewSessionModal. Add dynamic window commands to palette. Remove `spawnTmuxPopup`. Remove settings toolbar action. |
| `src/renderer.ts` | Rename `paletteOverlay` → `modalOverlay`, `paletteCursor` → `modalCursor`, `getPalettePosition` → `getModalPosition`. No logic changes. |
| `src/command-palette.ts` | Add `getCursorPosition()` and `preferredWidth()` to satisfy Modal interface. Change `PaletteAction` `"execute"` → `"result"` to match `ModalAction`. Move shared color constants to `modal.ts`, import from there. |
| `src/input-router.ts` | Replace `palette`-specific references with `modal`-generic ones (if any). |

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

### Deleted Code

- `spawnTmuxPopup` function in main.ts
- Inline fzf window-picker command string
- `"window-picker"` and `"setting-project-dirs"` palette command entries (replaced by new commands)
- `"settings"` toolbar action handler

## Testing

Each modal class is independently testable:

- **InputModal:** test text editing (insert, backspace, cursor position), submit/cancel actions, grid rendering with header/subheader/input
- **ListModal:** test fuzzy filtering, scroll behavior, selection navigation, result action
- **ContentModal:** test scroll mechanics (j/k/d/u/g/G), viewport clipping, dismiss action
- **NewSessionModal:** test step transitions, back navigation, result types for each flow path, data provider integration
- **Integration:** test that `activeModal` wiring in main.ts correctly routes input and renders overlays

Fuzzy matching is already tested via CommandPalette tests. Modal rendering uses the same `createGrid`/`writeString` primitives tested in cell-grid tests.
