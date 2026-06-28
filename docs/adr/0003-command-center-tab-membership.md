# Command Center tab membership = stable id on the pane + name/order in the config registry

## Status

accepted

## Context & decision

The Command Center gained named tabs so users can group pinned panes into separate
buckets (e.g. "Main", "Backend", "Infra"). Every pinned pane belongs to exactly
one tab. We needed to represent that membership in a way that supports:

- **Rename without pane fan-out.** Renaming a tab from "Backend" to "Infra"
  should not require writing to every pane option that references it.
- **Order + display name without bloating the pane option.** Tabs have a user-
  visible name and a deliberate ordering — neither belongs in the tmux option.
- **Stable identity across renames.** If a pane records `"backend"` and the user
  renames that tab, the pane should still belong to it.

We split the representation across two stores:

1. **Per-pane tmux option `@jmux-pinned` holds the tab's stable id** (e.g.
   `"default"`, `"backend"`). This extends ADR 0002: the option that previously
   held just `"1"` (present/absent) now carries a meaningful string id. Panes only
   know *which tab* they belong to, not what that tab is called or where it sits in
   the strip.

2. **`~/.config/jmux/config.json` key `commandCenterTabs` holds `{id, name}[]`** —
   the ordered list of all tabs. This is the sole authority for tab display names
   and strip ordering. Tab CRUD (create, rename, delete, reorder) touches only this
   file, never the pane options.

Lookup is mediated by `resolveTabId(rawValue, tabs)`: a raw pane option value is
resolved to the matching tab id, or falls back to the **default tab** (index 0)
if the id is absent from the registry or is the legacy value `"1"`. This gives
backward compatibility without a migration step.

## Considered alternatives

- **Store the display name in `@jmux-pinned` instead of an id** — rejected.
  Rename would then require rewriting the option on every pane that belongs to the
  tab — an N-pane fan-out with a drift window if any write fails. Storing a stable
  id removes that coupling entirely.
- **Store membership only in `config.json` (a per-tab pane id list)** — rejected.
  The CLI and TUI both write `@jmux-pinned` (ADR 0002 boundary), and `config.json`
  is TUI-owned. Having agents write both would reintroduce the clobber-race that
  ADR 0002 was designed to avoid.
- **Embed tab order/name in the pane option** — rejected for the same fan-out
  reasons as storing display names: every reorder or rename would require touching
  all pane options belonging to that tab.

## Consequences

- **Rename is O(1).** Updating a tab name or reordering tabs writes only to
  `config.json`; zero pane options change.
- **Empty tabs are representable.** The registry can contain a tab with no pinned
  panes, which is useful when a user creates a tab before pinning anything to it.
  This would be impossible if membership were tracked solely as pane-side ids.
- **Legacy pins continue to work.** Panes written by older jmux versions with
  `@jmux-pinned = "1"` resolve to the default tab automatically via `resolveTabId`.
  No migration script is needed.
- **The default tab (index 0, id `"default"`) is protected.** It is non-deletable
  and always first, ensuring there is always a valid fallback target for
  `resolveTabId` and for auto-detected agent panes that have no explicit tab.
- **Config-watch drives live reload.** The TUI watches `config.json`; a change to
  `commandCenterTabs` (from an external editor or a palette action that persists
  tabs) triggers `normalizeTabs` + clamp of the active tab selection + strip
  re-render, with no TUI restart required.
