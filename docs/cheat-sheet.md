# jmux Cheat Sheet

Quick reference for all keybindings and features. The default prefix is `Ctrl-a`.

---

## Sidebar

| Action | How |
|--------|-----|
| Switch session | Click a session in the sidebar |
| Next/prev session | `Ctrl-Shift-Down` / `Ctrl-Shift-Up` |
| Scroll sidebar | Mouse wheel over the sidebar |
| Mouse select & copy | Click-drag in the main area to select, copies to clipboard |

The sidebar shows all sessions with:
- Green `▎` marker + highlighted background on the active session
- Green `●` dot for sessions with new output since you last viewed them
- Orange `!` flag for attention (e.g. Claude Code finished a response)
- Sessions sharing a parent directory are grouped under a header
- `▲` / `▼` indicators when sessions overflow the sidebar

---

## Sessions

| Key | Action |
|-----|--------|
| `Ctrl-Shift-Up` | Switch to previous session |
| `Ctrl-Shift-Down` | Switch to next session |
| `Ctrl-a n` | New session / new worktree (auto-detects wtm projects) |
| `Ctrl-a r` | Rename current session |
| `Ctrl-a m` | Move current window to another session |

---

## Windows

| Key | Action |
|-----|--------|
| `Ctrl-a c` | New window (starts in `~`) |
| `Ctrl-Right` | Next window |
| `Ctrl-Left` | Previous window |
| `Ctrl-Shift-Right` | Move window right |
| `Ctrl-Shift-Left` | Move window left |

---

## Panes

| Key | Action |
|-----|--------|
| `Ctrl-a \|` | Split horizontally |
| `Ctrl-a -` | Split vertically |
| `Shift-Left/Right/Up/Down` | Navigate between panes |
| `Ctrl-a Left/Right/Up/Down` | Resize pane (repeatable) |
| `Ctrl-a z` | Toggle pane zoom (⤢ shown in tab) |


Pane borders auto-show when a window has multiple panes and hide for single-pane windows.

Shift-arrow pane navigation is smart-splits.nvim aware — if the active pane is running vim/neovim, the key is forwarded to vim instead.

---

## Command Palette

Press `Ctrl-a p` to open the command palette — a floating overlay for fuzzy-searching all actions.

| Key | Action (inside palette) |
|-----|--------|
| Type | Fuzzy filter commands |
| `↑` / `↓` | Navigate results (scrolls with long lists) |
| `Enter` | Execute command or drill into setting sub-list |
| `Escape` | Back out of sub-list, or close palette |
| `Ctrl-a p` | Close palette |

**Available commands:** switch sessions, switch windows, new session/window, kill session, close window/pane, split horizontal/vertical, zoom pane, rename session, move window, window picker, open Claude, sidebar width, Claude command, project directories.

---

## Utilities

| Key | Action |
|-----|--------|
| `Ctrl-a p` | Command palette (fuzzy search all actions) |
| `Ctrl-a k` | Clear pane content + scrollback |
| `Ctrl-a y` | Copy entire pane content to clipboard |
| `Ctrl-a i` | Settings |

---

## Claude Code Integration

```bash
jmux --install-agent-hooks
```

Adds a hook so that when Claude Code finishes a response, the session gets an orange `!` attention flag in the sidebar. Switch to the session to dismiss it.

---

## Configuration

Config loads in three layers:

```
config/defaults.conf      <- jmux defaults (baseline)
~/.tmux.conf              <- your config (overrides defaults)
config/core.conf          <- jmux core (always wins)
```

Override any default in your `~/.tmux.conf` — prefix key, colors, keybindings, plugins. Only a few core settings are enforced: `detach-on-destroy off`, `mouse on`, the `prefix + n` binding, and `status off` (jmux renders its own toolbar).

See [configuration.md](configuration.md) for the full guide.
