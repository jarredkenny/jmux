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
      { "type": "mr", "id": "org%2Frepo:482" }
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
- Loaded at startup, watched for changes (same pattern as config hot-reload)
- MR ids use the existing `encodedProject:iid` format from the GitLab adapter

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

### New Adapter Methods

Two new methods on the adapter interfaces for fuzzy search:

```typescript
// IssueTrackerAdapter
searchIssues(query: string): Promise<Issue[]>;

// CodeHostAdapter  
searchMergeRequests(query: string): Promise<MergeRequest[]>;
parseMrUrl(url: string): string | null;  // URL → "encodedProject:iid" or null
```

Used by the command palette and new-session modal for the link search UI. The Linear adapter uses `issueSearch`, the GitLab adapter uses `/merge_requests?search=`.

### Entry Points for Creating Links

**1. New Session Modal — optional step after naming**

When an issue tracker is configured, after the user enters a session name, an optional step: "Link issues?" with fuzzy search against the issue tracker. Multi-select. Skippable with Esc.

When a code host is configured, a follow-up step: "Link MRs?" with fuzzy search against open MRs. Also skippable.

Selected links write to `state.json` on session creation.

**2. Command Palette — post-creation**

Four new commands:
- **"Link issue"** — fuzzy search against issue tracker, adds to `state.json`
- **"Link MR"** — fuzzy search against open MRs on code host, adds to `state.json`
- **"Unlink issue"** — shows currently linked issues (manual source only), pick one to remove
- **"Unlink MR"** — shows currently linked MRs (manual source only), pick one to remove

Unlink only operates on `manual` source links. Auto-discovered and transitive links can't be unlinked — they disappear when the underlying condition changes (branch switches, MR merges, etc.).

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
- `src/main.ts` — initialize state file, wire link commands into palette, pass state to resolver, new-session modal link steps
- `src/new-session-modal.ts` — optional issue/MR link steps after naming

### Unchanged

`src/info-panel.ts` (tab container), `src/renderer.ts`, `src/config.ts`, `src/diff-panel.ts`, tmux communication layer, CLI.

## Testing Strategy

- **State file:** Unit tests for load/save/prune/link/unlink operations with temp files
- **Context resolver:** Unit tests for the full merge chain — manual links + auto-discovery + transitive expansion + deduplication + cap enforcement
- **Sidebar three-line rows:** Extend existing sidebar render tests for variable-height items, issue ID truncation, MR count display, worst-state glyph
- **Panel rendering:** Unit tests for multi-item MR/issues tabs — scrolling, selection cursor position, source badge rendering
- **Adapter search methods:** Unit tests with mocked HTTP responses for `searchIssues` and `searchMergeRequests`

No integration tests hitting real APIs.
