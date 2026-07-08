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

The boundary must respect what `Sidebar` currently does during paint: it reads
session contexts, OTEL state, agent-state records, pinned panes, activity, the
active session id, and group-collapse state, and it *writes* the
`row → session / group / selection` maps as it paints. Two consequences shape the
interface:

1. A view needs read access to all that state without owning it. Pass it a
   **`SidebarViewContext`** — a read-only accessor object the `Sidebar`
   constructs each frame (`sessions`, `activeSessionId`, `collapsedGroups`,
   `otelStates`, `agentStateRecords`, `activitySet`, `sessionContexts`,
   `pinnedPanes`, `worktreeIndex`, plus theme/width). Views never mutate it.
2. Row-map writes happen *during* `renderItem`, so the view must own them. The
   `Sidebar` clears the maps each frame and passes a **`RowSink`** the view
   writes into (`mapSession(row, idx)`, `mapGroup(row, label)`,
   `mapSelection(row, sel)`). This resolves the apparent conflict of "Sidebar
   retains the maps": `Sidebar` owns their *lifecycle and storage*; the active
   view owns their *population*.

```ts
interface SidebarView {
  /** Mode-specific render plan (analogous to today's buildRenderPlan). */
  buildItems(ctx: SidebarViewContext): RenderItem[];
  /** Height in rows for an item (drives scroll/viewport math). */
  itemHeight(item: RenderItem): number;
  /** Paint one item's rows; write click/selection maps into the sink. */
  renderItem(
    grid: CellGrid,
    screenRow: number,
    item: RenderItem,
    ctx: SidebarViewContext,
    sink: RowSink,
  ): void;
  /** Scroll-to-active target for this view (session row, or active worktree). */
  activeItemIndex(ctx: SidebarViewContext): number | null;
}
```

`Sidebar` retains and continues to own:

- the `jmux` header,
- the **new tab row** (`Sessions · Worktrees`),
- viewport/scroll math, viewport clipping, scroll indicators,
- hover-row tracking and the active-row chrome (`▎` marker + `ACTIVE_BG`),
- the version footer,
- the storage + per-frame lifecycle of the `row → session / group / selection`
  maps (populated by the active view via the `RowSink`),
- `scrollToActive`, driven by the view's `activeItemIndex`.

`Sidebar` delegates `buildItems` / `itemHeight` / `renderItem` / `activeItemIndex`
to the active `SidebarView`. Switching modes swaps the active view and rebuilds
the plan.

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
  | { type: "worktree"; repoRoot: string; path: string; sessionId?: string };
```

Note: this selection drives *click activation*, not a persistent "selected"
cursor. jmux has no persistent sidebar selection state today (only hover +
active session), and this design does not add one — clicking a worktree row
activates it (switch/create a session). Any feature that needs "the current
directory" (Open in Editor) reads the **active session's cwd**, not a sidebar
selection. See Feature 2.

## Feature 1b — Worktree Mode

### Data model

The unit of a row is a **worktree on disk**, not a tmux session. A worktree may
or may not have a live session.

**Shared git resolver.** Introduce `resolveRepo(cwd)` in a new
`src/git-repo.ts`, returning canonical absolute identity:

```ts
interface RepoIdentity {
  worktreeRoot: string;   // git rev-parse --show-toplevel (absolute)
  commonGitDir: string;   // git rev-parse --git-common-dir, resolved absolute
  isBare: boolean;        // git rev-parse --is-bare-repository
  displayName: string;    // basename of the repo root (bare-repo parent)
}
```

Today `lookupSessionDetails` (main.ts:3737) derives only a display `project`
string for linked worktrees and does not produce reusable repo identity;
`--git-common-dir` can be **relative** (`../.git`) when run from a subdir, so it
must be resolved against `cwd` to an absolute path. `resolveRepo` centralizes
this so both `lookupSessionDetails` and the worktree index share one correct
implementation. Repo identity for dedup/enumeration is keyed on the absolute
`commonGitDir`.

**Repo discovery — repos of live sessions.** No new config. For each session,
run `resolveRepo` on the session's **raw pane cwd** (not the `~`-normalized
display `directory`; see matching below). Dedupe by `commonGitDir`. Consequence:
a repo with no active session anywhere is invisible until the user opens a
session in it (accepted).

### `WorktreeIndex`

A new module (`src/worktree-index.ts`) builds and caches the worktree list.

**Generation guard.** The index consumes a *versioned session snapshot*, not the
live `currentSessions`. `lookupSessionDetails` runs fire-and-forget after
`fetchSessions` renders (main.ts:1050), so raw cwds arrive asynchronously. The
index build takes a monotonically increasing generation number; any async diff
job or rebuild that completes after a newer generation has started is discarded
before it can overwrite fresher data. This prevents stale-cwd builds and
out-of-order diff completions from clobbering the render.

Build steps:

1. Resolve the deduped repo set from the session snapshot (above).
2. For each repo: `git --git-dir <commonGitDir> worktree list --porcelain -z`.
   Parse the **full** porcelain state model, not just `{path, branch, head}`:
   `worktree` (path), `HEAD` (oid), `branch` (absent ⇒ **detached**), and the
   `bare`, `detached`, `locked`, `prunable` flags.
3. Match each worktree to a session by **canonical worktree root**: resolve each
   session's `--show-toplevel` from its raw cwd (a session often sits in a
   *subdirectory* of the worktree, so matching the displayed `directory` text
   would miss). Map worktreeRoot → `sessionId | null`. A worktree has at most one
   *primary* session; if several sessions sit under one worktree, the
   attached/first wins, the rest remain reachable in Session mode.
4. Compute the diff stat **asynchronously** against the resolved base *ref*:
   `git -C <path> diff --shortstat <baseRef>...HEAD`. Detached/bare/locked rows
   skip the diff (see rendering). Parse `--shortstat` into `{ adds, dels }`,
   handling the "0 files changed", insertions-only, and deletions-only shapes.

**Base ref resolution (per repo), in order:**

1. `config.worktreeMode.baseBranch` (if set) → `origin/<name>`, else the name.
2. `git symbolic-ref --short refs/remotes/origin/HEAD` → use the **full remote
   ref** (`origin/main`), not the stripped local branch (a local `main` may be
   missing or stale).
3. Fallbacks: `origin/main`, `origin/master`, then local `main`/`master`.

Diff against the remote ref directly, and only if `git merge-base <baseRef> HEAD`
succeeds; otherwise the row shows no stat rather than a misleading number.

**Caching / cost:** diff stats are cached keyed by
`(worktreePath, head, baseRefOid, configBaseOverride)` so a moved base branch or
a changed config override invalidates correctly (keying on `head` alone would
serve stale stats). Cache is also cleared on config reload. Per-frame cost is
zero; refresh cost is bounded. All git calls are non-blocking `Bun.spawn`,
mirroring `gitBranchForPath`. `--shortstat` on a huge branch can be slow, so it
runs off the render path and only on cache miss. The index degrades gracefully —
a repo or worktree that errors contributes nothing.

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

- **Row 1:** indicator + branch/label (left, truncates) + right-aligned diff stat.
  - Session-backed worktrees reuse the existing agent-state / activity glyphs
    (`⏵` running, `!` waiting, `✓` complete, `●` activity).
  - Session-less worktrees show a dim `○`.
  - The diff stat renders adds in green, dels in red.
- **Row 2 (dim):** worktree subdir path + session status label
  (`running` / `attached` / `no session`, or a worktree-state tag below).
- The current worktree's session gets the same active-row chrome (`▎` marker +
  `ACTIVE_BG`) as an active session row today.

**Worktree state, rendered distinctly** (the earlier draft conflated
"primary / default / base branch" — they are three separate things):

- **On the base branch** (branch == resolved base ref's branch): show `Default`
  in place of a diff stat (the branch-vs-base delta is meaningless there). This
  is a *branch* test, independent of whether the row is the primary worktree.
- **Detached HEAD** (no `branch` line): show the short SHA as the label, no diff
  stat.
- **Bare primary** (`bare` flag, no working dir): render as a non-openable,
  dimmed row — there is nothing to `cd` into or open in an editor.
- **Locked / prunable**: render dimmed with a small tag (`locked` / `prunable`);
  clicking a prunable worktree does nothing (it may not exist on disk).
- All other worktrees show the branch name + branch-vs-base diff stat.

Every real worktree of a discovered repo is listed (including the primary
working worktree when it has one), so the view is a complete per-repo picture.

### Click behavior

Via the `{ type: "worktree" }` selection:

- **Session-backed** → `switch-client -c <ptyClientName> -t <session>` (same path
  as clicking a session row today).
- **Session-less** → create a session in that worktree dir, then `switch-client`
  to it. The row shows as session-backed on the next refresh.
- **Non-openable** rows (bare primary, prunable) are no-ops.

**`createSessionForDir(dir, nameHint)` helper.** Session creation currently
lives inline in several places in `main.ts` (e.g. the new-session-modal handler
around main.ts:2851) and sets OTEL resource env, switches the client, and
refreshes. Extract a single helper so worktree-launch reuses it exactly. It must:

- Generate a **unique, repo-qualified** session name. `sanitizeTmuxSessionName`
  only rewrites `.`/`:` (config.ts:69); two repos with a `main` (or the same
  feature branch) would collide. Qualify with the repo display name
  (`<repo>/<branch>` → sanitized) and de-duplicate against existing session names
  with a numeric suffix.
- Handle detached HEAD (name from short SHA).
- Set `OTEL_RESOURCE_ATTRIBUTES` via `buildOtelResourceAttrs`, create with
  `-c <worktreeRoot>`, `switch-client -c <ptyClientName>`, refresh sessions,
  and surface failures through the existing error-modal path.

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

**Always the active session's working directory** — the cwd of the session the
PTY client is currently attached to — in *both* modes. jmux has no persistent
sidebar "selected" cursor (only hover + active), so "the selected worktree" is
not a well-defined target; the original request ("open the current session dir")
is exactly the active-session cwd. This also makes `$EDITOR` coherent: the new
window is created **in the active session**, which is the same session whose dir
is being opened — no mismatch between "which session gets the window" and "which
dir is opened". Resolution reuses the toolbar actions' existing
`#{pane_current_path}` of the active client.

Non-goal: opening an arbitrary hovered/other worktree's dir from the toolbar.
Launching *into* a worktree is what a worktree-row click already does.

### Toolbar control

A new glyph button placed **between `λ` (claude) and `⚙` (settings)**:

```
◈ ＋ ⏸ ⏏ λ [ed] ⚙
```

- **Left-click** → open the active session's cwd in the remembered editor
  (`config.editor`). If none is remembered yet, open the picker.
- **Right-click** → open the picker (reusing `ListModal`, the remembered editor
  pre-selected). Selecting opens immediately and persists `config.editor`.

Supporting change (corrected from the earlier draft): the toolbar path in
`src/input-router.ts` (input-router.ts:346) **already** dispatches on any
button-down — left *or* right — but it discards the button code and fires for
*every* toolbar row. The change is to (a) thread `{ col, row, button }` through
`onToolbarClick`, (b) only trigger action buttons on **row 0** (so with
`windowBranchesEnabled` a click on the branch row doesn't fire buttons), and
(c) branch on button: left → open, right → picker. Covered by an InputRouter
test asserting left vs right dispatch and row-0 gating.

**`ListModal` preselect gap:** `ListModal` currently supports only
`defaultQuery` and always starts at `selectedIndex = 0` (list-modal.ts:21), so it
cannot pre-highlight the remembered editor as promised. Add an optional
`initialSelectedId` to `ListModalConfig` (falls back to index 0) — a small,
self-contained addition with its own test.

### Persistence

`config.editor` (string id) stored in `~/.config/jmux/config.json`, like other
jmux settings.

## Config additions (`JmuxConfig`)

```ts
editor?: string;                          // remembered editor id
worktreeMode?: { baseBranch?: string };   // optional base-branch override
sidebarMode?: "session" | "worktree";     // persisted active mode
```

**Config hot reload is not automatic.** The config watcher applies known settings
explicitly (main.ts:3468); adding keys to `JmuxConfig` hot-applies nothing by
itself. The watcher must gain explicit handling for: `sidebarMode` (swap the
active view), `editor` (update the remembered id), and `worktreeMode.baseBranch`
(invalidate the diff-stat cache so stats recompute against the new base). Writing
`sidebarMode` on an in-app mode switch must not fight the watcher (guard against
the self-write echo, as existing settings do).

## Testing

Pure unit tests over the logic modules, matching the repo's no-tmux discipline
(`src/__tests__/*`):

- **`WorktreeView.buildItems`** — grouping by repo, primary/detached/bare/locked/
  prunable row states, base-branch row shows `Default`, session matching by
  worktree root, collapse behavior — tested the way `buildRenderPlan` is today.
- **Porcelain parser** — `worktree list --porcelain -z` → full state model,
  including detached (no `branch`), `bare`, `locked`, `prunable`.
- **Diff-stat parser** — `git diff --shortstat` output → `{ adds, dels }`,
  including the "0 files changed", insertions-only, and deletions-only shapes.
- **Base-ref resolver** — `origin/HEAD` → full remote ref, config override,
  fallback chain, and merge-base-missing → no stat.
- **`resolveRepo`** — relative `--git-common-dir` resolved to absolute; bare vs
  non-bare; display-name derivation.
- **Session-name qualifier** — repo-qualified uniqueness + numeric de-dup for
  colliding branch names across repos; detached-HEAD naming.
- **Editor registry** — probe resolution given a mocked `which` / bundle-exists,
  and `open`-command templating for each entry.
- **`ListModal` preselect** — `initialSelectedId` highlights the right row;
  absent → index 0.
- **`InputRouter`** — left vs right button dispatch through `onToolbarClick`,
  row-0 gating (branch row does not fire buttons), existing behavior unchanged.
- **`WorktreeIndex` generation guard** — a stale async completion does not
  overwrite a newer generation's result.
- **`SidebarView` selection mapping** — row → `{ type: "worktree" }` selection,
  and the tab-row → mode-switch mapping.

## Out of scope (YAGNI)

- User-defined custom editors in config.
- Per-repo base-branch config (single global override only).
- Listing repos that have zero sessions.
- A disambiguation UI for multiple sessions in one worktree.
- Diff stats in Session mode.

## Affected files

- `src/sidebar.ts` — extract chrome; add `SidebarViewContext` + `RowSink`;
  delegate to `SidebarView`; add tab row.
- `src/sidebar-views/session-view.ts` (new) — lift-and-shift of current session
  rendering.
- `src/sidebar-views/worktree-view.ts` (new) — worktree rendering.
- `src/git-repo.ts` (new) — `resolveRepo(cwd)` canonical identity resolver.
- `src/worktree-index.ts` (new) — worktree enumeration, porcelain parse,
  diff-stat cache, generation guard.
- `src/editors.ts` (new) — editor registry + probes + open.
- `src/main.ts` — use `resolveRepo` in `lookupSessionDetails`; toolbar button;
  mode switching + persistence (with watcher echo guard); editor open wiring;
  worktree click handling; extract `createSessionForDir`.
- `src/list-modal.ts` — `initialSelectedId` in `ListModalConfig`.
- `src/renderer.ts` — editor toolbar button.
- `src/input-router.ts` — thread `{ col, row, button }` through `onToolbarClick`;
  row-0 gating; right-click → picker.
- `src/config.ts` / `JmuxConfig` — `editor`, `worktreeMode`, `sidebarMode`;
  watcher handling for each.
- `src/types.ts` — `SidebarSelection` worktree variant.
- `src/__tests__/*` — tests listed above.
