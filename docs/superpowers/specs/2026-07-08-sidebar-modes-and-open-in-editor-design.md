# Sidebar Modes + Open in Editor — Design

Date: 2026-07-08

## Summary

Two related additions to jmux's chrome:

1. **Sidebar modes.** The sidebar gains a mode switcher. The existing view
   becomes **Session** mode. A new **Worktree** mode enumerates every git
   worktree of the repos that currently have live sessions, grouped by repo,
   and shows each worktree's branch-vs-base diff stat — a launcher-style view
   modeled on the Supabase sidebar.

2. **Open in Editor.** A new toolbar button opens the current directory in the
   user's editor. jmux auto-detects installed editors (Zed, VS Code, Cursor,
   Sublime, plus `$EDITOR`, Finder, Terminal on macOS) and remembers the chosen
   one. Left-click opens; right-click opens a picker.

These are independent features that share one spec because they touch the same
two surfaces (sidebar, toolbar) and ship together.

## Motivation

- The session-centric sidebar is agent-rich but has no repo/worktree overview.
  When several worktrees exist per repo — some with agents, some dormant — there
  is no single place to see them, gauge their size, or jump into a dormant one.
- Opening the current worktree in a GUI editor today means leaving jmux and
  navigating by hand. A one-click affordance that respects the current
  selection removes that friction.

## Feature 1 — Sidebar Modes

### Architecture: `SidebarView` abstraction

`src/sidebar.ts` is already ~960 lines and owns render-plan construction,
session-card painting, scroll math, hover tracking, and click→row mapping.
Adding a second full rendering mode inline would push it past maintainability.

Instead, extract a `SidebarView` interface. Each view owns *its* render plan and
row rendering; `Sidebar` keeps the shared chrome it already owns.

```ts
interface SidebarView {
  /** Mode-specific render plan (analogous to today's buildRenderPlan). */
  buildItems(): RenderItem[];
  /** Paint one item's rows into the grid at the given top screen row. */
  renderItem(grid: CellGrid, screenRow: number, item: RenderItem): void;
  /** Row → selection mapping for click handling. */
  selectionForRow(row: number): SidebarSelection | null;
  /** Height in rows for an item (drives scroll/viewport math). */
  itemHeight(item: RenderItem): number;
}
```

`Sidebar` retains and continues to own:

- the `jmux` header,
- the **new tab row** (`Sessions · Worktrees`),
- viewport/scroll math, viewport clipping, scroll indicators,
- hover-row tracking,
- the version footer,
- the `row → session/group/selection` maps that back click routing.

`Sidebar` delegates `buildItems` / `renderItem` / `itemHeight` / row selection to
the active `SidebarView`. Switching modes swaps the active view and rebuilds the
plan.

Today's session rendering moves into a new `SessionView` (a lift-and-shift of the
current `buildRenderPlan` + `renderSession`). `WorktreeView` is new. This keeps
each mode a self-contained, unit-testable unit and shrinks `sidebar.ts` back to
chrome-only.

**Rejected alternatives:**

- *Inline `mode` flag in `Sidebar`* — every method grows a conditional and the
  file balloons toward ~1400 lines. Worsens the file that is already too big.
- *Two sibling `Sidebar` classes* — cleanest isolation but duplicates all the
  chrome/scroll/hover machinery as copy-paste debt.

### The mode switcher

A segmented tab row rendered just under the `jmux` header:

```
jmux
─────────────────────────
 Sessions │ Worktrees
─────────────────────────
▾ platform
   admin-app-ux    ^1
```

- Costs one sidebar row (plus its separator, matching the existing header
  separator style).
- The active tab is highlighted; the inactive tab is dim.
- Clicking a tab switches modes. Tab hit-regions are mapped like the existing
  group-header rows.
- A prefix chord also cycles modes, following the existing soft-prefix intercept
  pattern in `input-router.ts` (`Ctrl-a` then a key). The binding is `Ctrl-a m`
  ("mode") — `p`/`n`/`i` are already claimed by palette / new-session / settings.
- The active mode persists across restarts via `config.sidebarMode`.

### `SidebarSelection`

Extend the existing union with a worktree variant:

```ts
type SidebarSelection =
  | { type: "overview" }
  | { type: "session"; id: string }
  | { type: "pinnedPane"; paneId: string }
  | { type: "worktree"; repo: string; path: string; sessionId?: string };
```

## Feature 1b — Worktree Mode

### Data model

The unit of a row is a **worktree on disk**, not a tmux session. A worktree may
or may not have a live session.

**Repo discovery — repos of live sessions.** No new config. From
`currentSessions`, resolve each session's bare repo via
`git rev-parse --git-common-dir` (its parent directory is the repo root). This
resolution already exists inside `updateSessionDetails`; it will be extracted
into a shared resolver so both callers use one implementation. Dedupe → the set
of repos to enumerate. Consequence: a repo with no active session anywhere is
invisible until the user opens a session in it (accepted).

### `WorktreeIndex`

A new module (`src/worktree-index.ts`) builds and caches the worktree list.
Refreshed on the same cadence as session details and whenever sessions are
added/removed.

1. Resolve the deduped repo set (above).
2. For each repo: `git worktree list --porcelain` → `{ path, branch, head }[]`.
3. Match each worktree `path` against session directories → `sessionId | null`.
   A worktree has at most one *primary* session; if multiple sessions sit in one
   worktree, the attached/first one wins and the others remain reachable in
   Session mode.
4. For each worktree, compute the diff stat **asynchronously**:
   `git -C <path> diff --shortstat <base>...HEAD`, where `<base>` is the repo's
   default branch. Parse into `{ adds, dels }`.

**Base branch resolution (per repo):** `git symbolic-ref refs/remotes/origin/HEAD`
→ strip to the branch name; fall back to `main`; a global
`config.worktreeMode.baseBranch` override wins when set.

**Caching / cost:** diff stats are cached keyed by `(worktreePath, head)` so they
recompute only when HEAD moves. Per-frame cost is zero; refresh cost is bounded.
All git calls are non-blocking `Bun.spawn`, mirroring `gitBranchForPath`. The
index degrades gracefully — a repo or worktree that errors contributes nothing.

### Rendering

`WorktreeView.buildItems()` produces a `group-header` per repo (reusing the
existing collapse/chevron/scroll/hover chrome unchanged), then 2-row worktree
cards:

```
▾ jmux
   main            Default
   ⏵ fix-osc8-links          +2 −40
     worktrees/fix-osc8 · running
   ○ per-repo-settings        +5 −12
     worktrees/per-repo · no session
▾ tracktile
   ● feat-payments        +2 −117,554
     main · attached
```

- **Row 1:** indicator + branch name (left, truncates) + right-aligned diff stat.
  - Session-backed worktrees reuse the existing agent-state / activity glyphs
    (`⏵` running, `!` waiting, `✓` complete, `●` activity).
  - Session-less worktrees show a dim `○`.
  - The diff stat renders adds in green, dels in red. The primary/default
    worktree shows `Default` in place of a diff stat.
- **Row 2 (dim):** worktree subdir path + session status label
  (`running` / `attached` / `no session`).
- **Default worktree is always shown**, marked `Default`.
- The current worktree's session gets the same active-row chrome (`▎` marker +
  `ACTIVE_BG`) as an active session row today.

### Click behavior

Via the `{ type: "worktree" }` selection:

- **Session-backed** → `switch-client -c <ptyClientName> -t <session>` (same path
  as clicking a session row today).
- **Session-less** → create a session in that worktree dir
  (`new-session -s <sanitizeTmuxSessionName(branch)> -c <path>`) then
  `switch-client` to it, reusing the existing new-session plumbing. The row then
  shows as session-backed on the next refresh.

## Feature 2 — Open in Editor

### Editor registry (`src/editors.ts`)

A built-in list. Each entry: `{ id, name, probe, open }`.

| id | probe | open (`{dir}` = current dir) |
|----|-------|------------------------------|
| `zed` | `which zed` \|\| `/Applications/Zed.app` | `zed {dir}` or `open -a Zed {dir}` |
| `vscode` | `which code` \|\| `Visual Studio Code.app` | `code {dir}` |
| `cursor` | `which cursor` \|\| `Cursor.app` | `cursor {dir}` |
| `subl` | `which subl` \|\| `Sublime Text.app` | `subl {dir}` |
| `editor` | `$EDITOR` set | new tmux window in the current session running `$EDITOR` at `{dir}` |
| `finder` | macOS | `open {dir}` (→ `xdg-open` on Linux) |
| `terminal` | macOS | `open -a Terminal {dir}` |

- Probes run once at startup: `which` lookups + a couple of app-bundle
  `existsSync` checks. Only detected editors enter the picker.
- GUI editors prefer the CLI when present, else `open -a`.
- `$EDITOR` is the terminal-editor path: it opens a **new tmux window in the
  current session** running `$EDITOR` at the dir (`new-window -c {dir} $EDITOR`),
  consistent with how jmux creates windows. It appears as a new window tab.
- On non-macOS, `finder`/`terminal` probes fail and the entries don't appear;
  the file-manager `open` degrades to `xdg-open`.

### What directory opens

The current selection's directory:

- **Session mode** → the active session's cwd.
- **Worktree mode** → the selected worktree's path.

### Toolbar control

A new glyph button placed **between `λ` (claude) and `⚙` (settings)**:

```
◈ ＋ ⏸ ⏏ λ [ed] ⚙
```

- **Left-click** → open the current dir in the remembered editor
  (`config.editor`). If none is remembered yet, open the picker.
- **Right-click** → open the picker (reusing `ListModal`, the remembered editor
  pre-selected). Selecting opens immediately and persists `config.editor`.

Supporting change: thread the mouse button through `onToolbarClick` in
`src/input-router.ts`, and let a right-button event reach the toolbar region
(currently only a bare left-button event triggers there). Contained change,
covered by a new InputRouter test.

### Persistence

`config.editor` (string id) stored in `~/.config/jmux/config.json`, like other
jmux settings.

## Config additions (`JmuxConfig`)

```ts
editor?: string;                          // remembered editor id
worktreeMode?: { baseBranch?: string };   // optional base-branch override
sidebarMode?: "session" | "worktree";     // persisted active mode
```

`sidebarMode` is written when the user switches modes and hot-reloads like other
watched settings.

## Testing

Pure unit tests over the logic modules, matching the repo's no-tmux discipline
(`src/__tests__/*`):

- **`WorktreeView.buildItems`** — grouping by repo, default-worktree-always-shown,
  session matching, collapse behavior — tested the way `buildRenderPlan` is today.
- **Diff-stat parser** — `git diff --shortstat` output → `{ adds, dels }`,
  including the "0 files changed", insertions-only, and deletions-only shapes.
- **Base-branch resolver** — `origin/HEAD` parse with `main` fallback and config
  override.
- **Editor registry** — probe resolution given a mocked `which` / bundle-exists,
  and `open`-command templating for each entry.
- **`InputRouter`** — right-click on the toolbar region dispatches with the right
  button; existing left-click behavior unchanged.
- **`SidebarView` selection mapping** — row → `{ type: "worktree" }` selection,
  and the tab-row → mode-switch mapping.

## Out of scope (YAGNI)

- User-defined custom editors in config.
- Per-repo base-branch config (single global override only).
- Listing repos that have zero sessions.
- A disambiguation UI for multiple sessions in one worktree.
- Diff stats in Session mode.

## Affected files

- `src/sidebar.ts` — extract chrome; delegate to `SidebarView`; add tab row.
- `src/sidebar-views/session-view.ts` (new) — lift-and-shift of current session
  rendering.
- `src/sidebar-views/worktree-view.ts` (new) — worktree rendering.
- `src/worktree-index.ts` (new) — worktree enumeration + diff-stat cache.
- `src/editors.ts` (new) — editor registry + probes + open.
- `src/main.ts` — shared bare-repo resolver, toolbar button, mode switching,
  editor open wiring, worktree click handling.
- `src/renderer.ts` — editor toolbar button.
- `src/input-router.ts` — thread mouse button through `onToolbarClick`; toolbar
  right-click.
- `src/config.ts` / `JmuxConfig` — `editor`, `worktreeMode`, `sidebarMode`.
- `src/types.ts` — `SidebarSelection` worktree variant.
- `src/__tests__/*` — tests listed above.
