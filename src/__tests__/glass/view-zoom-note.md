# Manual regression: same-window zoom under lazy keep-warm

GlassView spawns real tmux clients, so this can't be a unit test (project rule:
tests never spawn tmux). Run it by hand after any change to GlassView tiling.

## Setup
1. Create a session with TWO panes in ONE window: `tmux split-window`.
2. Pin BOTH panes to DIFFERENT tabs:
   - `jmux ctl pane pin --target %A --tab default`
   - `jmux ctl pane pin --target %B --tab backend`
3. Open the Command Center.

## Steps
- Switch to the "default" tab (Ctrl-a 1): tile %A renders zoomed/full-bleed.
- Switch to "backend" (Ctrl-a 2): tile %B renders; %A stays warm.
- Switch back to "default": %A still renders correctly (no lost zoom, no blank tile).

## Pass criteria
- Neither pane's home window is left in a broken zoom state on teardown
  (leave the Command Center → both panes visible side-by-side again).
- No pane is moved/broken (non-destructive invariant holds).

## Known limitation
Two panes in the SAME window cannot both be full-bleed at once (zoom is
window-global). When both are pinned (to any tabs), only the active-tab tile
zooms; this is expected, not a bug. Prefer one-agent-per-session.
