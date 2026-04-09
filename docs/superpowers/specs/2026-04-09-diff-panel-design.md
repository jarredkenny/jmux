# Diff Panel Design: Embedded hunk Integration

## Overview

Embed [hunk](https://github.com/modem-dev/hunk) as an interactive diff panel within jmux's chrome, giving users a tightly integrated way to review agent-authored code changes without leaving the TUI. The panel reuses jmux's existing ScreenBridge pattern — hunk runs as a subprocess in a PTY, its terminal output is captured into a CellGrid via a second headless xterm.js instance, and the grid is composited into jmux's layout alongside the sidebar, toolbar, and tmux main area.

## Layout State Machine

The diff panel has three states, cycled by a single hotkey (`Ctrl-a g`):

```
off ──→ split ──→ full ──→ off
```

### State: `off` (default)

No diff panel. Layout is exactly as it is today: sidebar + toolbar + tmux. Hunk subprocess is not running.

### State: `split`

Right panel appears, taking ~40% of the available width (after sidebar). The exact ratio is configurable via `~/.config/jmux/config.json`.

- Tmux area shrinks. `pty.resize()` is called on the bun-pty handle to change the terminal dimensions; tmux responds to the resulting SIGWINCH and reflows.
- Hunk launches with `hunk diff` pointed at the active session's directory.
- Both tmux and hunk are interactive. A 1-column divider between them indicates focus: bright (`#58a6ff`) when hunk is focused, dim (`#30363d`) when tmux is focused.
- Focus switches via mouse click in either panel area, or `Ctrl-a Tab` to toggle between panels.

### State: `full`

Hunk takes over the entire main area. Sidebar stays.

- Tmux PTY is still running but its CellGrid is not composited — like an off-screen tmux window.
- No need to resize tmux since we're just not drawing it.
- Maximum room for hunk's split-view (side-by-side) diffs.
- Hunk always has keyboard focus in this mode.

### Transitions

- `Ctrl-a g` cycles `off → split → full → off`
- Toolbar button does the same
- Closing the panel (from any state): hunk subprocess is killed, tmux PTY resizes back to full width
- `split → full`: tmux PTY resizes back to full width immediately (invisible reflow while tmux isn't drawn, so the `full → off` transition is instant with no visible reflow)
- `full → off`: no tmux resize needed — already at full width from the `split → full` transition
- Switching sessions while panel is open: hunk restarts with the new session's directory

## Subprocess Management

### Spawning hunk

When the panel opens:

1. Resolve the active session's working directory via `display-message -p -t <session> '#{pane_current_path}'` on the control client. Note: this returns the *active pane's* current working directory (which may differ from the session's initial directory if the user has `cd`'d). This is intentional — we want the directory the agent is actually working in.
2. Spawn `hunk diff` in a new PTY (via `bun-pty`) with the working directory set to the resolved path.
3. PTY dimensions match the panel's allocated size (cols x rows).

### Screen capture pipeline

```
hunk PTY → ScreenBridge #2 (@xterm/headless) → CellGrid → compositeGrids()
```

A second `ScreenBridge` instance reads hunk's terminal output into a `CellGrid`. Hunk's full visual output — syntax highlighting, word-level inline diffs, rail markers, box-drawing characters, themes — arrives as cells with correct fg/bg/bold/italic/underline attributes. No custom diff rendering needed.

### Lifecycle events

- **Panel opens:** spawn hunk PTY + ScreenBridge #2, schedule render.
- **Session switch:** kill old hunk process, spawn new one for the new session's directory.
- **Terminal resize (SIGWINCH):** recalculate panel width, `pty.resize()` both tmux and hunk PTYs, resize both ScreenBridges.
- **Panel closes:** kill hunk process, dispose ScreenBridge #2, resize tmux PTY back to full width.
- **Hunk exits on its own** (e.g., user presses `q`): transition to an "empty panel" state — the panel stays open showing a hint ("Press Ctrl-a g to close, or switch sessions to reload"). This prevents an accidental `q` from killing the review workflow. The next session switch will relaunch hunk automatically.

### Refresh

- On open: fresh `hunk diff` launch.
- Manual refresh: kill + relaunch hunk to pick up new changes. Triggered via a keybinding or toolbar action.
- No auto-watch initially. Hunk supports `--watch` mode; adding it later is a single flag change.

### hunk as an optional dependency

`hunkdiff` is an optional runtime dependency. If not installed when the user triggers the panel, show a brief message: "hunk not found — install with: npm i -g hunkdiff". Detected at toggle time with `Bun.which("hunk")` (built-in, no subprocess needed).

## Composition Changes

### compositeGrids() signature

Current:
```typescript
function compositeGrids(
  main: CellGrid,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  modalOverlay?: CellGrid | null,
): CellGrid
```

New:
```typescript
function compositeGrids(
  main: CellGrid,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  modalOverlay?: CellGrid | null,
  diffPanel?: {
    grid: CellGrid;
    mode: "split" | "full";
    focused: boolean;
  },
): CellGrid
```

### Split mode layout

```
[sidebar │ tmux area │ divider │ hunk panel]
```

- `mainCols` shrinks: `availableCols - diffPanelCols - 1` (1 for the divider column).
- Hunk's CellGrid is placed starting at column `sidebarCols + 1 + mainCols + 1`.
- The divider is a 1-column strip of `│` characters. Color reflects focus state.
- Toolbar spans the full width (`mainCols + 1 + diffPanelCols`). `ToolbarConfig.mainCols` stays as the tmux area width — `compositeGrids()` extends the toolbar row across the divider and diff panel columns implicitly during composition (filling with the toolbar background). The diff panel's status info (file count, view mode) renders in the toolbar within the diff panel's column range, right-aligned.

### Full mode layout

```
[sidebar │ hunk panel (full remaining width)]
```

- Tmux grid is not composited. Hunk gets all columns after the sidebar border.

### Modal overlay

Modals render on top of everything, same as today. Modals take input priority over all other areas. When a modal is open, both the main tmux area and the diff panel area are dimmed (sidebar is not dimmed, consistent with existing behavior). Modal positioning centers over the full terminal width.

## Input Routing

### New areas

Current: `sidebar | toolbar | main (→ PTY)`

New: `sidebar | toolbar | main (→ PTY) | divider | diffPanel (→ hunk PTY)`

### InputRouterOptions additions

```typescript
onDiffPanelClick?: (col: number, row: number) => void;
onDiffPanelScroll?: (delta: number) => void;
onDiffPanelFocus?: () => void;
diffPanelCols: number;       // 0 when panel is off
diffPanelFocused: boolean;   // which panel gets keyboard input
```

### Mouse routing (SGR)

Extending the existing SGR mouse parser:

```
x <= sidebarCols                            → sidebar click/scroll
y == toolbar row                            → toolbar click
x == sidebarCols + 1 + mainCols + 1        → divider (toggle focus)
x > totalCols - diffPanelCols              → diff panel (translate coords, forward to hunk PTY)
else                                        → main area (translate coords, forward to tmux PTY)
```

Mouse click in either the main or diff panel area sets `diffPanelFocused` accordingly. Clicking the 1-column divider toggles focus between panels (same as `Ctrl-a Tab`).

### Keyboard routing (no modal open)

- `Ctrl-Shift-Up/Down`: session switching — always intercepted by jmux.
- `Ctrl-a Tab`: toggle focus between tmux and hunk panels (split mode only).
- Prefix sequences (`Ctrl-a p/n/i/g`): always intercepted by jmux.
- Everything else: forwarded to hunk PTY if `diffPanelFocused`, or tmux PTY if not.

### Prefix key behavior when hunk is focused

When hunk has focus, the `\x01` byte (Ctrl-a) requires special handling because hunk doesn't use Ctrl-a as a prefix — forwarding it would be noise.

**Rule:** When hunk is focused, `\x01` sets `prefixSeen = true` in the input router but is **not forwarded to either PTY**. Then:

- If the next key is an intercepted binding (`g`, `p`, `n`, `i`, `Tab`): jmux handles it as normal.
- If the next key is **not** an intercepted binding: the key is **swallowed** (discarded). It should not go to hunk (meaningless) or to tmux (not focused). This differs from the tmux-focused case where unrecognized post-prefix keys fall through to tmux for tmux's own prefix bindings.

This means `Ctrl-a` followed by an unrecognized key is a no-op when hunk is focused, which is the correct behavior — the user gets jmux's intercepts but nothing else leaks through.

### Full mode

Hunk always has keyboard focus. No tmux area to click into.

## Session Integration

When the diff panel is open and the user switches sessions:

1. Query the new session's pane path: `display-message -p -t <session> '#{pane_current_path}'`.
2. Kill the current hunk subprocess.
3. Spawn a new `hunk diff` in the new directory.
4. ScreenBridge #2 picks up the new output; next render frame shows the updated diff.

If the new session's directory has no git repo, hunk exits with an error. The panel catches the exit and shows: "No git repository in this session's directory." The panel stays open so switching to another session picks it up automatically.

## Controls

### Hotkey: `Ctrl-a g`

Mnemonic: **g**it diff. Currently unused by jmux or standard tmux bindings. The intercept works the same way as the existing `Ctrl-a p` (palette) — watch for `\x01` then `g` within the prefix window.

Cycle behavior: `off → split → full → off`.

### Toolbar button

A `◈` button added to the toolbar's right-side action buttons, between the split buttons and settings. Three visual states:

- **Off:** dim (`#8b949e`)
- **Split:** highlighted (`#f0883e`)
- **Full:** highlighted with label change

Click behavior matches the hotkey — cycles through the three states.

### Command palette

Three new commands:

- "Toggle diff panel" — cycles like the hotkey
- "Diff: split view" — jump directly to split mode
- "Diff: full screen" — jump directly to full mode

## Files Changed

| File | Change |
|------|--------|
| `src/diff-panel.ts` | **New.** Owns hunk subprocess, ScreenBridge #2, lifecycle, directory resolution. |
| `src/renderer.ts` | Extend `compositeGrids()` with `diffPanel` parameter, divider rendering, focus border color. |
| `src/input-router.ts` | Add diff panel region to mouse routing, focus state, keyboard forwarding to hunk PTY. |
| `src/main.ts` | Panel state machine (`off`/`split`/`full`), `Ctrl-a g` intercept, toolbar button, session-switch hook, SIGWINCH handling for dual PTY resize. |
| `src/command-palette.ts` | Add diff panel commands. |

No changes to: `cell-grid.ts`, `screen-bridge.ts`, `modal.ts`, `sidebar.ts`, `tmux-control.ts`, `tmux-pty.ts`. The existing infrastructure is reused as-is.

## Configuration

New fields in `~/.config/jmux/config.json`:

```json
{
  "diffPanel": {
    "splitRatio": 0.4,
    "hunkCommand": "hunk"
  }
}
```

- `splitRatio`: fraction of available width (after sidebar) given to the diff panel in split mode. Default `0.4`.
- `hunkCommand`: path or name of the hunk binary. Default `"hunk"`. Allows custom installs or wrapper scripts.
