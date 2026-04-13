# Demo Mode Design Spec

## Overview

`jmux --demo` launches jmux in a fully isolated, ephemeral environment with mock Linear and GitLab adapters and pre-seeded data. The demo runs on its own tmux server, uses temporary config/state files, and cleans up completely on exit. Every jmux feature works — sidebar grouping, pipeline glyphs, attention flags, info panel views, command palette, issue/MR actions — all driven by canned data through the normal adapter interfaces.

## Goals

- **Showcase all capabilities** without requiring API credentials or real projects
- **Fully interactive** — real shells, real tmux sessions, all keybindings work
- **Visually representative** — enough seed data to populate grouped/sorted panel views, varied pipeline states, multiple teams and priorities
- **Zero side effects** — isolated tmux server, temp filesystem, no changes to user's real sessions or config
- **Suitable for recordings** — the demo looks like a realistic workday out of the box

## Non-goals

- Scripted animations or auto-playing walkthroughs
- Simulated terminal output in sessions (sessions are real shells)
- Persisting demo state across runs

---

## Architecture

### Isolation model

When `--demo` is passed, jmux creates a temp directory at `/tmp/jmux-demo-<pid>/` and spawns tmux on a dedicated socket named `jmux-demo-<pid>`. Config and state files are written to the temp directory. On exit, the tmux server is killed and the temp directory is removed.

`--demo` is mutually exclusive with `--socket` (demo provides its own socket).

### Mock adapters

Two new classes implement the existing adapter interfaces:

- `DemoCodeHostAdapter` implements `CodeHostAdapter`
- `DemoIssueTrackerAdapter` implements `IssueTrackerAdapter`

Both are backed by in-memory `Map` collections populated from seed data at construction. `authState` is `"ok"` from the start.

**Query methods** (`getMyMergeRequests`, `getMyIssues`, `getMrsAwaitingMyReview`, `searchIssues`, `searchMergeRequests`): filter/search the in-memory maps. Search uses case-insensitive substring matching on title and identifier.

**Polling methods** (`pollMergeRequest`, `pollIssue`, `pollAllMergeRequests`, etc.): return current state from the maps.

**Branch resolution** (`getMergeRequest(remote, branch)`, `getIssueByBranch(branch)`): look up by branch name in the seed data. This is how the normal `ContextResolver` flow discovers associated data — no special demo path needed.

**Mutation methods** (`approve`, `markReady`, `updateStatus`): modify the in-memory maps and return success. The next poll cycle picks up the change and the UI updates naturally through the existing rendering pipeline.

**Browser actions** (`openInBrowser`): silent no-ops.

**`getAvailableStatuses`**: returns a fixed list per team (`["Backlog", "Todo", "In Progress", "In Review", "Done"]`).

**`getTeams`**: returns the three demo teams.

The adapters are instantiated directly in `main.ts` when `--demo` is set — they bypass `createAdapters` / the registry. No changes to the adapter registry.

### Data flow

The normal `ContextResolver` → `PollCoordinator` → renderer pipeline runs unmodified. Each demo session has a minimal git repo with a branch and remote, so `ContextResolver` resolves real branch/remote pairs and calls the mock adapters through the standard interface. The mock adapters respond with seed data. Forward and transitive link resolution (MR → linked issue, issue → linked MR URLs) chains naturally.

A few sessions also get manual links via the demo `state.json` to exercise that code path.

---

## Session layout

Nine tmux sessions across three project groups:

| Session name | Group | Git branch | Description |
|---|---|---|---|
| `auth-refactor` | `acme-platform` | `feat/eng-1234-auth-refactor` | Auth middleware SSO rewrite |
| `api-pagination` | `acme-platform` | `feat/eng-1241-cursor-pagination` | Cursor pagination for APIs |
| `hotfix-login` | `acme-platform` | `fix/eng-1248-login-timeout` | Urgent login timeout fix |
| `data-export` | `acme-platform` | `feat/eng-1252-data-export` | CSV/JSON export feature |
| `user-settings` | `acme-dashboard` | `feat/dash-301-settings-redesign` | Settings page redesign |
| `chart-perf` | `acme-dashboard` | `perf/dash-315-chart-rendering` | Chart rendering optimization |
| `onboarding-flow` | `acme-dashboard` | `feat/dash-320-onboarding-wizard` | New user onboarding wizard |
| `terraform-modules` | `acme-infra` | `refactor/ops-42-tf-modules` | Terraform module restructure |
| `ci-pipeline` | `acme-infra` | `feat/ops-51-ci-speed` | CI parallelization |

Each session's working directory is `/tmp/jmux-demo-<pid>/sessions/<group>/<session>/`. Each directory contains a minimal git repo: `git init`, `git checkout -b <branch>`, `git remote add origin git@gitlab.com:acme/<project>.git`, `git commit --allow-empty -m "init"`.

`auth-refactor` and `onboarding-flow` have `@jmux-attention 1` set (orange `!` in sidebar).

---

## Seed data

### Teams

| ID | Name |
|---|---|
| `team-platform` | Platform |
| `team-dashboard` | Dashboard |
| `team-infra` | Infrastructure |

### Issues (16)

| Identifier | Title | Team | Status | Priority | Branch |
|---|---|---|---|---|---|
| ENG-1234 | Refactor auth middleware for SSO support | Platform | In Progress | 2 (high) | `feat/eng-1234-auth-refactor` |
| ENG-1237 | Rate limiting on public API endpoints | Platform | Todo | 2 (high) | — |
| ENG-1241 | Cursor-based pagination for list endpoints | Platform | In Review | 3 (medium) | `feat/eng-1241-cursor-pagination` |
| ENG-1245 | Deprecate v1 webhook format | Platform | Backlog | 4 (low) | — |
| ENG-1248 | Login timeout on slow connections | Platform | In Progress | 1 (urgent) | `fix/eng-1248-login-timeout` |
| ENG-1252 | CSV/JSON data export | Platform | In Progress | 3 (medium) | `feat/eng-1252-data-export` |
| ENG-1255 | Add audit log for admin actions | Platform | Todo | 3 (medium) | — |
| DASH-301 | Settings page redesign | Dashboard | In Progress | 2 (high) | `feat/dash-301-settings-redesign` |
| DASH-308 | Dark mode color tokens | Dashboard | Todo | 3 (medium) | — |
| DASH-315 | Chart rendering drops frames at 10k+ points | Dashboard | In Review | 2 (high) | `perf/dash-315-chart-rendering` |
| DASH-320 | New user onboarding wizard | Dashboard | In Progress | 3 (medium) | `feat/dash-320-onboarding-wizard` |
| DASH-325 | Accessibility audit fixes | Dashboard | Backlog | 4 (low) | — |
| DASH-330 | Dashboard loading skeleton | Dashboard | Todo | 4 (low) | — |
| OPS-42 | Restructure Terraform modules | Infra | In Progress | 3 (medium) | `refactor/ops-42-tf-modules` |
| OPS-48 | Flaky integration test quarantine | Infra | Done | 2 (high) | — |
| OPS-51 | CI pipeline parallelization | Infra | In Progress | 2 (high) | `feat/ops-51-ci-speed` |

Issues linked to sessions carry `linkedMrUrls` pointing at the corresponding MR's `webUrl` to enable transitive resolution. A few issues carry sample `comments` and `description` fields.

### Merge requests (9)

| Title | Source branch | Project | Status | Pipeline | Approvals | Reviewers |
|---|---|---|---|---|---|---|
| Refactor auth middleware | `feat/eng-1234-auth-refactor` | `acme/platform` | open | running | 0/2 | `alice` |
| Cursor pagination for list endpoints | `feat/eng-1241-cursor-pagination` | `acme/platform` | open | passed | 1/2 | `bob` |
| Fix login timeout handling | `fix/eng-1248-login-timeout` | `acme/platform` | draft | failed | 0/1 | — |
| Data export: CSV + JSON formats | `feat/eng-1252-data-export` | `acme/platform` | open | pending | 0/2 | `alice`, `carol` |
| Settings page redesign | `feat/dash-301-settings-redesign` | `acme/dashboard` | open | passed | 2/2 | `dave` |
| Chart rendering: virtualize large datasets | `perf/dash-315-chart-rendering` | `acme/dashboard` | open | running | 1/2 | `bob` |
| Onboarding wizard v1 | `feat/dash-320-onboarding-wizard` | `acme/dashboard` | draft | passed | 0/1 | — |
| Restructure TF modules | `refactor/ops-42-tf-modules` | `acme/infra` | open | canceled | 0/1 | `eve` |
| Parallelize CI stages | `feat/ops-51-ci-speed` | `acme/infra` | merged | passed | 2/2 | `alice` |

Coverage: all 5 pipeline states (running, passed, failed, pending, canceled), all MR statuses (draft, open, merged), varied approval counts.

"Awaiting my review" set: `settings-redesign` and `chart-perf` MRs appear in the review panel view.

### Manual session links (2-3)

Pre-seeded in demo `state.json` to exercise the manual link feature alongside branch-based auto-discovery:

- `auth-refactor` → manually linked to ENG-1237 (rate limiting issue, not branch-linked — shows cross-concern linking)
- `ci-pipeline` → manually linked to OPS-48 (done issue — shows linking to completed work)

---

## Startup sequence

`setupDemo()` in `src/demo/setup.ts`:

1. Create `/tmp/jmux-demo-<pid>/` and all `sessions/<group>/<name>/` subdirectories
2. Init git repos: 4 `Bun.spawnSync` calls per session (init, checkout -b, remote add, commit --allow-empty)
3. Write `config.json` to temp dir (default panel views, standard sidebar width)
4. Write `state.json` to temp dir (manual links listed above)
5. Create tmux sessions: `tmux -L <socket> new-session -d -s <name> -c <dir>` for each of the 9 sessions
6. Set `@jmux-attention 1` on `auth-refactor` and `onboarding-flow`
7. Instantiate `DemoCodeHostAdapter` and `DemoIssueTrackerAdapter` with seed data
8. Return `DemoContext` (socket name, paths, adapter instances)

## Cleanup sequence

`cleanupDemo(ctx)` in `src/demo/setup.ts`, called from the existing exit handler:

1. `Bun.spawnSync(["tmux", "-L", ctx.socketName, "kill-server"])`
2. `rmSync(ctx.tmpDir, { recursive: true })`

Both synchronous so they complete on SIGINT.

---

## Changes to existing code

### `src/main.ts`

- Parse `--demo` in the early arg handling block (alongside `--socket`, `--help`)
- If `--demo`: call `setupDemo()`, then thread `DemoContext` values into existing code paths:
  - `socketName` → `TmuxPty` constructor
  - Mock adapters → `PollCoordinator` constructor (instead of `createAdapters` result)
  - Config/state paths → `ConfigStore` and `SessionState` constructors
- Register `cleanupDemo` in the exit/signal handler

No other existing files change.

---

## New files

| File | Purpose | Approximate size |
|---|---|---|
| `src/demo/seed-data.ts` | Issue, MR, team, and session definitions | ~200 lines |
| `src/demo/mock-code-host.ts` | `DemoCodeHostAdapter` implementing `CodeHostAdapter` | ~80 lines |
| `src/demo/mock-issue-tracker.ts` | `DemoIssueTrackerAdapter` implementing `IssueTrackerAdapter` | ~80 lines |
| `src/demo/setup.ts` | `setupDemo()` / `cleanupDemo()` orchestration | ~100 lines |

---

## What doesn't change

- **Renderer, sidebar, toolbar, input router** — consume `SessionInfo` and `SessionContext` identically regardless of data source
- **PollCoordinator** — calls adapter methods on whatever adapters it receives
- **ContextResolver** — runs real git commands against the temp repos, calls mock adapters through the standard interface
- **Modals** — command palette, new session, list modal, input modal all work as-is
- **Diff panel** — works if `hunk` is installed, otherwise stays hidden
- **Session state** — reads/writes the demo `state.json` via the existing `SessionState` class
- **Config** — uses the same schema, just a different file path

The integration surface between demo mode and the rest of jmux is: two adapter instances and three file paths (socket, config, state).

---

## Testing

Unit tests for the mock adapters: verify query/mutation/search behavior against seed data. Same test patterns as the existing `gitlab.test.ts` and `linear.test.ts`. No integration tests needed — the demo exercises the real TUI code paths.
