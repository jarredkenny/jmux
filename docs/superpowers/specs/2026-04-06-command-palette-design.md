# Command Palette Design

## Overview

An in-process command palette for jmux, rendered as a top-anchored dropdown overlay. Opens with `Ctrl-a p`, provides fuzzy-searchable access to all major actions: session switching, window/pane management, and settings. Built as new rendering infrastructure in the Bun/TS process rather than a tmux `display-popup`.

## Visual Design

### Layout

The palette replaces the toolbar row and extends downward over the main terminal content. It consists of:

1. **Input line** — top row, replaces the toolbar. Shows a prompt character (`▷`), the user's query text, and a cursor.
2. **Results list** — drops down below the input line, overlaying the top portion of the main PTY content. Shows filtered/matched commands with a selection indicator (`▸`) on the highlighted row and a dim category tag on the right of each entry.

The palette width spans the full main content area (same width as the toolbar). The results list height is dynamic — it shows as many matching results as fit, capped at a reasonable maximum (8-10 rows) to avoid covering too much terminal content.

### Styling

Follows the existing jmux color palette:

- **Input line background**: `#161b22` (slightly lighter than terminal bg)
- **Results background**: `#161b22`
- **Selected row background**: `#1e2a35` (same as active sidebar row)
- **Selected row text**: palette 7 (white), bold
- **Unselected row text**: palette 8 (dim gray)
- **Match highlight**: palette 2 (green, `#9fe8c3`) — matched characters in results are highlighted
- **Category tag**: palette 8 (dim), right-aligned
- **Prompt character**: palette 8 (dim)
- **Cursor**: palette 2 (green)
- **Border**: bottom edge of results area uses `─` in palette 8 to visually separate from content below

### Sub-list Mode

When a user selects a setting, the palette transitions to a sub-list:

- The input line shows the setting name followed by `›` as a breadcrumb, then a fresh empty input area
- The results list shows the available values for that setting
- The current value is marked with a "current" tag on the right (palette 2, dim)
- Typing filters the sub-list options (same fuzzy matching as the main list)
- Escape returns to the main list, restoring the previous query

## Architecture

### New File: `src/command-palette.ts`

A self-contained module that owns:

- **State**: open/closed, query string, cursor position, selected index, filtered results, sub-list state (parent command + options)
- **Command registry**: static list of commands plus dynamic entries (sessions, windows) injected on open
- **Fuzzy matching**: simple substring/character matching against command labels, scoring by match quality
- **Grid rendering**: produces a `CellGrid` via `createGrid`/`writeString` (same pattern as `Sidebar`)

Public API:

```typescript
class CommandPalette {
  // Lifecycle
  open(commands: PaletteCommand[]): void   // populate and show
  close(): void                             // reset state, hide
  isOpen(): boolean

  // Input handling (called by InputRouter)
  handleInput(data: string): PaletteAction
  // Returns: { type: "consumed" } — input handled, just re-render
  //          { type: "closed" } — palette dismissed itself (Escape)
  //          { type: "execute", result: PaletteResult } — run this action

  // Rendering
  getGrid(width: number): CellGrid          // returns overlay grid
  getHeight(): number                        // rows the palette occupies (input + results)
}

interface PaletteCommand {
  id: string
  label: string                              // display text, fuzzy-matched against
  category: string                           // "session" | "window" | "pane" | "setting" | "other"
  sublist?: PaletteSublistOption[]           // if present, Enter drills in instead of executing
}

interface PaletteSublistOption {
  id: string
  label: string
  current?: boolean                          // marks the active value
}

interface PaletteResult {
  commandId: string
  sublistOptionId?: string                   // set when selected from a sub-list
}
```

### InputRouter Changes (`src/input-router.ts`)

Add a "palette mode" to the input router:

- New callback: `onPaletteInput?: (data: string) => void`
- New state: `paletteOpen: boolean` (toggled by main.ts)
- When `paletteOpen` is true, all keyboard input routes to `onPaletteInput` instead of `onPtyData`. Mouse events are still handled normally (sidebar clicks, etc.) but toolbar/main-area mouse events are ignored.
- `Ctrl-Shift-Up/Down` (session switching) still works even when palette is open — these are global hotkeys.

### Renderer Changes (`src/renderer.ts`)

Modify `compositeGrids` to accept an optional palette grid:

- When a palette grid is provided, it replaces the toolbar row and overlays subsequent rows of the main content
- The palette grid's height determines how many main content rows are covered
- The sidebar and border column render normally — the palette only covers the main content area

### main.ts Orchestration

**Opening the palette** (`Ctrl-a p`):

1. Build the command list: static commands + dynamic entries from `currentSessions` and `currentWindows`
2. Call `palette.open(commands)`
3. Set `inputRouter.setPaletteOpen(true)`
4. Render

**Handling palette input**:

1. Forward raw input to `palette.handleInput(data)`
2. If it returns a `PaletteResult`, execute the corresponding action (same handlers as toolbar actions, session switching, etc.)
3. If it returns null, the palette consumed the input (typing, navigation) — just re-render
4. If the palette closed itself (Escape at top level), set `inputRouter.setPaletteOpen(false)` and render

**Closing the palette**:

1. Call `palette.close()`
2. Set `inputRouter.setPaletteOpen(false)`
3. Render (toolbar reappears)

### Keybinding

`Ctrl-a p` is already unbound (explicitly freed in `config/defaults.conf` line 9). Bind it to send a recognizable escape sequence that the InputRouter can intercept, OR handle it via tmux `send-keys` / `run-shell` that signals the jmux process.

Preferred approach: bind `Ctrl-a p` in tmux config to `send-keys` a custom escape sequence (e.g., `\x1b[80;112~`). The InputRouter detects this sequence and triggers the palette toggle. This keeps the binding in tmux config (consistent with all other `Ctrl-a` bindings) while the behavior lives in the TS process.

## Commands

### Static Commands

| ID | Label | Category |
|----|-------|----------|
| `new-session` | New session | session |
| `kill-session` | Kill session | session |
| `rename-session` | Rename session | session |
| `new-window` | New window | window |
| `close-window` | Close window | window |
| `move-window` | Move window to session | window |
| `split-h` | Split horizontal | pane |
| `split-v` | Split vertical | pane |
| `zoom-pane` | Zoom pane | pane |
| `close-pane` | Close pane | pane |
| `window-picker` | Window picker | other |
| `open-claude` | Open Claude | other |
| `setting-sidebar-width` | Sidebar width | setting |
| `setting-claude-command` | Claude command | setting |
| `setting-project-dirs` | Project directories | setting |

### Dynamic Commands

Generated when the palette opens:

- **Switch to `<session name>`** — one entry per session (excluding current), category "session"
- **Switch to `<window name>`** — one entry per window in current session (excluding active), category "window"

### Setting Sub-lists

| Setting | Options |
|---------|---------|
| Sidebar width | 20, 22, 24, 26, 28, 30, 34 |
| Claude command | `claude`, `claude --dangerously-skip-permissions` (current value marked) |
| Project directories | Current list shown, with "Add directory" and "Remove directory" options |

Project directories sub-list is more complex — "Add directory" would need text input. For v1, this setting opens the existing settings popup (`config/settings.sh`) as a fallback. Same for claude command — the sub-list options are just the common values, and the user can always use the settings popup for custom values.

## Fuzzy Matching

Simple character-by-character matching (not full fuzzy scoring):

1. For each result, check if all characters in the query appear in order in the label (case-insensitive)
2. Score by: consecutive character matches (bonus), match at word boundaries (bonus), shorter label (bonus)
3. Sort by score descending
4. Highlight matched characters in green (palette 2)

This is intentionally simple. If it feels insufficient, it can be upgraded later without changing the architecture.

## Input Handling

The palette handles these inputs:

| Input | Action |
|-------|--------|
| Printable characters | Append to query, re-filter |
| Backspace | Delete last character (no-op if query empty) |
| Up arrow | Move selection up |
| Down arrow | Move selection down |
| Enter | Execute selected command (or drill into sub-list) |
| Escape | Back out of sub-list, or close palette at top level |
| `Ctrl-a p` sequence | Close palette (toggle) |
| Tab | No-op (reserved for future use) |

All other input is silently consumed (not forwarded to PTY).

## Rendering Integration

The `compositeGrids` function signature changes:

```typescript
function compositeGrids(
  main: CellGrid,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  paletteOverlay?: CellGrid | null,  // new
): CellGrid
```

When `paletteOverlay` is provided:
- Row 0 (toolbar row) is replaced by the palette's first row (input line)
- Rows 1 through `paletteOverlay.rows - 1` overlay the corresponding main content rows
- The palette grid width equals `mainCols` and is positioned after the sidebar border, same as the toolbar

When `paletteOverlay` is null, rendering is unchanged (toolbar renders normally).

## Edge Cases

- **Empty query**: show all commands, with dynamic entries (sessions, windows) first since they're the most common action
- **No matches**: show a dim "No matches" message in the results area
- **Palette open during resize**: close the palette on SIGWINCH and re-render normally. User can reopen.
- **Session/window changes while palette open**: the palette works with a snapshot of commands taken at open time. Stale entries (deleted session) will fail gracefully when executed.
- **Very long command labels**: truncate with `…` to fit within the available width minus the category tag
