# Sidebar Refresh Design Spec

Redesign the jmux sidebar for better information density, visual polish, mouse support, and keyboard shortcuts.

## Visual Layout

24-column sidebar with 3-row session entries (2 content + 1 blank spacer):

```
 jmux
────────────────────────
 ● api-server        3w
   ~/Code/api     main

   dashboard
   ~/Code/dash  feat/x

 ! deploy-tools      1w
   ~/Code/ops   v2.0
```

### Row 1: Name Line

- **Col 0-1:** Indicator — green `●` for activity, yellow bold `!` for attention, space if neither
- **Col 2+:** Session name, left-aligned. Bold if this is the active session. Truncate with `…` if it would collide with window count.
- **Right-aligned:** Window count as `Nw` (e.g., `3w`), dimmed. Sourced from `#{session_windows}` in `list-sessions`.

### Row 2: Detail Line

- **Col 2+:** Working directory basename (e.g., `~/Code/api`), dimmed. Uses `~` substitution for home directory.
- **Right-aligned:** Git branch name, dimmed. Omitted if it would collide with directory.

### Row 3: Spacer

Blank row. Provides visual breathing room between entries.

### Header

- Row 0: `jmux` in bold
- Row 1: Full-width `─` separator, dimmed

Sessions start at row 2. With 3 rows per session and a 50-row terminal, the sidebar fits 16 sessions before scrolling would be needed. Scrolling is out of scope — sessions beyond the visible area are simply not rendered.

## Colors & Styling

All colors use ANSI 16 palette indices. The user's terminal theme (Ghostty) controls the actual rendered colors.

| Element | Style |
|---|---|
| Session name (active) | Default fg, bold, bg 0 (black) |
| Session name (inactive) | Default fg, no bg |
| Session name (sidebar-mode highlight) | Default fg, bg 4 (blue) |
| Directory, branch, window count | Dim |
| Activity dot `●` | fg 2 (green) |
| Attention flag `!` | fg 3 (yellow), bold |
| Active session rows | bg 0 (black) — both rows |
| Sidebar-mode highlight rows | bg 4 (blue) — both rows |
| Border | Dim `│` |
| Header "jmux" | Bold |
| Header separator | Dim `─` |

Active session uses background color to create a subtle highlight. Sidebar-mode highlight uses blue background to signal "you are navigating." Non-active sessions have no background.

## Interaction

### Always-Active Hotkeys

These work without entering sidebar mode:

- **`Ctrl-Shift-Up`** (`\x1b[1;6A`) — switch to previous session in the list
- **`Ctrl-Shift-Down`** (`\x1b[1;6B`) — switch to next session in the list
- **`Ctrl-a n`** — open new session creation popup

These key sequences are intercepted by the InputRouter before any other processing. `Ctrl-Shift-Up/Down` are distinct from regular arrows and don't conflict with tmux bindings. `Ctrl-a n` reuses the existing prefix detection (same mechanism as `Ctrl-a j` for sidebar mode) — the user's existing tmux `n` binding (next-window) is intentionally overridden.

### Sidebar Mode

Entered via `prefix + j` (same as before):

- `j` / `k` / Up / Down — move highlight (wraps around)
- `Enter` — switch to highlighted session, exit sidebar mode
- `Escape` — exit sidebar mode without switching

### Mouse

jmux enables SGR mouse tracking on the real terminal at startup:

```
\x1b[?1000h  — enable mouse button tracking
\x1b[?1006h  — enable SGR extended mouse mode
```

On cleanup, these are disabled:

```
\x1b[?1000l
\x1b[?1006l
```

Mouse behavior:
- **Click on either row of a session entry** — instant switch to that session (same as Enter in sidebar mode). The Sidebar maps click rows to sessions: `sessionIndex = Math.floor((clickRow - HEADER_ROWS) / 3)`. Clicks on the spacer row (row 3 of an entry) map to the session above.
- **Click in main area** — x-coordinate translated (subtract sidebar width + border) and forwarded to tmux PTY. This is the existing behavior.
- **Click on header/separator** — consumed, no action.

### New Session Creation

`Ctrl-a n` sends the following command via the control mode connection:

```
display-popup -E -w 40% -h 3 -b heavy -S 'fg=#4f565d' \
  "printf 'Session name: '; read name && tmux new-session -d -s \"$name\""
```

This renders a tmux popup inside the PTY area. jmux doesn't need special handling — the popup is just PTY output that flows through the normal render pipeline. When the user types a name and presses Enter, tmux creates the session detached. The `%sessions-changed` notification fires and the sidebar updates automatically. Pressing Escape cancels the popup cleanly.

## Data Sources

### SessionInfo Extensions

`SessionInfo` gains two new fields:

```typescript
interface SessionInfo {
  id: string;
  name: string;
  attached: boolean;
  activity: number;
  gitBranch?: string;
  attention: boolean;
  windowCount: number;    // NEW
  directory?: string;     // NEW — basename of active pane's cwd
}
```

### Window Count

Already available from `list-sessions`. Update the format string:

```
list-sessions -F '#{session_id}:#{session_name}:#{session_activity}:#{session_attached}:#{session_windows}'
```

### Working Directory

Already fetched in `lookupGitBranches` via `tmux display-message -t <id> -p '#{pane_current_path}'`. Extract the value and store as `directory` on SessionInfo, shortened with `~` substitution for the home directory prefix. The basename is computed at render time in the Sidebar.

## Files Changed

- **`src/types.ts`** — add `windowCount` and `directory` to `SessionInfo`
- **`src/sidebar.ts`** — 3-row layout, new color scheme, window count + directory rendering, updated `getSessionByRow` for 3-row math
- **`src/input-router.ts`** — detect `\x1b[1;6A` / `\x1b[1;6B` before prefix check, add callbacks for session-prev/next
- **`src/main.ts`** — enable/disable mouse tracking, handle Ctrl-Shift-Up/Down, handle Ctrl-a n, pass windowCount + directory in SessionInfo, update `fetchSessions` format string
- **`src/__tests__/sidebar.test.ts`** — update for 3-row layout and new fields
- **`src/__tests__/input-router.test.ts`** — tests for Ctrl-Shift arrow detection
