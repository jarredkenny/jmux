# Configuration

jmux loads tmux config in three layers:

```
config/defaults.conf      ← jmux defaults (baseline)
~/.tmux.conf              ← your config (overrides defaults)
config/core.conf          ← jmux requirements (sourced last, always wins)
```

jmux defaults are applied first as a baseline. Your `~/.tmux.conf` is sourced next — anything you set there overrides jmux's defaults. Core settings are applied last and cannot be overridden.

Restart jmux to pick up changes. There's no hot-reload.

## Customizing in ~/.tmux.conf

jmux's defaults are sourced first, then your `~/.tmux.conf` overrides them. Anything you set in `~/.tmux.conf` wins over jmux's defaults. Only core settings (listed below) cannot be overridden.

```bash
# Edit your tmux config as usual
vim ~/.tmux.conf
```

### Changing the Prefix Key

```tmux
# ~/.tmux.conf
set -g prefix C-b
unbind C-a
bind-key C-b send-prefix
```

jmux's `prefix + n` (new session) still works — it uses whatever prefix you set.

> **Note:** `Ctrl-Shift-Up/Down` for session switching is handled by jmux directly and doesn't use the prefix. It always works regardless of your prefix setting.

### Adding Keybindings

Standard tmux `bind` syntax in `~/.tmux.conf`:

```tmux
# Open lazygit in a popup
bind-key g display-popup -E -w 80% -h 80% "lazygit"

# Quick ssh to a server
bind-key S command-prompt -p "ssh:" "new-window -n '%1' 'ssh %1'"
```

### Overriding jmux Defaults

jmux sets defaults for things like window behavior and pane borders. Override any of them in `~/.tmux.conf`:

```tmux
# Change pane border colors
set -g pane-border-style 'fg=#3b4261'
set -g pane-active-border-style 'fg=#7aa2f7'

# Disable auto-rename (jmux default is on)
set -g automatic-rename off
```

### Using Plugins

TPM and plugins work normally. Add them to `~/.tmux.conf`:

```tmux
set -g @plugin 'tmux-plugins/tpm'
set -g @plugin 'tmux-plugins/tmux-sensible'
set -g @plugin 'catppuccin/tmux'

run '~/.tmux/plugins/tpm/tpm'
```

## Protected Settings (core.conf)

These settings are required for jmux to function. They're applied last and override anything in your config:

| Setting | Value | Why |
|---------|-------|-----|
| `detach-on-destroy` | `off` | Switch to next session on kill instead of exiting jmux |
| `mouse` | `on` | Sidebar and toolbar click/hover handling |
| `prefix + n` | New session modal | jmux's native session creation |
| `status` | `off` | jmux renders its own toolbar with window tabs |

If you bind `n` to something in `~/.tmux.conf`, jmux's core will override it. All other keys are yours.

## Keys Handled by jmux (Not tmux)

These are intercepted by jmux's input router before reaching tmux. They cannot be rebound in tmux config:

| Key | Action |
|-----|--------|
| `Ctrl-Shift-Up` | Switch to previous session |
| `Ctrl-Shift-Down` | Switch to next session |
| Mouse clicks in sidebar | Switch to that session |
| Mouse clicks on toolbar tabs | Switch to that window |
| Mouse clicks on toolbar buttons | New window, split, Claude, settings |
| Mouse hover (sidebar/toolbar) | Visual highlight |

Everything else passes through to tmux normally.

## Editing jmux Defaults

If you want to change jmux's default keybindings (not just override them), edit `config/defaults.conf` in the jmux installation directory:

```bash
# Find where jmux is installed
npm root -g
# Edit the defaults
vim $(npm root -g)/@jx0/jmux/config/defaults.conf
```

Changes here persist until you update jmux. For durable customizations, prefer `~/.tmux.conf` instead.

## jmux Application Config

jmux's own settings (not tmux settings) live in `~/.config/jmux/config.json`. Edit it directly or use the settings screen (`Ctrl-a i`). Changes are hot-reloaded.

```json
{
  "sidebarWidth": 26,
  "claudeCommand": "claude",
  "cacheTimers": true,
  "stateColors": {
    "running": "green",
    "waiting": "yellow",
    "complete": "blue"
  },
  "pinnedSessions": [],
  "commandCenterTabs": [
    { "id": "default", "name": "Main" }
  ],
  "projectDirs": ["~/Code", "~/Projects"],
  "wtmIntegration": true,
  "diffPanel": {
    "splitRatio": 0.4,
    "hunkCommand": "hunk"
  },
  "adapters": {
    "codeHost": { "type": "gitlab" },
    "issueTracker": { "type": "linear" }
  },
  "issueWorkflow": {
    "teamRepoMap": {},
    "defaultBaseBranch": "main",
    "autoCreateWorktree": true,
    "autoLaunchAgent": true,
    "sessionNameTemplate": "{identifier}"
  },
  "panelViews": []
}
```

### Agent-state colors

`stateColors` sets the color used for each agent state across every indicator —
sidebar dots/flags/checkmarks, the Command Center `n RUN / n WAIT / n DONE`
breakdown, and the Command Center tile borders. Each value is a named ANSI color:
`black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, and their
`bright*` variants (e.g. `brightblue`). Unset or unrecognized names fall back to
the defaults (`running` green, `waiting` yellow, `complete` blue). The bold/dim
emphasis per state is fixed; only the hue is configurable. Set these from the
settings screen (`Ctrl-a i` → Display) or the command palette (`Ctrl-a p`).

### Command Center tabs

`commandCenterTabs` is an ordered array of `{ "id": string, "name": string }`
entries that define the named tab buckets inside the Command Center. The first
entry (index 0) is the **default tab** — it is protected: non-deletable and always
first. Its seeded id is `"default"` and its default name is `"Main"`.

Each pinned pane stores the **id** of its assigned tab in the per-pane tmux option
`@jmux-pinned`. Renaming or reordering tabs only updates this config field — no
pane options are rewritten. Any pane whose stored id is not found in the registry
(including legacy `"1"` values from older versions) is silently routed to the
default tab.

Manage tabs from the command palette (`Ctrl-a p`): create, rename, delete, reorder,
pin a pane to a tab, or move a pane between tabs. The file is hot-reloaded — edits
applied externally take effect immediately without restarting jmux.

See [issue-tracking.md](issue-tracking.md) for adapter and workflow configuration details.
