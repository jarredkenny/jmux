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

Row chrome today (active `▎`+`ACTIVE_BG`, hover tint) is computed *inside*
`renderSession` (sidebar.ts:760, 830), and the text/background attrs depend on
`isActive`/`isHovered`. A view cannot style rows without that state. So
`renderItem` receives a `RenderItemState`:

```ts
interface RenderItemState {
  screenRow: number;      // top row of this item on screen
  isActive: boolean;      // this item holds the active session/worktree
  isHovered: boolean;     // hovered (and not active)
}

interface SidebarView {
  /** Mode-specific render plan (analogous to today's buildRenderPlan). */
  buildItems(ctx: SidebarViewContext): RenderItem[];
  /** Height in rows for an item (drives scroll/viewport math). */
  itemHeight(item: RenderItem): number;
  /** Paint one item's rows; write click/selection maps into the sink. */
  renderItem(
    grid: CellGrid,
    item: RenderItem,
    state: RenderItemState,
    ctx: SidebarViewContext,
    sink: RowSink,
  ): void;
  /** Scroll-to-active target for this view (session row, or active worktree). */
  activeItemIndex(ctx: SidebarViewContext): number | null;
}
```

`Sidebar` computes `isActive`/`isHovered` from the state it owns (active session
id, hovered row) and the view's `activeItemIndex`, and passes them down; the view
owns the *painting* (glyphs, name/branch attrs, diff stat), the `Sidebar` owns
*deciding* active/hover and the outer chrome fill.

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

- The active tab is highlighted; the inactive tab is dim.
- Clicking a tab switches modes. Tab hit-regions are mapped like the existing
  group-header rows.
- A prefix chord also cycles modes, following the existing soft-prefix intercept
  pattern in `input-router.ts` (`Ctrl-a` then a key, intercepted before tmux —
  the p/n/i/I/g/z/Tab branch around input-router.ts:206). The binding is
  **`Ctrl-a v`** ("view"). `m` is **not** available — `config/defaults.conf:59`
  binds `Ctrl-a m` to the move-window popup; `g`/`i`/`I`/`r`/`k`/`y` are likewise
  claimed. `v` is unbound in `defaults.conf` and not a jmux intercept. Adding it
  means a new branch in the intercept block.
- The active mode persists across restarts via `config.sidebarMode`.

**Sidebar geometry must change.** Today content starts after `HEADER_ROWS = 2`
(sidebar.ts:21), and that constant drives `viewportHeight()` (sidebar.ts:586),
viewport clipping (sidebar.ts:607), and scroll-indicator placement
(sidebar.ts:708). The tab row is **not one row**: the chrome is `jmux` +
separator + tab row + separator = **4 rows** when the switcher is present.
Replace the fixed `HEADER_ROWS` constant with a computed chrome height
(`headerRows()`), and route every current `HEADER_ROWS` reference through it so
viewport height, clipping, scroll math, and screen-row→selection mapping all
shift down consistently. Add tests asserting viewport height, scroll clamp, and
click-row mapping with the tab row present (a regression here silently
mis-maps every click in the sidebar).

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

Today `lookupSessionDetails` (main.ts:3737) already runs, per session,
`display-message` for cwd, `git branch --show-current`, and
`rev-parse --git-common-dir` / `--git-dir` (main.ts:3741, 3749, 3757), but only
derives a display `project` string and does **not** produce reusable repo
identity; `--git-common-dir` can be **relative** (`../.git`) from a subdir, so it
must be resolved against `cwd`. `resolveRepo` centralizes this. Crucially, to
avoid re-running git per session in two places, **`lookupSessionDetails` calls
`resolveRepo` once and stores the enriched result** (`rawCwd`, `RepoIdentity`,
`worktreeRoot`) in the session-detail cache; the worktree index **consumes that
snapshot** and only runs additional git (worktree list, diff) per *repo* on cache
miss — never re-deriving per-session identity. Repo identity for
dedup/enumeration is keyed on the absolute `commonGitDir`.

This means the session-detail cache (`sessionDetailsCache`, main.ts:783) grows
from display fields to a full snapshot: `{ rawCwd, directory, gitBranch,
repo: RepoIdentity, worktreeRoot }`.

**Repo discovery — repos of live sessions.** No new config. Dedupe the snapshot's
`repo.commonGitDir` across sessions. Consequence: a repo with no active session
anywhere is invisible until the user opens a session in it (accepted).

### Generation guard (owns the whole detail snapshot)

The race is not only in the index — `lookupSessionDetails` itself runs
fire-and-forget after `fetchSessions` renders (main.ts:993, 1050) and mutates
`sessionDetailsCache` + `currentSessions` afterward, so a *slow* detail lookup
from an earlier `fetchSessions` can overwrite a newer session set. The generation
number therefore lives at the **session-detail boundary, not just the index**:

- Each `fetchSessions` bumps a generation counter and captures it.
- A `lookupSessionDetails` completion applies to the cache / `currentSessions` /
  sidebar **only if its generation still matches**; otherwise it is dropped.
- Accepted completions call `scheduleRender()` (the existing coalescing path,
  which respects `writesPending`), never a direct synchronous render.
- The worktree index is built from the *applied* snapshot and inherits the same
  generation, so stale worktree-list / diff completions are discarded the same
  way.

### `WorktreeIndex`

A new module (`src/worktree-index.ts`) builds and caches the worktree list from
the applied session snapshot.

Build steps:

1. Resolve the deduped repo set from the snapshot (above) — no per-session git.
2. For each repo: `git --git-dir <commonGitDir> worktree list --porcelain -z`.
   Parse the **full** porcelain state model, not just `{path, branch, head}`:
   `worktree` (path), `HEAD` (oid), `branch` (absent ⇒ **detached**), and the
   `bare`, `detached`, `locked`, `prunable` flags.
3. Match each worktree to sessions by **canonical worktree root** (each session's
   `worktreeRoot` is already in the snapshot from step 1 of discovery — no new
   `--show-toplevel` call). Store **`{ primarySessionId, sessionIds[] }`** per
   worktree, not a single id: several sessions can sit under one worktree, and
   the *active* session may be a secondary one. `primarySessionId` (attached/first)
   is the click target; `sessionIds[]` drives active-highlight and scroll-to
   (`activeItemIndex` returns this worktree if `activeSessionId ∈ sessionIds`).
4. Compute the diff stat **asynchronously** against the resolved base *ref*:
   `git -C <path> diff --shortstat <baseRef>...HEAD`. Detached/bare/locked rows
   skip the diff (see rendering). Parse `--shortstat` into `{ adds, dels }`,
   handling the "0 files changed", insertions-only, and deletions-only shapes.

**Base ref resolution (per repo), in order:**

1. `config.worktreeMode.baseBranch` (if set). Parse tolerantly: accept either a
   bare branch (`main`) or an already-qualified ref (`origin/main`) and don't
   double-prefix (`origin/main` must not become `origin/origin/main`). Prefer the
   remote-qualified form if that ref exists, else the local branch.
2. `git symbolic-ref --short refs/remotes/origin/HEAD` → use the **full remote
   ref** (`origin/main`), not the stripped local branch (a local `main` may be
   missing or stale).
3. Fallbacks: `origin/main`, `origin/master`, then local `main`/`master`.

Diff against the resolved ref directly, and only if `git merge-base <baseRef>
HEAD` succeeds; otherwise the row shows no stat rather than a misleading number.
This also covers **no-remote / never-fetched / brand-new** repos: if none of the
candidate refs resolve, or there is no merge-base, the worktree simply shows no
diff stat (not `Default`, not `+0 −0`).

**`Default` detection is a branch comparison, normalized.** The porcelain
`branch` field is a full ref (`refs/heads/main`); the base ref is remote-form
(`origin/main`). Normalize both to a short branch name (`main`) before comparing
to decide whether a row is "on the base branch" and should show `Default`.
Detached/bare rows are never `Default`.

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

**`createSessionForDir(dir, nameHint)` helper.** This path attaches a tmux
session to an **already-existing** worktree directory — it does **not** run
`wtm create`, so it is distinct from, and does not touch, the new-worktree flow.
That matters because the CLAUDE.md invariant (one sanitized name reused for
directory + `wtm create` arg + session, main.ts:2863) applies only to
*worktree creation*, where the name becomes a directory. Here the directory
already exists and is passed by path; the session name is display-only and need
not equal any directory. Extract the common "make a tmux session in a dir"
tail — currently duplicated across `main.ts` (new-session-modal handler
~main.ts:2851, worktree-issue flow) — that sets OTEL env, switches, and
refreshes. It must:

- Generate a **unique** session name. `sanitizeTmuxSessionName` only rewrites
  `.`/`:` (config.ts:69), **not `/`** — so a raw `<repo>/<branch>` hint would
  leave a slash that tmux target specs choke on. The helper must additionally
  collapse `/` (and whitespace) to `-`, then de-duplicate against existing
  session names with a numeric suffix. Qualify with the repo display name so a
  `main`/`master` (or the same feature branch) in two repos does not collide.
- Handle detached HEAD (name from short SHA).
- Set `OTEL_RESOURCE_ATTRIBUTES` via `buildOtelResourceAttrs`, create with
  `-c <worktreeRoot>`, `switch-client -c <ptyClientName>`, refresh sessions,
  and surface failures through the existing error-modal path.

**Launch/open ordering.** Sidebar clicks start async switches without awaiting
(main.ts:1363, 1382) and `switchSession` updates `currentSessionId` only after
the control command resolves (main.ts:1088). So "click a session-less worktree,
then immediately click Open-in-Editor" could open the *previous* active cwd.
Guard it: track a pending worktree-launch promise; Open-in-Editor resolves the
target cwd from the active `ptyClientName`'s `#{pane_current_path}` **after** any
in-flight launch/switch settles (or is disabled until it does), so the editor
always opens the cwd of the session actually attached.

## Feature 2 — Open in Editor

### Editor registry (`src/editors.ts`)

A built-in list. Each entry is `{ id, name, probe, launch }` where **`launch`
builds an argv array** (`string[]`), never a shell string — so directories with
spaces (`Visual Studio Code.app`, `~/My Repos/x`) and `$EDITOR` with flags can't
break or inject. GUI/file-manager entries are spawned via `Bun.spawn(argv, {…})`
(detached); the `$EDITOR` entry is the one deliberately-tmux path.

| id | probe (mac: CLI on PATH, else app bundle) | launch argv |
|----|-------|------|
| `zed` | `which zed` \|\| `Zed.app` | `["zed", dir]` else `["open","-a","Zed",dir]` |
| `vscode` | `which code` \|\| `Visual Studio Code.app` | `["code", dir]` else `["open","-a","Visual Studio Code",dir]` |
| `cursor` | `which cursor` \|\| `Cursor.app` | `["cursor", dir]` else `["open","-a","Cursor",dir]` |
| `subl` | `which subl` \|\| `Sublime Text.app` | `["subl", dir]` else `["open","-a","Sublime Text",dir]` |
| `editor` | `$EDITOR` set | tmux `new-window` (below) |
| `finder` | macOS only | `["open", dir]` |
| `terminal` | macOS only | `["open","-a","Terminal",dir]` |

- Every GUI editor defines **both** a CLI argv and an `open -a <AppName>`
  fallback, chosen by which probe matched (earlier draft only gave Zed a
  fallback). App-bundle probe checks `/Applications` and `~/Applications`.
- Probes run once at startup: cheap `which` lookups + a couple of `existsSync`
  bundle checks. Only detected editors enter the picker.
- **`$EDITOR`** opens a **new tmux window in the active session** running the
  editor at the dir. `$EDITOR` may itself contain flags (`nvim -u ...`), so the
  window command is built by shell-quoting the resolved cwd and appending it to
  the raw `$EDITOR` string: `new-window -c <dir> "$EDITOR <quoted-dir>"` via the
  existing tmux-quoting helper (`tq`, new-session-modal.ts:17). It appears as a
  new window tab.
- **Platform:** `finder`/`terminal` are macOS-only and simply absent elsewhere
  (no false `xdg-open` claim). If cross-platform "reveal in file manager" is ever
  wanted it will be a *separate* entry with an `xdg-open`/`explorer` argv — out
  of scope here.

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
- **Base-ref resolver** — `origin/HEAD` → full remote ref, config override
  (bare vs `origin/`-qualified, no double-prefix), fallback chain,
  merge-base-missing → no stat, `Default` branch-name normalization
  (`refs/heads/main` vs `origin/main`).
- **`resolveRepo`** — relative `--git-common-dir` resolved to absolute; bare vs
  non-bare; display-name derivation.
- **Session-name qualifier** — repo-qualified uniqueness, `/`→`-` collapse, and
  numeric de-dup for colliding branch names across repos; detached-HEAD naming.
- **Editor registry** — probe resolution given a mocked `which` / bundle-exists;
  argv construction for CLI vs `open -a` fallback; `$EDITOR`-with-flags quoting;
  `finder`/`terminal` absent off-macOS.
- **`ListModal` preselect** — `initialSelectedId` highlights the right row;
  absent → index 0.
- **`InputRouter`** — left vs right button dispatch through `onToolbarClick`,
  row-0 gating (branch row does not fire buttons), existing behavior unchanged.
- **Sidebar geometry** — `headerRows()` with the tab row present: viewport
  height, scroll clamp, and screen-row→selection mapping stay aligned.
- **Generation guard** — a stale `lookupSessionDetails`/worktree completion does
  not overwrite a newer generation's session set or index.
- **Worktree↔session mapping** — active-highlight when `activeSessionId` is a
  *secondary* session under a worktree; click targets `primarySessionId`.
- **`SidebarView` selection mapping** — row → `{ type: "worktree" }` selection,
  and the tab-row → mode-switch mapping.

## Out of scope (YAGNI)

- User-defined custom editors in config.
- Per-repo base-branch config (single global override only).
- Listing repos that have zero sessions.
- A disambiguation UI for multiple sessions in one worktree.
- Diff stats in Session mode.

## Affected files

- `src/sidebar.ts` — extract chrome; add `SidebarViewContext` + `RowSink` +
  `RenderItemState`; replace `HEADER_ROWS` with computed `headerRows()`; delegate
  to `SidebarView`; add tab row + geometry updates.
- `src/sidebar-views/session-view.ts` (new) — lift-and-shift of current session
  rendering.
- `src/sidebar-views/worktree-view.ts` (new) — worktree rendering.
- `src/git-repo.ts` (new) — `resolveRepo(cwd)` canonical identity resolver.
- `src/worktree-index.ts` (new) — worktree enumeration, porcelain parse,
  diff-stat cache, generation guard.
- `src/editors.ts` (new) — editor registry + probes + argv `launch` builders.
- `src/main.ts` — `resolveRepo` in `lookupSessionDetails` + enriched
  `sessionDetailsCache` snapshot; generation counter at the detail boundary;
  toolbar button; mode switching + persistence (watcher echo guard); editor open
  wiring (with launch-ordering guard); worktree click handling; extract
  `createSessionForDir`.
- `src/list-modal.ts` — `initialSelectedId` in `ListModalConfig`.
- `src/renderer.ts` — editor toolbar button.
- `src/input-router.ts` — thread `{ col, row, button }` through `onToolbarClick`;
  row-0 gating; right-click → picker; add `Ctrl-a v` intercept branch for mode.
- `src/config.ts` / `JmuxConfig` — `editor`, `worktreeMode`, `sidebarMode`;
  watcher handling for each.
- `src/types.ts` — `SidebarSelection` worktree variant.
- `src/__tests__/*` — tests listed above.
