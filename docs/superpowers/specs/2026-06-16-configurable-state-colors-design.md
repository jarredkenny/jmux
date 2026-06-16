# Configurable agent-state colors

## Problem

The colors used to indicate agent state — **Running**, **Waiting**, and
**Complete** — are hardcoded throughout jmux's UI (palette green/yellow/blue).
Users want to recolor these states to suit their terminal theme or preferences.

## Scope

Make the three agent-state colors configurable. A configured color drives
**every** place a state is shown:

- Sidebar indicators: running dot (`⏵`), waiting flag (`!`), complete check
  (`✓`), and the per-session state label.
- Command Center breakdown row: `n RUN  n WAIT  n DONE`.
- Command Center glass tile borders.

Out of scope (deliberately): backgrounds, toolbar/modal chrome, and making the
bold/dim **emphasis** configurable. Emphasis is fixed and meaningful (waiting is
bold = needs you; complete is dim = receded). A configured color swaps only the
hue.

## Color format

Named ANSI colors only — the 16 standard + bright names mapping to palette
indices 0–15 (`green`→2, `brightblue`→12, …). This keeps the picker a simple
cycle list and respects the user's terminal theme. No hex / truecolor / raw
palette indices.

Defaults (unchanged behavior): `running=green`, `waiting=yellow`,
`complete=blue`.

## Design

### Single source of truth — `src/state-colors.ts` (new)

- `STATE_COLOR_NAMES`: the 16 valid ANSI names (drives picker options).
- `colorNameToPalette(name): number | null` — case-insensitive lookup, `null`
  for unknown names.
- `DEFAULT_STATE_COLORS: Record<AgentState, name>`.
- `resolveStateColors(cfg?): Record<AgentState, number>` — resolves each state
  to a palette index, falling back to that state's default on a missing or
  invalid name. This is the only place defaults + validation live, so the config
  can never apply an invalid color.

### Config — `src/config.ts`

Add `stateColors?: StateColorConfig` to `JmuxConfig`, where
`StateColorConfig = { running?: string; waiting?: string; complete?: string }`.
Stored as human-readable names in `~/.config/jmux/config.json`. The type lives
in `config.ts`; `state-colors.ts` imports it (no import cycle).

### Sidebar — `src/sidebar.ts`

The three module-level `AGENT_STATE_*_ATTRS` consts become instance state built
from a resolved palette map. New `setStateColors(map)` rebuilds them, preserving
each state's existing modifier (running plain, waiting bold, complete dim). The
indicator switch, `LABEL_BY_STATE`, and breakdown row read the instance attrs.
Constructor initializes from defaults so untouched config is byte-identical to
today.

### Glass — `src/glass/view.ts`

`AGENT_BORDER_PALETTE` const becomes an instance field seeded from
`GlassViewOptions.stateColors` (default green/yellow/blue) with a
`setStateColors(map)` method. `drawTile` reads the instance map.

### Wiring — `src/main.ts`

- Seed sidebar (`sidebar.setStateColors(...)`) and glass
  (`stateColors: resolveStateColors(...)`) at construction.
- Config watcher recomputes `resolveStateColors(updated.stateColors)` and pushes
  to sidebar + glass, then `scheduleRender()` — same hot-apply path as sidebar
  width.
- `buildSettingsCategories`: three `list`-type `SettingDef`s under **Display**
  ("Running color", "Waiting color", "Complete color"), options =
  `STATE_COLOR_NAMES`, `onOptionSelect` persists the merged `stateColors`.
- `buildPaletteCommands` + `handlePaletteAction`: three `setting-*-color`
  commands opening a `ListModal` of the 16 names; selection persists the merged
  `stateColors`. Persistence relies on the existing config-watcher hot-apply,
  matching how sidebar width works from the palette.

## Testing

- `src/__tests__/state-colors.test.ts`: defaults, all 16 name→palette mappings,
  invalid/missing fallback per state, case-insensitivity.
- Sidebar render-plan test: configure a non-default running color, render, assert
  the running indicator cell carries the configured palette fg.

## Rejected alternative

A full theme system (configurable backgrounds, chrome, per-state emphasis). Much
larger surface than requested; YAGNI.
