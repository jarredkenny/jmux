# Sidebar Field Toggles

Make every non-critical field shown in the session sidebar individually toggleable from the Settings modal, and persist the state in `~/.config/jmux/config.json`.

## Background

After landing the OTEL-context feature, the sidebar carries more information per session card than some users want — cache timer, mode badge, Linear ID, MR / pipeline glyph, branch, and three row-3 telemetry fields (cost, last tool, idle time). The user wants to strip the sidebar down to whatever subset matches their workflow.

A precedent already exists: `cacheTimers` is a top-level config key surfaced as a toggle in the Settings modal. This spec generalizes that approach to all eight non-critical fields and centralizes them under a new `sidebarFields` config object and a new "Sidebar fields" Settings section.

## Scope

In-scope:

- New `sidebarFields` object on `JmuxConfig` with eight optional booleans.
- Gating logic in the view layer (`buildSessionView`, `buildSessionRow3`) — disabled fields become `null` and the renderer writes nothing.
- New "Sidebar fields" section in the Settings modal with one boolean toggle per field.
- Removal of the existing top-level `Cache timers` toggle from the Display section (the new Sidebar fields section replaces it).
- Back-compat read on the old top-level `cacheTimers` key — when `sidebarFields.cacheTimer` is unset and `cacheTimers` is set, fall back to the legacy value.
- Hot-reload behavior: changes to the config file (including manual edits) take effect without restart, matching the existing watcher behavior.

Out-of-scope:

- Toggling the col-1 alert glyphs (error, MCP-down, attention, activity). These are critical and stay always-on.
- Toggling the session name, active marker bar, or the active/hover background.
- Variable-height rows. Sessions remain uniformly 3 rows tall regardless of which row-3 fields are enabled — empty row 3 is acceptable.
- Top-level palette commands like "Toggle cost". The Settings modal is the single entry point.

## Design

### Config shape

`src/config.ts` adds:

```ts
export interface SidebarFieldsConfig {
  cacheTimer?: boolean;
  modeBadge?: boolean;
  linearId?: boolean;
  mrAndPipeline?: boolean;
  branch?: boolean;
  cost?: boolean;
  lastTool?: boolean;
  idleTime?: boolean;
}

export interface JmuxConfig {
  // ... existing fields ...
  sidebarFields?: SidebarFieldsConfig;
}
```

Default: every field is treated as `true` when the flag is `undefined`. The natural place to materialize defaults is a small helper:

```ts
export function resolveSidebarFields(cfg: JmuxConfig): Required<SidebarFieldsConfig> {
  const fields = cfg.sidebarFields ?? {};
  // Back-compat: legacy top-level cacheTimers key
  const legacyCacheTimer = cfg.cacheTimers !== false;
  return {
    cacheTimer: fields.cacheTimer ?? legacyCacheTimer,
    modeBadge: fields.modeBadge ?? true,
    linearId: fields.linearId ?? true,
    mrAndPipeline: fields.mrAndPipeline ?? true,
    branch: fields.branch ?? true,
    cost: fields.cost ?? true,
    lastTool: fields.lastTool ?? true,
    idleTime: fields.idleTime ?? true,
  };
}
```

The legacy `cacheTimers` key is preserved on `JmuxConfig` (already there). When the user toggles cache timer through the new UI, we write to `sidebarFields.cacheTimer` only — the old key is read but no longer written. A user editing the file by hand can use either key; the new key wins when both are set.

### Gating in the view layer

`buildSessionView` (`src/session-view.ts`) accepts a new `fields: SidebarFieldsConfig`-shaped argument (or the resolved `Required<SidebarFieldsConfig>` — pick whichever is more ergonomic at the call site, likely the resolved form). For each field controlled by the toggles:

- `linearId`: when `fields.linearId === false`, return `linearId: null`.
- `branch`: when `fields.branch === false`, return `branch: null`.
- `mrId` and `pipelineState`: when `fields.mrAndPipeline === false`, return both as `null`. They share a toggle because the pipeline glyph is positionally tied to the MR ID — toggling them independently would leave a glyph dangling.
- `timerText`: when `fields.cacheTimer === false`, return `timerText: null` and `timerRemaining: 0`. (The existing `Sidebar.cacheTimersEnabled` plumbing is replaced by this — see below.)
- `modeBadge`: when `fields.modeBadge === false`, return `modeBadge: null`. This implicitly disables the compaction marker too, which is correct (they share the slot).

`buildSessionRow3` (`src/session-view.ts`) gains the same `fields` argument. Currently it derives `costText` / `toolText` / `idleText` from state. Each derivation gains a flag check:

- `costText`: when `fields.cost === false`, set to `null`.
- `toolText`: when `fields.lastTool === false`, set to `null`.
- `idleText`: when `fields.idleTime === false`, set to `null`.

The existing drop-priority logic continues to work unchanged — disabled fields look identical to absent fields to the candidate enumeration.

### Wiring in the sidebar

`Sidebar.cacheTimersEnabled` (the boolean) is removed. In its place, `Sidebar` gains a `sidebarFields: Required<SidebarFieldsConfig>` field (defaulting to all-true) with a setter:

```ts
setSidebarFields(fields: Required<SidebarFieldsConfig>): void {
  this.sidebarFields = fields;
}
```

`renderSession` no longer reads `cacheTimersEnabled` — it always passes `this.sidebarFields` through to `buildSessionView` and `buildSessionRow3`. Those helpers do all gating.

### main.ts wiring

The current pattern is:

```ts
let cacheTimersEnabled = configStore.config.cacheTimers !== false;
sidebar.cacheTimersEnabled = cacheTimersEnabled;
```

This becomes:

```ts
let sidebarFields = resolveSidebarFields(configStore.config);
sidebar.setSidebarFields(sidebarFields);
```

The config-watcher block (currently around `main.ts:2845`) updates similarly: on reload, recompute `sidebarFields` from the new config and push it to the sidebar.

### Settings modal

`buildPaletteCommands` already builds the Settings sections. Add a new section "Sidebar fields" with eight `boolean` items, each in the existing pattern:

```ts
{
  id: "sidebar-cache-timer", label: "Cache timer", type: "boolean" as const,
  getValue: () => sidebarFields.cacheTimer ? "on" : "off",
  onToggle: () => {
    sidebarFields = { ...sidebarFields, cacheTimer: !sidebarFields.cacheTimer };
    sidebar.setSidebarFields(sidebarFields);
    configStore.set("sidebarFields", { ...configStore.config.sidebarFields, cacheTimer: sidebarFields.cacheTimer });
  },
},
// ... seven more for modeBadge, linearId, mrAndPipeline, branch, cost, lastTool, idleTime
```

The eight items use these labels in this order:

1. Cache timer
2. Mode badge
3. Linear ID
4. MR & pipeline
5. Branch
6. Cost
7. Last tool
8. Idle time

The existing top-level `Cache timers` toggle in the Display section is removed. The Display section continues to host the sidebar-width and info-panel-width settings.

A small helper inside `main.ts` (`updateSidebarField(key, value)`) keeps each `onToggle` call site terse — the `{ ...sidebarFields, [key]: value }` and `configStore.set` plumbing lives in one place.

### Persistence semantics

When the user toggles via the Settings modal, only the changed key is written under `sidebarFields`. Other keys remain untouched in the config file. If the user has only ever toggled `cost` off, the config file contains `"sidebarFields": { "cost": false }` — every other field falls through to its default (`true`). This is consistent with how every other config key in jmux is persisted.

The legacy `cacheTimers` top-level key is left in place if the user already has it. We do not auto-migrate (no need — `resolveSidebarFields` reads it). New writes go to `sidebarFields.cacheTimer`. The user can manually delete the legacy key once they're satisfied.

## Data flow

```
~/.config/jmux/config.json
  ↓ ConfigStore.reload (existing watcher)
JmuxConfig
  ↓ resolveSidebarFields(cfg)
Required<SidebarFieldsConfig>
  ↓ sidebar.setSidebarFields(...)
Sidebar.sidebarFields
  ↓ passed into buildSessionView / buildSessionRow3 in renderSession
Per-field null gating
  ↓
SessionView shape (with nulls for disabled fields)
  ↓
Existing renderer paths (no new conditionals)
```

## Error handling

- **Missing `sidebarFields` object** — `resolveSidebarFields` materializes defaults from `undefined`. Always safe.
- **Partial `sidebarFields` object** — same; per-key `??` fallback.
- **Legacy `cacheTimers: false`** — flows into `sidebarFields.cacheTimer = false` via the back-compat branch.
- **Both keys present, conflicting** — new key wins (`?? legacyCacheTimer` only fires when the new key is `undefined`).
- **Bogus values** (e.g., `"yes"` instead of `true`) — falls through to `??` since the value is truthy. We accept this as user error; type-tightening is out of scope.

## Testing

### `src/__tests__/config.test.ts` (extend)

Three tests covering `resolveSidebarFields`:
- All defaults when no `sidebarFields` and no `cacheTimers`.
- Back-compat: `cacheTimers: false` → `cacheTimer: false`, others `true`.
- New key wins: `sidebarFields.cacheTimer: true` + `cacheTimers: false` → `cacheTimer: true`.

### `src/__tests__/session-view.test.ts` (extend)

One test per toggle (8 total), each asserting the relevant field becomes `null` when its flag is `false`:
- `linearId` toggle → `view.linearId === null`.
- `branch` toggle → `view.branch === null`.
- `mrAndPipeline` toggle → `view.mrId === null` and `view.pipelineState === null`.
- `cacheTimer` toggle → `view.timerText === null`, `view.timerRemaining === 0`.
- `modeBadge` toggle → `view.modeBadge === null`, including with both `permissionMode: "plan"` and a recent `lastCompactionTime` (the badge slot stays empty).
- `cost` toggle → `buildSessionRow3` output does not contain `"$"`.
- `lastTool` toggle → output does not contain the tool name.
- `idleTime` toggle → output does not contain `"idle"`.

### `src/__tests__/sidebar.test.ts` (extend)

Two integration tests:
- Disabling `branch` makes the branch text disappear from the rendered grid.
- Disabling all three row-3 fields (`cost`, `lastTool`, `idleTime`) leaves row 3 blank but keeps the session 3 rows tall (subsequent sessions render at the expected offset).

## Migration / compatibility

- Existing `cacheTimers` key is read forever via the back-compat fallback. No flag day.
- `Sidebar.cacheTimersEnabled` (the public field) is removed in this change. Call sites: `main.ts` (six references — initial wire-up, OTEL keepalive guard, the soon-removed Display-section toggle, the config-watcher branch) and the existing test `cacheTimersEnabled false suppresses timer rendering` in `sidebar.test.ts`. The test migrates to `sidebar.setSidebarFields({ ..., cacheTimer: false, ... })`.
- `JmuxConfig.cacheTimers` stays on the type — removing it would break users with the legacy key in their config file.
- The OTEL keepalive guard at `main.ts:487` (`if (cacheTimersEnabled && otelReceiver.getActiveSessionIds().length > 0)`) becomes `if (sidebarFields.cacheTimer && ...)` so the cache-timer tick interval still gates correctly when the timer is off.

## Open questions resolved during brainstorming

- **Scope of toggles**: Fork B chosen — all 8 non-critical fields toggleable, including session metadata (Linear ID, MR, branch). Col-1 alerts stay always-on.
- **UX entry point**: Fork X chosen — toggles live in the Settings modal under a new "Sidebar fields" section. No top-level palette commands per toggle.
- **MR vs pipeline split**: combined into one toggle. The pipeline glyph is positionally tied to the MR ID; splitting would leave the glyph dangling.
- **Mode badge vs compaction marker split**: combined. Same column slot, same visual concept ("session-state badge").
- **Variable height when row 3 is empty**: rejected. All sessions remain 3 rows tall regardless of which row-3 fields are enabled. Empty row 3 is acceptable; it preserves the no-jank invariant from the prior change.
