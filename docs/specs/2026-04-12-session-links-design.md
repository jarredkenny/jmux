# Session Links & Multi-Item Context

**Date:** 2026-04-12
**Status:** Draft
**Depends on:** `docs/specs/2026-04-12-info-panel-adapters-design.md` (implemented)

## Summary

Add a per-session link graph that associates sessions with multiple issues and MRs. Links come from four sources: manual user bindings, branch auto-discovery, MR-to-issue links, and transitive issue-to-MR links. A state file persists manual links. The info panel and sidebar render multi-item contexts.

## Problem

The current adapter system resolves a single MR and a single issue per session via the branch → MR → issue chain. This breaks down when:
- No MR exists yet (pre-push, the branch name fallback is the only path to an issue)
- A session's work spans multiple issues
- An issue is accomplished across multiple MRs
- A user wants to track an MR that isn't on the current branch

Users need to explicitly link sessions to issues and MRs, and the system needs to merge those explicit links with auto-discovered ones.

## Design

### State File

`~/.config/jmux/state.json` — separate from `config.json` because this is runtime state, not preferences.

```json
{
  "sessionLinks": {
    "api-server": [
      { "type": "issue", "id": "ENG-1234" },
      { "type": "issue", "id": "ENG-1235" },
      { "type": "mr", "id": "12345:482" }
    ],
    "auth-fix": [
      { "type": "issue", "id": "ENG-1300" }
    ]
  }
}
```

- Only stores **manual** (user-created) links
- Keyed by session name (stable across jmux restarts)
- Pruned during `fetchSessions` — dead session names get removed
- Loaded at startup into memory. No file watcher — only jmux writes this file, so in-memory state is authoritative. All mutations go through `SessionState` methods which write-through to disk.
- MR ids use the numeric project ID format that `gitlab.ts` already produces: `${encodeURIComponent(projectId)}:${iid}` (e.g., `12345:482`). This matches the existing `mapMergeRequest` output at `gitlab.ts:124`.

### Data Model

`SessionContext` changes from singular to plural with provenance:

```typescript
type LinkSource = "manual" | "branch" | "mr-link" | "transitive";

interface SessionContext {
  sessionName: string;
  dir: string;
  branch: string | null;
  remote: string | null;
  mrs: Array<MergeRequest & { source: LinkSource }>;
  issues: Array<Issue & { source: LinkSource }>;
  resolvedAt: number;
}
```

Sources:
- **`manual`** — user explicitly linked via palette or new-session modal
- **`branch`** — auto-discovered from current branch (branch → MR, branch name → issue)
- **`mr-link`** — discovered through an MR's web URL (MR → linked issue via `getLinkedIssue`)
- **`transitive`** — discovered through a linked issue's attachments (issue has MR URLs that we resolve)

Deduplication by `id`. Priority order: `manual` > `branch` > `mr-link` > `transitive`. If the same entity appears from multiple sources, keep the highest-priority source tag.

### Link Resolution Chain

The resolver merges all sources into the final `SessionContext`:

```
1. Load manual links from state file
   → issue identifiers, MR identifiers

2. Auto-discover from git state (existing logic)
   → branch → MR via code host adapter (source: "branch")
   → branch name → issue via issue tracker adapter (source: "branch")

3. Resolve manual issue links
   → for each manual issue identifier, pollIssue()
   → tag source: "manual"

4. Resolve manual MR links
   → for each manual MR identifier, pollMergeRequest()
   → tag source: "manual"

5. Forward links: MR → linked issues
   → for each MR (from any source), getLinkedIssue(mr.webUrl)
   → tag source: "mr-link"

6. Transitive links: issue → MR URLs
   → for each issue (from any source), check linkedMrUrls
   → parse MR URL to extract project + iid (reverse of openInBrowser URL construction)
   → resolve via pollMergeRequest(encodedProject:iid)
   → tag source: "transitive"

7. Deduplicate by id, preferring higher-priority sources

8. Return SessionContext with mrs[] and issues[]
```

Steps 5 and 6 expand the graph one level deep. No transitive-of-transitive — bounded expansion.

**Expansion cap:** Max 10 issues and 10 MRs per session. Stop resolving transitive links once either limit is hit.

### Polling Strategy for Multi-Item Sessions

The existing `pollAllMergeRequests(remotes: BranchContext[])` is branch-oriented — it discovers MRs by source branch. Manual and transitive MRs aren't on any session's current branch, so they can't be polled through that method.

**New adapter method:**

```typescript
// CodeHostAdapter
pollMergeRequestsByIds(ids: string[]): Promise<Map<string, MergeRequest>>;
```

GitLab implementation: for each unique project in the id set, batch-fetch `/projects/{id}/merge_requests/{iid}`. Could also use `/merge_requests?iids[]=X&iids[]=Y` for same-project batching.

**Active session polling (20s):** Polls all MRs and issues for the active session. Uses `pollMergeRequestsByIds` for the full MR list (not just the branch MR). Uses `pollAllIssues` (already takes IDs) for issues.

**Background session polling (3min):** Two batch calls:
1. `pollAllMergeRequests(branchContexts)` — for branch-discovered MRs (existing, unchanged)
2. `pollMergeRequestsByIds(manualAndTransitiveIds)` — for non-branch MRs across all background sessions
3. `pollAllIssues(allIssueIds)` — for all issues (existing, unchanged)

This keeps the branch-oriented batch path for the common case and adds an ID-oriented path for manual/transitive MRs.

### Session Renames

When tmux emits `%session-renamed` on the control channel (old-name → new-name), `SessionState` migrates the links:

1. Read links for old name
2. Write links under new name
3. Delete old name entry
4. Write to disk

This is wired in `main.ts` alongside the existing `%session-renamed` handler. The poll coordinator also updates its internal maps (session dirs, contexts) on rename.

### New Adapter Methods

Two new methods on the adapter interfaces for fuzzy search:

```typescript
// IssueTrackerAdapter
searchIssues(query: string): Promise<Issue[]>;

// CodeHostAdapter  
searchMergeRequests(query: string): Promise<MergeRequest[]>;
parseMrUrl(url: string): string | null;  // URL → "projectId:iid" or null
pollMergeRequestsByIds(ids: string[]): Promise<Map<string, MergeRequest>>;
```

Used by the command palette and new-session modal for the link search UI. The Linear adapter uses `issueSearch`, the GitLab adapter uses `/merge_requests?search=`.

### Entry Points for Creating Links

**Command Palette — primary entry point**

Four new commands:
- **"Link issue"** — fuzzy search against issue tracker, adds to `state.json`
- **"Link MR"** — fuzzy search against open MRs on code host, adds to `state.json`
- **"Unlink issue"** — shows currently linked issues (manual source only), pick one to remove
- **"Unlink MR"** — shows currently linked MRs (manual source only), pick one to remove

Unlink only operates on `manual` source links. Auto-discovered and transitive links can't be unlinked — they disappear when the underlying condition changes (branch switches, MR merges, etc.).

**New Session Modal — deferred to follow-up**

Adding multi-select fuzzy search steps to the new-session modal requires a new modal capability (existing `ListModal` is single-select). This is self-contained enough to add later without rework. The command palette covers the use case for now — link issues/MRs immediately after creating a session.

### MR Tab Rendering

Shows all resolved MRs for the session:
- Each MR gets a section: title, status, branch, pipeline, approvals
- Source badge: dim `(auto)` for branch/mr-link/transitive sources, nothing for manual
- Scrollable if multiple MRs overflow panel height
- Selection cursor (`▸`) moves between MRs with up/down when multiple items
- Action keys (`o`, `r`, `a`) apply to the selected MR

### Issues Tab Rendering

Shows all resolved issues for the session:
- Each issue gets a section: identifier, title, status, assignee
- Same source badge pattern
- Scrollable with selection cursor
- Action keys (`o`, `s`) apply to the selected issue

### Three-Line Sidebar Rows

Sessions with link data render three lines instead of two:

```
│ ● api-server    ✓   3w │  ← name + pipeline glyph + window count
│   main              2:40│  ← branch/dir + cache timer
│   ENG-1234 ENG-1235  2M │  ← issue IDs + MR count
```

Line 3 details:
- Left: issue identifiers, space-separated, truncated with `+N` if overflow (e.g., `ENG-1234 +2`)
- Right: MR count (`1M`, `2M`, `3M`), same alignment as window count
- Dim styling, consistent with branch line
- Only rendered when the session has issues or MRs. Sessions with no link data stay two lines.

`itemHeight` changes from fixed 2 to 2 or 3 based on whether the session has link data. The scroll math already handles variable-height items (group headers are 1 row).

### Pipeline Glyph with Multiple MRs

The sidebar pipeline glyph shows the **worst** state across all MRs: failed > running > pending > passed > canceled. If any MR's pipeline failed, the session gets `✗`.

Priority order for worst-state selection:
1. `failed` → `✗` red
2. `running` → `⟳` yellow
3. `pending` → `○` yellow
4. `passed` → `✓` green
5. `canceled` → `—` dim

## File Changes

### New Files

- `src/session-state.ts` — state file load/save/watch, link CRUD operations
- `src/__tests__/session-state.test.ts`

### Modified Files

- `src/adapters/types.ts` — `SessionContext` changes to plural `mrs`/`issues` with `LinkSource`, add `searchIssues`/`searchMergeRequests` to adapter interfaces
- `src/adapters/context-resolver.ts` — new resolution chain that merges manual + auto + transitive links
- `src/adapters/poll-coordinator.ts` — pass state file links into resolver, handle multi-item polling
- `src/adapters/gitlab.ts` — add `searchMergeRequests` method
- `src/adapters/linear.ts` — add `searchIssues` method
- `src/info-panel-mr.ts` — render list of MRs with selection cursor and scrolling
- `src/info-panel-issues.ts` — render list of issues with selection cursor and scrolling
- `src/sidebar.ts` — three-line rows, issue IDs + MR count on line 3, worst-state glyph
- `src/input-router.ts` — up/down arrow routing when panel focused for item selection
- `src/main.ts` — initialize state file, wire link commands into palette, pass state to resolver, migrate links on `%session-renamed`

### Unchanged

`src/info-panel.ts` (tab container), `src/renderer.ts`, `src/config.ts`, `src/diff-panel.ts`, `src/new-session-modal.ts` (modal link steps deferred), tmux communication layer, CLI.

## Testing Strategy

- **State file:** Unit tests for load/save/prune/link/unlink operations with temp files
- **Context resolver:** Unit tests for the full merge chain — manual links + auto-discovery + transitive expansion + deduplication + cap enforcement
- **Sidebar three-line rows:** Extend existing sidebar render tests for variable-height items, issue ID truncation, MR count display, worst-state glyph
- **Panel rendering:** Unit tests for multi-item MR/issues tabs — scrolling, selection cursor position, source badge rendering
- **Adapter search methods:** Unit tests with mocked HTTP responses for `searchIssues` and `searchMergeRequests`

No integration tests hitting real APIs.
