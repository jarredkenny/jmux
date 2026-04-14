# Info Panel & External Adapters

**Date:** 2026-04-12
**Status:** Draft

## Summary

Evolve jmux's diff panel into a tabbed info panel that surfaces MR status, pipeline state, and issue tracking alongside diffs. External service integrations (GitLab, Linear, GitHub) are pluggable via an adapter interface. The system degrades gracefully — tabs only appear for configured adapters.

## Problem

Developers working in jmux switch between their terminal, GitLab/GitHub for MR status, and Linear/Jira for issue tracking. The context switch breaks flow. jmux already owns the terminal viewport and knows which session maps to which repo/branch — it can surface this information inline.

## Design Decisions

### Panel Architecture

`InfoPanel` is a tab-bar container that manages tab selection and renders the tab bar. It does **not** absorb `DiffPanel`'s lifecycle.

The Diff tab is fundamentally different from MR/Issues: it owns a real PTY subprocess (`diffPty`/`diffBridge` in `main.ts`), receives keystrokes when focused, and has its own resize lifecycle. MR and Issues tabs are rendered-content tabs — static `CellGrid`s with light keybindings.

`InfoPanel` delegates accordingly:
- **Tab selection and tab-bar rendering** — owned by `InfoPanel`
- **Diff tab PTY lifecycle** (spawn, exit, resize, keystroke forwarding) — stays in `main.ts` where it already lives
- **MR/Issues tab content** — `InfoPanel` calls into `info-panel-mr.ts` / `info-panel-issues.ts` to get their grids

When `InfoPanel` is asked for its active grid: if the active tab is Diff, it returns the existing `DiffPanel` grid. If MR or Issues, it returns the rendered content grid. `main.ts` continues to manage the diff subprocess exactly as it does today.

Tabs:
- **Diff** — existing hunk diff viewer, PTY-backed, lifecycle in `main.ts`
- **MR** — rendered content from code host adapter
- **Issues** — rendered content from issue tracker adapter

Only tabs with configured adapters appear. No adapters configured = just the Diff tab (today's behavior). The panel retains the same docking behavior: split right or zoomed full-width, toggled with `Ctrl-a g`, focus with `Ctrl-a Tab`.

### Adapter Interface

Two adapter categories:

```typescript
interface CodeHostAdapter {
  type: string;

  authenticate(): Promise<void>;

  getMergeRequest(remote: string, branch: string): Promise<MergeRequest | null>;

  pollMergeRequest(mrId: string): Promise<MergeRequest>;
  // Returns Map<sessionName, MergeRequest> — keyed by BranchContext.sessionName
  pollAllMergeRequests(remotes: BranchContext[]): Promise<Map<string, MergeRequest>>;

  openInBrowser(mrId: string): void;
  markReady(mrId: string): Promise<void>;
  approve(mrId: string): Promise<void>;
}

interface IssueTrackerAdapter {
  type: string;

  authenticate(): Promise<void>;

  getLinkedIssue(mrUrl: string): Promise<Issue | null>;
  getIssueByBranch(branch: string): Promise<Issue | null>;

  pollIssue(issueId: string): Promise<Issue>;
  pollAllIssues(issueIds: string[]): Promise<Map<string, Issue>>;

  getAvailableStatuses(issueId: string): Promise<string[]>;
  openInBrowser(issueId: string): void;
  updateStatus(issueId: string, status: string): Promise<void>;
}
```

Adapters are TypeScript modules in `src/adapters/` with an async interface designed as if they were external processes. The contract is clean enough that any adapter could be extracted to a separate process later without rewriting the panel or polling coordinator.

A single adapter can implement both interfaces (e.g., GitHub for issues and PRs). The registry handles deduplication when the same type is configured for both categories.

### Data Types

```typescript
interface MergeRequest {
  id: string;
  title: string;
  status: "draft" | "open" | "merged" | "closed";
  sourceBranch: string;
  targetBranch: string;
  pipeline: PipelineStatus | null;
  approvals: { required: number; current: number };
  webUrl: string;
}

interface PipelineStatus {
  state: "running" | "passed" | "failed" | "pending" | "canceled";
  webUrl: string;
}

interface Issue {
  id: string;
  identifier: string;  // e.g., "ENG-1234"
  title: string;
  status: string;
  assignee: string | null;
  linkedMrUrls: string[];
  webUrl: string;
}

interface BranchContext {
  sessionName: string;
  remote: string;
  branch: string;
}

interface SessionContext {
  sessionName: string;
  dir: string;
  branch: string | null;
  remote: string | null;
  mr: MergeRequest | null;
  issue: Issue | null;
  resolvedAt: number;
}
```

### Context Resolution

When a session becomes active (or the panel opens for the first time), jmux resolves what to display:

1. Read the session's working directory (already known from tmux)
2. Get git state: current branch + select remote URL
   - List all remotes via `git remote -v`
   - If a remote's URL hostname matches the configured code host adapter (e.g., `gitlab.com` for GitLab, `github.com` for GitHub), use that remote
   - Fall back to `origin` if no hostname match
   - This handles fork workflows where `origin` is the fork and `upstream` is the canonical repo — the adapter match picks the right one
3. Code host lookup: `remote + branch → MergeRequest | null`
4. Issue tracker lookup, two paths tried in order:
   - MR web URL → linked issue via `getLinkedIssue()` (most reliable — Linear links issues to MRs)
   - Branch name → issue via `getIssueByBranch()` (fallback — branch names often contain issue IDs like `eng-1234-fix-auth`)
5. Cache result as `SessionContext`

Short-circuits: no git repo → no branch/remote/MR/issue. No code host adapter → skip step 3. No issue tracker adapter → skip step 4.

**Branch drift detection:** The polling coordinator checks the active session's current branch on each poll interval. If it changed (e.g., `git checkout` to a different branch), the context is re-resolved.

### Polling Coordinator

`PollCoordinator` is the single owner of all external API calls. Nothing else calls adapter methods directly.

**Tiered intervals:**
- Active session: 20s — poll MR, pipeline, issue, check branch drift
- Background sessions: 3min — batched `pollAll` calls across all non-active sessions

**Rate limit backoff (three tiers):**
- Normal: active 20s, background 3min
- Rate limited (HTTP 429): active 60s, background paused
- Hard limited: all polling paused until reset window passes

Background sessions prioritize backoff first — the active session stays fresh as long as possible.

**Single writer, multiple readers:** The coordinator writes to a `Map<string, SessionContext>` cache. The `InfoPanel` and `Sidebar` read from it. The coordinator emits an `onUpdate` callback (same pattern as `OtelReceiver`) that triggers `scheduleRender()`.

**Batched background polls:** `pollAllMergeRequests` and `pollAllIssues` receive all non-active sessions at once. Adapter implementations decide how to batch — GitLab can filter MRs by author in one call, Linear's GraphQL can fetch multiple issues in one query. jmux doesn't prescribe the batching strategy.

### Authentication

Adapters discover their own credentials. jmux config never stores tokens.

- **GitLab:** `$GITLAB_TOKEN` or `$GITLAB_PRIVATE_TOKEN`, falls back to `glab auth status`
- **Linear:** `$LINEAR_API_KEY`
- **GitHub:** `$GITHUB_TOKEN` or `$GH_TOKEN`, falls back to `gh auth token`

**Startup failure:** If `authenticate()` fails (no credentials found), the adapter is disabled and its tab is hidden. A one-time warning is logged.

**Mid-session auth failure:** If a previously-authenticated adapter starts returning 401/403, the `PollCoordinator` treats it similarly to rate limiting but with different behavior:
- The adapter is marked as `authFailed`
- Polling for that adapter stops (no retry — stale tokens don't fix themselves)
- The tab stays visible but renders an error state: "Authentication expired — check $GITLAB_TOKEN" (or equivalent env var hint for the adapter)
- If the user fixes their token (e.g., exports a new env var), they can re-authenticate via a command palette action or by restarting jmux. Hot-reload of config triggers `authenticate()` again, which clears the error state if it succeeds.

### Configuration

Extension to `~/.config/jmux/config.json`:

```json
{
  "adapters": {
    "codeHost": {
      "type": "gitlab"
    },
    "issueTracker": {
      "type": "linear"
    }
  }
}
```

- Only the `type` field is required. Additional adapter-specific fields (e.g., `url` for self-hosted GitLab) go under the adapter key if needed later.
- Polling intervals are hardcoded and managed internally. Not exposed in config.
- Config is already hot-reloaded via the existing file watcher. Adding or removing an adapter takes effect without restart — the `PollCoordinator` reinitializes when adapter config changes.

### Sidebar Indicators

Pipeline state glyph per session, right-aligned before the window count:

```
│ ● api-server    ✓   3w │     ✓ green  — pipeline passed
│   main              2:40│
│                         │
│   frontend      ⟳   2w │     ⟳ yellow — pipeline running
│   feature/x         1:23│
│                         │
│ ! auth-fix      ✗   1w │     ✗ red    — pipeline failed
│   fix/token              │
│                         │
│   deploy        ◆   1w │     ◆ purple — MR merged
│   main                   │
```

Only pipeline state gets a glyph. Issue status is not shown in the sidebar — status labels vary across trackers and would be noisy. Pipeline state is universal (pass/fail/running) and is the information worth glancing at.

Derived from `SessionContext.mr.pipeline.state`. If `mr` is null or `pipeline` is null, no glyph is rendered.

**Column budget impact:** The sidebar is 26 cols by default. The name row layout (`sidebar.ts:560-583`) is: col 0 (active marker), col 1 (activity/attention indicator), cols 3+ (session name, truncated at `windowCountCol - 1 - nameStart`), right-aligned window count. Adding a pipeline glyph + space before the window count costs 2 columns, which shortens the maximum session name display by 2-3 characters. This is an acceptable trade-off — session names that are already truncating will truncate slightly earlier. The glyph column is only reserved when a code host adapter is configured; without one, the full name width is preserved.

### MR Tab Content

The MR tab displays:
- MR title + status (draft/open/merged/closed)
- Source → target branch
- Pipeline status with state indicator
- Approval state (current/required)

Light actions available:
- `[o]` Open in browser
- `[r]` Mark ready (undraft)
- `[a]` Approve

### Issues Tab Content

The Issues tab displays:
- Issue identifier + title (e.g., "ENG-1234 Fix auth token refresh")
- Status
- Assignee
- Linked MR URLs

Light actions available:
- `[o]` Open in browser
- `[s]` Update status (calls `getAvailableStatuses()` on the adapter, opens a `ListModal` picker with the results)

## File Layout

```
src/
├── adapters/
│   ├── types.ts              # All adapter interfaces and data types
│   ├── registry.ts           # Factory — instantiates adapters by type string
│   ├── poll-coordinator.ts   # Polling lifecycle, tiers, rate limiting, cache
│   ├── context-resolver.ts   # git state → MR → issue resolution chain
│   ├── gitlab.ts             # GitLab CodeHostAdapter
│   ├── linear.ts             # Linear IssueTrackerAdapter
│   └── github.ts             # GitHub (implements both interfaces)
├── info-panel.ts             # Tab container — manages tabs, renders active grid
├── info-panel-mr.ts          # MR tab rendering
├── info-panel-issues.ts      # Issues tab rendering
├── diff-panel.ts             # Unchanged — becomes Diff tab content provider
```

### Changes to Existing Files

- **`main.ts`** — Initialize `PollCoordinator` and `InfoPanel` at startup. Replace `DiffPanel` toggle with `InfoPanel` toggle. Wire `onUpdate` to `scheduleRender()`. Pass `SessionContext` map to sidebar.
- **`sidebar.ts`** — Accept optional `Map<string, SessionContext>`, render pipeline glyph per session.
- **`renderer.ts`** — Composite `InfoPanel`'s active tab grid instead of `DiffPanel` grid. Add tab bar rendering above the panel content.
- **`input-router.ts`** — Add tab-switching keybindings: `]` / `[` when panel is focused cycles tabs forward/backward. `Shift-Left` / `Shift-Right` retain their existing meaning (unfocus panel / pane navigation). Route input to active tab for light actions.
- **`config.ts`** — Extend `JmuxConfig` with `adapters` field.

### Unchanged Files

`tmux-control.ts`, `tmux-pty.ts`, `screen-bridge.ts`, `cell-grid.ts`, all modals, the CLI (`src/cli/`). The adapter system is additive — it does not touch the tmux communication layer.

## Testing Strategy

- **Adapter interface compliance:** Unit tests per adapter with mocked HTTP responses. Verify auth discovery, context resolution, polling, and error handling.
- **Poll coordinator:** Unit tests for tiered intervals, rate-limit backoff transitions, branch drift detection, session add/remove lifecycle.
- **Context resolver:** Unit tests for the resolution chain — mock git state and adapter responses, verify correct `SessionContext` output including short-circuit cases (no git repo, no adapter).
- **Info panel tabs:** Unit tests for tab visibility logic, tab switching, grid rendering. Same level as existing `sidebar.test.ts` and modal tests.
- **Sidebar glyphs:** Extend existing sidebar render plan tests to verify glyph placement and coloring based on `SessionContext` data.

No integration tests that hit real APIs. Adapter implementations are thin HTTP clients — the interesting logic is in the coordinator and resolver, which are testable with mocks.
