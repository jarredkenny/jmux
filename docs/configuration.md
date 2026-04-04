# Configuration

jmux ships a self-contained `config/tmux.conf` that provides all keybindings, styling, and behavior out of the box. It never reads `~/.tmux.conf`.

## Editing the Config

The config lives at `config/tmux.conf` in the jmux directory. Edit it directly — changes take effect the next time you start jmux.

```bash
vim config/tmux.conf
```

There's no hot-reload. Restart jmux to pick up changes.

## Prefix Key

The default prefix is `Ctrl-a`. To change it:

```tmux
set -g prefix C-b
unbind C-a
bind-key C-b send-prefix
```

If you change the prefix, jmux's sidebar mode shortcut changes too — it's always `prefix + j`. The session-switching hotkeys (`Ctrl-Shift-Up/Down`) are unaffected since they don't use the prefix.

> **Note:** The prefix is currently hardcoded in jmux's input router as `\x01` (Ctrl-a). If you change it in the tmux config, you also need to update the `tmuxPrefix` value in `src/main.ts`. This will be configurable without code changes in a future release.

## Keybindings

### Adding a Keybinding

Standard tmux `bind` syntax works:

```tmux
# Open lazygit in a popup
bind-key g display-popup -E -w 80% -h 80% "lazygit"

# Quick ssh to a server
bind-key S command-prompt -p "ssh:" "new-window -n '%1' 'ssh %1'"
```

### Removing a Keybinding

```tmux
unbind-key g
```

### Key Table Reference

jmux intercepts these keys before they reach tmux:

| Key | jmux behavior | Can be rebound in tmux? |
|-----|--------------|------------------------|
| `Ctrl-Shift-Up` | Previous session | No — handled by jmux |
| `Ctrl-Shift-Down` | Next session | No — handled by jmux |
| `prefix + j` | Enter sidebar mode | No — handled by jmux |
| `prefix + n` | New session popup | No — handled by jmux |
| Mouse clicks in sidebar | Switch session | No — handled by jmux |

Everything else passes through to tmux normally. If you need one of the intercepted keys for something else, you'd need to change the bindings in `src/input-router.ts`.

## Status Bar

The default config shows a minimal status bar with only window tabs — no session indicator (the sidebar handles that) and no system metrics.

### Adding Status Content

To add content back to the right side:

```tmux
set -g status-right-length 50
set -g status-right "#[fg=#6b7280]%H:%M #[fg=#4f565d]│ #[fg=#6b7280]%b %d"
```

### Moving the Status Bar

```tmux
set -g status-position top
```

### Hiding the Status Bar

```tmux
set -g status off
```

The sidebar still works without the status bar — session management is fully independent.

## Window Tab Styling

The default config uses a dark theme with peach highlights for the active window:

```tmux
# Active window tab
setw -g window-status-current-format "#[bg=#181f26 fg=#fbd4b8]◢#[bg=#fbd4b8 fg=#131a21] #W #{?window_zoomed_flag,󰊓 ,}#[bg=#181f26 fg=#fbd4b8]◣"

# Inactive window tabs
setw -g window-status-format "#{?window_bell_flag,#[bg=#181f26 fg=#ced4df] #W ,#[bg=#181f26 fg=#4f565d] #W }"
```

To use a simpler style:

```tmux
setw -g window-status-current-format " #[bold]#W "
setw -g window-status-format " #W "
```

## Pane Borders

Pane borders auto-show when a window has multiple panes and hide when there's only one:

```tmux
# Disable auto-show (always show borders)
set-hook -gu window-layout-changed
set-hook -gu after-select-window
set -g pane-border-status top

# Disable borders entirely
set -g pane-border-status off
```

## Mouse

Mouse support is enabled by default (`set -g mouse on`). jmux adds SGR mouse tracking on top of this for sidebar clicks. Disabling mouse in tmux doesn't affect sidebar click handling.

## Smart Pane Navigation

The config includes vim-aware pane navigation via Shift-arrow keys. If you don't use neovim with smart-splits, you can simplify:

```tmux
# Replace the is_vim checks with direct pane selection
bind -n S-Left select-pane -L
bind -n S-Right select-pane -R
bind -n S-Up select-pane -U
bind -n S-Down select-pane -D
```

## Terminal Settings

The config sets `TERM` to `tmux-256color` with true color and undercurl overrides. If you're using a terminal that doesn't support these features, you can simplify:

```tmux
set -g default-terminal "screen-256color"
# Remove the terminal-overrides lines
```
