# jmux UX redesign — Projects, Sessions, Worktrees

Date: 2026-05-10
Status: Approved
Target release: v0.20.0

## 1. Motivation

Today jmux groups sessions by wtm's bare-repo basename — a *repo* concept. Sidebar rows are tmux sessions. Linear data appears only if external agents populate `SessionContext.issues`; jmux core has no Linear awareness.

The mental model the user actually wants is hierarchical: **Linear Project** → **Repo(s)** → **Issue** → **Worktree** → **Session**. A single Linear project can span multiple repos, and the typical unit of work is "one worktree per issue". The redesign reshapes jmux around this hierarchy: projects become first-class, the sidebar becomes issue-anchored, and the new-session flow is issue-first.

This spec covers the conceptual model, data layer, config, sidebar UI, modal flow, lifecycle behaviour, CLI extensions, migration, and testing strategy required to land the redesign in a single coordinated release.

## 2. Conceptual model

### 2.1 Entities

```
Workspace (1)
└── Project (N)              ← from issue tracker (Linear); opted-in via config
    ├── Repo[] (1..N)        ← declared in config per project
    └── Issue (N)            ← from issue tracker
        └── Worktree (0..1)  ← strict 1:1 when present
            └── Session (0..1)  ← tmux session, strict 1:1 with worktree

Unlinked Session (N)         ← any tmux session not tied to an issue/worktree
```

**Vocabulary** (canonical names used in code, docs, and UI):

- **Project** — an opted-in project from the issue tracker. Has a stable tracker ID, a display name (overridable), and 1+ associated **Repos**.
- **Repo** — a path on disk, expected to be a git repo (typically a bare repo for wtm). Belongs to one or more Projects.
- **Issue** — a tracker issue inside a Project. Has a tracker ID (e.g., `JWT-12`). Optionally has a Worktree.
- **Worktree** — a git worktree on disk, named after the issue's branch identifier. Belongs to exactly one Issue while linked. Created via wtm.
- **Session** — a tmux session, 1:1 with its Worktree when linked. Otherwise an **Unlinked Session**.

### 2.2 Invariants

1. A linked Session always has exactly one Worktree, exactly one Issue, exactly one Project, exactly one Repo.
2. An Issue has 0 or 1 Worktree. Two Worktrees pointing at the same Issue is illegal — second creation jumps to the existing one.
3. A Project's repos are opt-in; jmux never auto-discovers a repo as belonging to a Project.
4. Removing a Project from config does not delete worktrees on disk; their Sessions become Unlinked.

### 2.3 Out of scope

- Multi-issue worktrees (one branch addressing two issues). If needed, link to the primary issue and reference the second in the MR body.
- Cross-project repo membership inferred automatically. A repo belongs only to projects whose config explicitly names it.
- Worktrees not created by jmux/wtm being elevated to "linked" automatically. They render as Unlinked unless the user runs `jmux ctl issue link` or auto-detection picks them up by branch name.

## 3. Data layer

### 3.1 `IssueTracker` interface

A new module `src/issue-tracker/types.ts` defines the contract. `LinearTracker` is the first implementation. The interface keeps the rest of the codebase tracker-agnostic.

```ts
// src/issue-tracker/types.ts
export interface IssueTracker {
  readonly kind: "linear" | "github" | "jira"

  // Discovery — used by project-onboarding palette command
  listAccessibleProjects(): Promise<TrackerProject[]>

  // Hot path — drives sidebar
  listIssuesForProjects(projectIds: string[], opts: IssueListOpts): Promise<TrackerIssue[]>
  getIssue(id: string): Promise<TrackerIssue | null>

  // MR / branch correlation — used for status badges
  getMergeRequestForIssue(id: string): Promise<TrackerMR | null>

  // Capabilities reported by the tracker
  capabilities(): TrackerCapabilities
}

export interface IssueListOpts {
  assignedToMe?: boolean
  includeClosed?: boolean
}
```

`TrackerProject`, `TrackerIssue`, `TrackerMR` are tracker-agnostic value objects (issue identifier, title, status, assignee, branch name, MR ID/state, project ID). The Linear-specific types from `src/adapters/linear.ts` become an internal concern of `LinearTracker`.

A factory `getIssueTracker(config)` returns the configured implementation, or `null` if nothing is configured. `null` is the "everything is Unlinked" degraded mode.

### 3.2 `IssueCache`

A single cache lives in main.ts, keyed by issue ID:

```
IssueCache
├── projects: Map<projectId, TrackerProject>
├── issues:   Map<issueId,  { issue: TrackerIssue, fetchedAt }>
└── mrs:      Map<issueId,  { mr: TrackerMR | null, fetchedAt }>
```

**Refresh policy**

- **Initial fetch** at jmux startup: list configured projects + their issues (assigned to me OR has-session, plus open status), in parallel. Sidebar renders before completion; rows arrive incrementally.
- **Periodic refresh** every 60s (configurable via `issueTracker.refreshIntervalMs`).
- **On-demand refresh**: explicit palette command, lazy refresh (>30s old) when the new-session modal opens, and eager fetch on session creation to populate row metadata.
- **No webhooks/sockets.** Polling is sufficient and avoids exposing local ports.

**Persistence: in-memory only.** The Linear payload is small and refreshes fast. Avoiding persistence eliminates the stale-on-disk class of bugs. The canonical "which projects am I tracking" lives in the config file.

### 3.3 Failure modes

- **Initial fetch fails** → sidebar renders without issue rows; non-blocking banner offers retry. Existing sessions still appear (Unlinked or by saved metadata).
- **Periodic refresh fails** → silent retry on next interval; banner only after 3 consecutive failures.
- **Single `getIssue` call fails** (e.g., during session creation) → row creation falls back to Unlinked with a "tracker error" badge; user can retry-link from a row action.
- **Auth missing** → startup banner instructs user to set the env var named in `issueTracker.linear.apiKeyEnv` and run `jmux ctl auth status` to verify.

## 4. Config schema

Config file is `~/.config/jmux/config.json`. The redesign adds two top-level entries and revises `issueWorkflow`. All other existing fields are preserved.

### 4.1 New: `issueTracker`

```jsonc
{
  "issueTracker": {
    "kind": "linear",
    "linear": {
      "apiKeyEnv": "LINEAR_API_KEY",
      "workspaceId": "anthropic"
    },
    "refreshIntervalMs": 60000,
    "issueListScope": "assignedToMeOrWithSession"
  }
}
```

API keys live in env vars only; `apiKeyEnv` names the variable. If the env var is missing at startup, jmux logs a single warning and runs in Unlinked-only mode.

**`issueListScope` enum** — defines which issues populate the sidebar and the modal picker, and is the default for `jmux ctl issue list --scope`:

| Value | Includes |
|---|---|
| `assignedToMe` | Open issues assigned to me (excludes Done, Cancelled) |
| `withSession` | Any issue with a linked session, regardless of status or assignee |
| `assignedToMeOrWithSession` | Union of the two above (default) |
| `all` | All open issues in the project (excludes Done, Cancelled) |

Closed issues (Done, Cancelled) are excluded from every scope by default. The `--include-closed` flag on `issue list` widens any scope to include them. Linked sessions on Done/Cancelled issues still render in the sidebar (because `withSession` matches regardless of status), but a refresh after archive will not re-add them — see Section 7.2.5.

### 4.2 New: `linearProjects`

```jsonc
{
  "linearProjects": [
    {
      "id": "abc-123-uuid-from-linear",
      "displayName": "Q1 Auth Migration",
      "repos": [
        { "path": "/Users/jarred/Code/work/webapp" },
        { "path": "/Users/jarred/Code/work/gateway" }
      ],
      "defaultRepoIndex": 0,
      "defaultBaseBranch": "main"
    }
  ]
}
```

- `id` is opaque from the tracker; comparison is exact-string.
- `repos` is always an array even when single-repo (no special-case shape).
- A repo path can appear in multiple projects' `repos` arrays.
- `defaultRepoIndex` is the tiebreaker for multi-repo projects; if present and nothing else hints, the modal skips the repo prompt.
- The config writer (palette command) sorts entries deterministically and preserves unknown keys.

### 4.3 Revised: `issueWorkflow`

- `teamRepoMap` — **deprecated, not removed.** Read with a startup deprecation warning. Removed in v0.21.0.
- `sessionNameTemplate` — preserved; gains template variables `{issueId}`, `{issueSlug}`, `{projectKey}`. Default becomes `{issueId}-{issueSlug}` (e.g., `JWT-12-rotate-jwt-signing-key`). Output is normalized via the existing `sanitizeTmuxSessionName`.
- New: `claudePromptTemplate` — Mustache-style template for the auto-launch Claude prompt; vars: `{issueId}`, `{issueSlug}`, `{issueDescription}`, `{issueUrl}`, `{projectName}`. Sensible default ships in code.
- New: `archive.deleteLocalBranch` — boolean (default `false`). When `true`, archive runs `git branch -d <branch>` after worktree removal.
- New: `linkExistingWorktreesByBranchName` — boolean (default `true`). Auto-detection from branch name (Section 8.4).
- `autoLaunchAgent`, `autoCreateWorktree` — preserved.

### 4.4 Revised: `wtmIntegration`

Stays a boolean. Meaning sharpens: when `true`, the new-session modal uses `wtm create` for new linked worktrees. When `false`, jmux falls back to native `git worktree add`.

### 4.5 New: `iconSet`

```jsonc
{ "iconSet": "nerd-font" }   // or "plain"
```

Default `"nerd-font"`. Setting `"plain"` swaps to a hand-curated fallback table that uses no Nerd Font codepoints — only ASCII characters and widely-supported Unicode geometric shapes / braille (these render correctly in any monospace font without an icon font installed). Selection is global; never mixed.

### 4.6 Validation

`src/config.ts` gains `parseJmuxConfig` returning `{ config, warnings, errors, unknownKeys }`. Validation is strict for **known** jmux fields (type errors, invalid enum values, out-of-range numbers, missing required sub-fields) and produces structured errors with file line ranges where possible. **Unknown keys** are not errors — they're collected into `unknownKeys` and round-tripped on write so user additions or fields from a future jmux version survive an edit by the palette writer. The palette writer round-trips through this parser before writing — files never persist with validation errors against known fields.

## 5. Sidebar redesign

### 5.1 Layout

- **Group ordering** (top → bottom):
  1. **Pinned** — cross-project, only renders if at least one issue is pinned. Issues appear in both Pinned and their project group.
  2. **Projects** — alphabetical by display name (configurable later). Empty projects (zero rows) are hidden by default.
  3. **Unlinked** — always last. Renders only if at least one unlinked session exists.

- **Group expand/collapse.** Project headers are collapsible (existing sidebar mechanism). Collapsed state persists in the UI state, not config.

- **Sticky group headers** during scroll-in-group, so the user always knows which project they are inside.

### 5.2 Row anatomy

```
[indent] [indicator] [repo-tag?] [issue-id] [title]   [right-aligned badges]
```

- **Indent**: 2 spaces under a project header.
- **Indicator**: single character, leftmost slot, color-encoded agent state (Section 5.4).
- **Repo tag**: 3 chars (`[w]`), only rendered for multi-repo projects. If two repos in a project share an initial, fall back to 2 letters (`[we]`, `[ga]`).
- **Issue ID**: tracker identifier (e.g., `JWT-12`).
- **Title**: truncated with ellipsis if needed.
- **Right-aligned badges**: mode (P/A), MR state, Done. Badges fall off first when the line truncates — issue ID and title are protected.

### 5.3 Click / hover behaviour

- Click an active session row → switch to that session.
- Click an idle (no-session) issue row → start its worktree + session immediately. Multi-repo projects without `defaultRepoIndex` prompt for repo first.
- Hover an idle row → row brightens, no other state change.
- Right-click row → contextual actions: Pin, Open in Linear, Archive, Set base branch, Override repo.

### 5.4 Indicator priority and agent state

Single character, leftmost slot. Priority top → bottom (highest takes the slot):

| State | Glyph | Codepoint | Color |
|---|---|---|---|
| Error |  | U+F0026 nf-md-alert | red |
| Attention |  | U+F0099 nf-md-bell | orange |
| Waiting |  | U+F0150 nf-md-clock_outline | cyan |
| Generating | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | braille (animated) | yellow |
| Idle (agent running) | `●` | U+25CF | green |
| Idle (no agent, e.g. shell) | `●` | U+25CF | dim grey |
| Detached | `○` | U+25CB | grey or agent color |
| No session | (blank) | — | — |

Agent state and connection state are orthogonal. Color carries agent state; shape carries connection (● / ○ / blank). The detached `○` ring picks up agent color when the agent is busy in a detached session.

### 5.5 Right-aligned badges

- **MR badges:** open `` (U+F0640), merged `` (U+F0641, green), closed unmerged `` (U+F05AC, red), pipeline running `` (U+F00FB, yellow), pipeline failed `` (U+F0026, red).
- **Done badge:** `` (U+F012C, green) when issue Done in tracker; renders alongside MR badges if both apply.
- **Cancelled badge:** `` (U+F0156, red) when issue Cancelled.
- **Mode badges:** Plan `` (U+F0900), Accept-edits `` (U+F0E03).
- **Pinned marker** in Pinned group header: `` (U+F0403).
- **Group chevrons:** expanded `` (U+F0140), collapsed `` (U+F0142).

### 5.6 Animation

A single global phase counter ticks every ~150ms (~7 fps). All animated rows redraw in the same frame, sharing one diff. Cost is bounded by row count, not by independent timers. Spinner suppressed in the sidebar if more than 12 rows would animate at once (replaced with a static `◐` in agent color).

### 5.7 Icon module

A single module `src/icons.ts` exposes icons keyed by semantic name (`icons.attention`, `icons.mrOpen`, etc.). Sidebar, toolbar, and modals reference these — never hardcode glyphs. The ASCII fallback set lives in the same module under a different export. This makes a future custom-icon-pack feature trivial.

### 5.8 Plain fallback (`iconSet: "plain"`)

All glyphs are ASCII characters or widely-supported Unicode shapes (`●`, `○`, braille). No Nerd Font codepoints leak through.

| Semantic | Nerd Font | Plain |
|---|---|---|
| error |  | `X` |
| attention |  | `!` |
| waiting |  | `?` |
| generating | braille | braille (preserved — universal in monospace fonts) |
| idle (agent) | `●` | `●` (preserved — geometric shape) |
| detached | `○` | `○` (preserved — geometric shape) |
| done |  | `+` |
| pinned |  | `*` |
| chevron-down |  | `v` |
| chevron-right |  | `>` |
| MR open |  | `M` |
| MR merged |  | `M+` |
| MR closed |  | `M-` |
| MR pipeline |  | `M~` |
| Plan mode |  | `P` |
| Accept-edits |  | `A` |
| Cancelled |  | `C` |

The `v` for chevron-down and `+` for done don't collide in practice — they appear in different slots (group header vs. right-aligned badge).

## 6. New-session modal

Single keybind: `Ctrl-a n`. Multi-step state machine implemented as one `IssuePickerModal` (matches the existing `Modal` interface in `src/modal.ts`). The legacy `NewSessionModal` is rewritten — its directory-picker logic is preserved as the unlinked branch.

### 6.1 Step 1 — Issue picker (default view)

- Search input has focus on open.
- Listed issues match the sidebar scope (assigned to me + has session, in configured projects).
- Up/down navigates rows. Enter selects.
- **Search behaviour** — multi-tier:
  1. Exact ID prefix match (e.g., `JWT-15`).
  2. Title prefix matches.
  3. Title fuzzy matches.
  4. **Deferred Linear lookup** for typed IDs not in local cache. Debounced 200ms; resolves into a "From Linear:" sub-section with a small download icon. Lookups cancellable on subsequent keystrokes.
- **Active-session shortcut** — selecting an issue with an attached session switches to it (no new worktree, no preview step). The "[attached]" suffix tells the user this in advance.
- **Strict 1:1 enforcement at the modal layer** — selecting an issue that has any session (attached or detached) jumps to it. There is no path through the modal that creates a duplicate worktree for the same issue.
- **Bottom escape hatch** — "Open unlinked session in directory…" reachable via `Ctrl-O` or click. Routes to the legacy directory-first flow.

**Per-row keybindings (modal context):**
- `Enter` — select / switch.
- `Ctrl-Enter` — create *without* auto-launching Claude (overrides config default).
- `Ctrl-P` — pin/unpin.
- `Ctrl-L` — open in Linear (browser).

Archive is a lifecycle action and lives outside this modal (see Section 7.2).

### 6.2 Step 2 — Repo picker (conditional)

Renders only when the issue's project has multiple repos AND no `defaultRepoIndex`. Otherwise skipped silently.

### 6.3 Step 3 — Preview & confirm

All fields pre-filled. Tab cycles through editable fields:

- **Branch name** — default from `sessionNameTemplate` ({issueId}-{issueSlug}), normalized via `sanitizeTmuxSessionName`. If the tracker reports a `branchName`, that takes precedence.
- **Base branch** — default from project's `defaultBaseBranch`, falling back to `issueWorkflow.defaultBaseBranch`.
- **Worktree path** — derived; not directly editable.
- **Session name** — default same as branch name.
- **Auto-launch Claude with issue context** — checkbox; default from `issueWorkflow.autoLaunchAgent`.

### 6.4 Step 4 — Creating

Inline progress. Operations: `wtm create` (or `git worktree add` fallback) → tmux session start → Claude launch (if checked). Auto-switches to the new session on success. On failure, modal stays open with error and partial state preserved (e.g., retry-session if the worktree exists but session start failed).

### 6.5 Fallthrough — Unlinked session

`Ctrl-O` or click. Routes to the existing directory-first flow:
1. Pick directory.
2. (If bare repo) pick worktree or create new.
3. Enter session name.

Same code path as today's `NewSessionModal` after Step 1; we don't rewrite the directory/worktree pickers, we demote them from primary to escape-hatch.

### 6.6 Esc behaviour

- Step 1 → close modal.
- Step 2/3 → back one step.
- Step 4 → cancel in-progress creation (best-effort; partial state preserved as in 6.4).

## 7. Lifecycle UI

### 7.1 Per-row badges

| Tracker (issue status) | MR state | Visual |
|---|---|---|
| Open / In Progress / In Review | none | (no badge) |
| Open / In Progress / In Review | open |  |
| Open / In Progress / In Review | pipeline running |  |
| Open / In Progress / In Review | pipeline failed |  |
| Open / In Progress / In Review | merged |  |
| Done | none |  |
| Done | merged |  +  |
| Cancelled | any |  |

The "ready to archive" state is **Done + Merged**. Both badges render together; that combination is itself the signal. Optionally a 1-char-wide green left edge marker on the row for scannability — to be implemented as a config option, default off, revisited after launch based on use.

### 7.2 Archive action

User-triggered. Three entry points routed through the same handler:

- Sidebar keybind on selected row: `Ctrl-a x`.
- Right-click row → "Archive".
- Command palette: "Archive issue …".

Confirmation: single inline prompt — `Archive JWT-15? Will kill session, remove worktree. [y/N]`. No nested dialogs.

Operations run in order, each gated on the previous succeeding:

1. **Pre-check.** `git status --porcelain` in the worktree. If output is non-empty → abort with `worktree has uncommitted changes; commit, stash, or discard first`. Don't auto-stash.
2. **Kill the tmux session.** `tmux kill-session -t <name>` via the control client.
3. **Remove the worktree.** `wtm remove <name>` if `wtmIntegration` is true, else `git worktree remove <path>`.
4. **Local branch deletion.** Off by default. When `archive.deleteLocalBranch` is true: `git branch -d <branch>` (lower-case `-d`; failure on unmerged is desirable).
5. **Drop the row from the in-memory issue cache** so the sidebar updates immediately.

If any step fails, the action stops and surfaces the error inline. Partial state on disk is left as-is (no rollback).

#### 7.2.5 Re-add prevention on next refresh

After archive, the next Linear poll must not re-add the row. The mechanism is the `issueListScope` filter:

- The session is gone (kill in step 2), so `withSession` no longer matches the issue.
- If the issue is Done/Cancelled (the typical archive precondition), `assignedToMe` and `all` also exclude it because closed issues are filtered out of every scope by default.
- If the user archived an *open* issue still assigned to them (uncommon but possible), the issue would naturally re-appear under `assignedToMe` / `assignedToMeOrWithSession` on the next refresh — without a session, as an idle issue row. This is the correct behaviour: the issue is still active work the user is on the hook for; only its worktree was removed.

There is no separate "manually archived" hidden set. The scope filter does the work.

### 7.3 Reopen / un-archive

There is no "archived issues" view by design. Re-creating a worktree for the same issue (issue picker → Enter) is the natural undo. Local branch survives by default (per `archive.deleteLocalBranch` default), so `git checkout` restores work-in-progress if archive was in error.

### 7.4 External worktree removal

If the user runs `wtm remove` or `git worktree remove` outside jmux:
- Next sidebar refresh detects the worktree is gone.
- The row stays — but as an idle issue row (no session, click-to-recreate).
- The tmux session, if it survived the worktree, becomes Unlinked.

This is the only place where the strict-1:1 invariant gracefully degrades — issue and session are no longer joined, and that's fine.

### 7.5 Reopened issues

If status changes from Done back to In Progress (on Linear refresh), the Done badge clears on next render. No prompt or notification. The MR-merged badge stays if the MR was actually merged (separate fact).

## 8. CLI surface (`jmux ctl` extensions)

All output remains JSON to stdout; errors to stderr with non-zero exit. No human-readable mode.

### 8.1 New: `jmux ctl project`

```
jmux ctl project list
jmux ctl project add <linear-project-id> --repo <path> [--repo <path>...] [--display-name <name>] [--default-base-branch <branch>]
jmux ctl project remove <linear-project-id>
jmux ctl project refresh [<linear-project-id>]
```

`add` is what the palette command calls under the hood. Idempotent.

### 8.2 New: `jmux ctl issue`

```
jmux ctl issue list [--project <id>] [--scope assignedToMe|withSession|assignedToMeOrWithSession|all] [--include-closed]
jmux ctl issue get <issue-id>
jmux ctl issue start <issue-id> [--repo <path>] [--base-branch <branch>] [--no-launch-claude]
jmux ctl issue archive <issue-id> [--force] [--delete-branch]
jmux ctl issue link <session-id> <issue-id> [--repo <path>] [--worktree <path>]
jmux ctl issue unlink <session-id>
```

`issue start` is the orchestrator agents reach for. It composes onto `session create` and `wtm` calls — does not bypass them. Returns the new session info; if the issue already has a session, returns that one.

**`issue link` discovery and 1:1 enforcement.** When `--worktree` and `--repo` are omitted, the command discovers them from the session's working directory: it walks up from the session's cwd to the nearest git directory, checks whether that path is inside a configured project's `repos[]`, and uses the matching project as the link. `--repo <path>` and `--worktree <path>` override discovery for sessions whose cwd doesn't match a configured repo. The command fails if (a) no project match can be made, (b) the target issue already has a linked session in another tmux session (strict 1:1 invariant from Section 2.2), or (c) the session is already linked to a different issue (use `unlink` first).

### 8.3 New: `jmux ctl agent`

```
jmux ctl agent state [<session-id>]
jmux ctl agent watch [<session-id>]
```

Reads from the same source the sidebar uses (`@jmux-agent-state` tmux option + OTEL corroboration). `agent watch` is a long-running streaming command emitting one JSON line per state transition; SIGINT to stop.

### 8.4 New: `jmux ctl auth`

```
jmux ctl auth status
```

Verification only. No `auth login` — auth is environment-variable-only.

### 8.5 Extended: `jmux ctl run-claude`

Adds `--issue <issue-id>`. Equivalent to `jmux ctl issue start <issue-id>` with auto-launch-claude on. Existing flags preserved.

### 8.6 Issue ↔ session link storage

The link is stored as tmux session user options:

```
@jmux-linear-issue       JWT-15
@jmux-linear-project     <project-uuid>
@jmux-repo-path          /Users/jarred/Code/work/webapp
```

Reasons:
1. Survives jmux restarts — options live in the tmux server.
2. Discoverable from the shell: `tmux show-options -t <session> -A | grep @jmux-`.
3. No additional sync target.

Set when `issue start` (or the modal) creates the session; cleared by `issue unlink`. There is no separate session-link DB.

### 8.7 Auto-detection from branch name

On startup, for any unlinked session whose worktree's current branch matches `/^([A-Z]+-\d+)/`:

1. Look up the matched issue ID in the cache.
2. If found AND the issue's project is in `linearProjects`, set `@jmux-linear-issue` and `@jmux-linear-project` on the session.
3. Otherwise, leave unlinked.

Runs once per session per launch. Behind config flag `linkExistingWorktreesByBranchName` (default `true`). User can override a bad auto-link with `jmux ctl issue unlink`.

## 9. Migration & rollout

Single coordinated release as v0.20.0. No feature flag, no parallel old/new code path.

### 9.1 First-launch behaviour matrix

| `issueTracker` | `linearProjects` | UX |
|---|---|---|
| Absent | (n/a) | **Today's UX, unchanged.** Wtm bare-repo grouping, no project headings, no "Unlinked" label. Agent-state indicators apply. |
| Present | Empty | Sidebar renders existing sessions in a single "Unlinked" group. Dismissible startup banner: *"Add your first Linear project (palette: Add project)"*. |
| Present | One+ entry | Full new UX. Existing sessions auto-link by branch name where possible; rest live in Unlinked. |

Users without Linear get an experience that is strictly a superset of today's.

### 9.2 Config field migration

| Field | Status |
|---|---|
| `linearProjects` | New, additive |
| `issueTracker` | New, additive |
| `iconSet` | New, default `"nerd-font"` |
| `archive.deleteLocalBranch` | New, default `false` |
| `linkExistingWorktreesByBranchName` | New, default `true` |
| `issueWorkflow.teamRepoMap` | **Deprecated**, removed in v0.21.0 |
| `issueWorkflow.sessionNameTemplate` | Preserved + new template vars |
| `issueWorkflow.claudePromptTemplate` | New |
| `wtmIntegration` | Preserved |
| All other existing fields | Preserved |

### 9.3 Hook re-installation

`jmux --install-agent-hooks` previously wrote one Stop hook. The new version writes four (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) plus the existing `@jmux-attention` set. Idempotent — bounded by jmux-managed marker comments with version metadata.

On startup, jmux reads `~/.claude/settings.json` and detects stale hook blocks (older marker version). Surfaces a non-blocking banner: *"Agent hooks are outdated. Run `jmux --install-agent-hooks` to update."* — never auto-modifies the user's settings file.

### 9.4 Documentation updates

- **`CLAUDE.md`** — adds a "Projects, issues, and worktrees" section explaining the new entity model and config shape.
- **`skills/jmux-control.md`** — extended with `project`, `issue`, `agent`, `auth` subcommand docs.
- **New: `skills/jmux-issue-workflow.md`** — short skill teaching agents the canonical pattern: `issue start <id>` (or `run-claude --issue <id>`) to begin work, `issue archive` to clean up.
- **`README.md`** and the published npm description — updated to mention Linear integration.

### 9.5 Release notes

Three call-outs every existing user needs:

1. **Re-run `jmux --install-agent-hooks`** to get agent state indicators in the sidebar.
2. **Set `LINEAR_API_KEY` and run `jmux ctl project add`** to enable the new model. Without it, jmux works exactly as before plus agent state.
3. **`teamRepoMap` is deprecated.** Move repo associations to `linearProjects[].repos` before v0.21.0.

## 10. Testing strategy

Existing discipline preserved: pure unit tests over logic modules, no tmux spawning, run under `bun test`.

### 10.1 New test surfaces

1. **`IssueTracker` contract suite** — shared test file any implementation must pass: `listAccessibleProjects`, `listIssuesForProjects`, `getIssue`, `getMergeRequestForIssue`, `capabilities`. `LinearTracker` runs against a mocked HTTP client.
2. **`IssueCache` tests** — refresh-on-interval, TTL gating, partial-failure recovery, eviction on `project remove`.
3. **Sidebar render plan tests** — extend `src/__tests__/sidebar.test.ts`:
   - Issue-anchored grouping with Pinned / project / Unlinked sections.
   - Repo tag emitted only for multi-repo projects.
   - Indicator priority ordering.
   - Spinner frame selection by global phase counter.
   - `iconSet: "ascii"` produces the curated fallback set with no Nerd Font codepoints leaking through.
4. **`IssuePickerModal` tests** — multi-step state machine:
   - Search filtering tiers.
   - Deferred Linear lookup debouncing and cancellation.
   - Active-session shortcut routes to switch.
   - Multi-repo step skipping when single-repo or `defaultRepoIndex` set.
   - Esc behaviour per step.
5. **CLI subcommand tests** — `project`, `issue`, `agent`, `auth` follow existing CLI test patterns. `issue start` and `issue archive` use injectable handlers so tests don't actually run wtm/git.
6. **Hook installer tests** — `--install-agent-hooks` writes the right keys to a fixture `settings.json`, idempotently. Detection of stale hook blocks works for old single-hook installations.
7. **Archive flow tests** — pre-check refuses on dirty worktree, ordering of kill→remove→branch-delete, partial-failure leaves disk state intact.
8. **Auto-link tests** — given a branch name and a configured project, the link decision is correct. Edge cases: ambiguous IDs across projects, ID matches but project not configured, branch is the default branch (no link).

### 10.2 Optional: recorded-fixture integration tests for `LinearTracker`

A small set of tests replaying a recorded Linear GraphQL conversation (HTTP fixture in `src/__tests__/fixtures/linear/*.json`). Validates that GraphQL query shapes have not drifted. Recordings refreshed manually when Linear's schema changes.

### 10.3 Out of scope for tests

- Spawning real tmux processes in tests (preserved per existing CLAUDE.md guidance).
- E2E browser-based tests of the rendered sidebar.
- Performance benchmarks for the spinner animation.

## 11. Decisions log

The redesign was driven by eight choices made during brainstorming. Recorded here for context when reading the spec later.

| # | Decision | Choice |
|---|---|---|
| Q1 | How does jmux learn that a session belongs to a Linear project? | Live Linear API in jmux core |
| Q2 | How does jmux know which repo to use for a given issue? | Explicit config: project → repos[] |
| Q3 | What anchors a sidebar row? | Issues, grouped by project, with Unlinked bucket |
| Q4 | Which issues populate the sidebar? | Assigned to me + has session |
| Q5 | Cardinality between issue and worktree/session? | Strict 1:1; multi-terminal needs handled by tmux windows |
| Q6 | What happens when issue is Done + MR merged? | Manual archive only (badge but nothing automatic) |
| Q7 | How does a Linear project get added to jmux? | Palette command writes to config |
| Q8 | New-session entry point structure? | Single modal, issue-first, fallthrough to directory |
| Direction | Implementation strategy? | Issue-tracker abstraction, Linear as first implementation |
