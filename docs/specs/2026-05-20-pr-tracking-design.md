# GitHub PR support + open-MR hotkey

**Status:** Design draft (v2 — reframed after code review)
**Date:** 2026-05-20 (revised 2026-05-21)

## Summary

Make jmux's existing per-session MR display work for GitHub repositories, and
add a hotkey to open the focused session's MR in a browser. This is the
smallest change that delivers the user's actual goal — "I want to see and
quickly open the MR jmux opened for a session, on either forge."

## Motivation and reframe

A first design draft proposed a parallel PR-tracking subsystem: a PostToolUse
hook that scraped `gh pr create` / `glab mr create` output, wrote URLs to new
`@jmux-last-pr*` tmux options, and added a separate sidebar badge with its
own CI poller. Code review found this duplicated infrastructure that already
exists in jmux:

- `src/adapters/types.ts` already defines `MergeRequest` with
  `pipeline: PipelineStatus | null` (states:
  `running | passed | failed | pending | canceled`) and a
  `CodeHostAdapter` interface for forge integrations.
- `src/adapters/poll-coordinator.ts` already polls MRs per session on an
  active (20 s) / background (180 s) cadence and feeds the result into
  `SessionContext.mrs`.
- `src/sidebar.ts` already renders MR ID + pipeline glyph on row 2 of each
  session entry, driven by `view.mrId` and `view.pipelineState` from
  `src/session-view.ts`.
- The adapter registry in `src/adapters/registry.ts` has an explicit
  `codeHost` slot. Today the switch only wires `gitlab`. The "github"
  hostname is already mapped in `src/adapters/context-resolver.ts:17`.

Detection is **branch-based**, not URL-based: the resolver reads the
session's working dir, gets `git remote -v` and the current branch, then
calls `codeHost.getMergeRequest(remote, branch)`. When an agent runs
`gh pr create` (or `glab mr create`) on a branch, the next poll picks up
the new MR automatically. No hook needed.

So the actual gaps relative to the user's goal are:

1. **No GitHub adapter.** GitLab works end-to-end, GitHub doesn't work at
   all.
2. **No session-focused open hotkey.** `openInBrowser` is invoked at
   `src/main.ts:1812` inside a panel-view handler for the global MR list,
   but there is no global "open the focused session's MR" binding.
3. **Pipeline glyph is hard-coded to GitLab vocabulary.** MR ID is rendered
   as `!123` (GitLab IID convention) regardless of host (see
   `session-view.ts:90`).

This spec addresses those three gaps. Nothing else.

## Non-goals

- **No hook integration in v1.** Branch-based polling catches new MRs
  within 20 s. If that feels slow in practice we can revisit. Deferring
  also moots the prior round's reviewer concerns about Codex hook contract
  fidelity and `from-hook` error handling.
- **No new tmux user options.** No `@jmux-last-pr*` fields. State lives in
  the existing PollCoordinator's in-memory `SessionContext`.
- **No PR-history tracking.** The existing system already shows "the
  current MR for this branch"; that is the right primitive.
- **No GitHub Enterprise auto-discovery.** v1 supports `github.com` and
  any host configured via `codeHost.type = "github"` with a
  `url` (and optional `webUrl`) config field. (Matches GitLab adapter
  pattern.)
- **No write operations beyond what GitLabAdapter offers.** `approve` and
  `markReady` map to GitHub equivalents, but we don't add new verbs.

## Architecture

No new runtime infrastructure (no new poller, tracker, hook target, or
tmux options). Three existing files change; one new adapter file is
added.

| File | Change |
|------|--------|
| `src/adapters/github.ts` *(new)* | `GitHubAdapter implements CodeHostAdapter`. Mirrors `GitLabAdapter` shape (~228 lines). |
| `src/adapters/registry.ts` | Add `case "github": result.codeHost = new GitHubAdapter(...)`. |
| `src/main.ts` | Register a soft-prefix intercept for `Ctrl-a o` → open the focused session's MR via `pollCoordinator.getContext(name).mrs` selection. |
| `src/session-view.ts` | Make the MR ID prefix (`!` vs `#`) depend on host type instead of being hard-coded. |

The CodeHostAdapter interface (see `src/adapters/types.ts:69`) is the
contract. GitHubAdapter must satisfy it; nothing else needs to know which
forge is in use.

## GitHub adapter

### Authentication

Follow the GitLab pattern (`src/adapters/gitlab.ts:35-49`):

1. Read `$GITHUB_TOKEN` from env.
2. If not set, run `gh auth token` (single short-lived spawn) and parse
   its stdout — `gh auth token` prints the token to stdout when
   authenticated, exits non-zero when not.
3. If neither yields a token, set `authState = "failed"`. The
   `authHint` string is `"$GITHUB_TOKEN or gh auth login"`.

The adapter stores the token in memory only. It does **not** modify
`gh`'s credential store.

### Configuration

```ts
new GitHubAdapter({ url?: string; webUrl?: string })
// url    defaults to "https://api.github.com"
// webUrl defaults derived from url (see below)
```

A user with a self-hosted GitHub Enterprise instance sets
`codeHost = { type: "github", url: "https://github.acme.corp/api/v3" }`
in their jmux config. Same shape as GitLab.

**Web URL derivation** (`deriveWebOrigin(apiUrl): string`, pure helper):

| API URL pattern | Web origin |
|-----------------|-----------|
| `https://api.github.com` | `https://github.com` |
| `https://<host>/api/v3` (Enterprise Server) | `https://<host>` |
| anything else | fall back to `apiUrl` origin; user can override via `webUrl` |

`webUrl` config field is an explicit override for any exotic setup. The
helper is pure and unit-tested — the only place that reconstructs web
URLs from the API URL.

### HTTP layer

Reuse the same `fetch` wrapper pattern as `GitLabAdapter` (private method
that sets `Authorization: Bearer <token>` and a `User-Agent: jmux/<version>`
header — GitHub rejects requests without UA). Same `handleErrorStatus`
rate-limit handling.

### Method-by-method mapping

| Interface method | GitHub implementation |
|------------------|----------------------|
| `getMergeRequest(remote, branch)` | `extractOwnerRepo(remote)` → `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open&per_page=1`. Map first result. |
| `pollMergeRequest(mrId)` | `mrId` format `"<owner>/<repo>#<number>"`. `GET /repos/{owner}/{repo}/pulls/{number}`. |
| `pollAllMergeRequests(remotes)` | Group `remotes` by `<owner>/<repo>`. For each: `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100`. Match by `head.ref === bc.branch` (mirrors GitLabAdapter — cross-fork PR matching is not supported by either adapter today). |
| `openInBrowser(mrId)` | `Bun.spawn(["open", `${webOrigin}/${owner}/${repo}/pull/${number}`])`. `webOrigin` from `deriveWebOrigin` or explicit `webUrl` config. |
| `markReady(mrId)` | `PATCH /repos/{owner}/{repo}/pulls/{number}` with `{ draft: false }`. |
| `approve(mrId)` | `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with `{ event: "APPROVE" }`. |
| `searchMergeRequests(query)` | `/search/issues?q={query}+type:pr+state:open`, then hydrate (see "Search hydration"). |
| `parseMrUrl(url)` | Regex against `https://(api\.)?github(\.com\|enterprise host)/[^/]+/[^/]+/pull/\d+`. Return `"<owner>/<repo>#<number>"` or null. |
| `pollMergeRequestsByIds(ids)` | One `GET` per id, executed sequentially with the existing rate-limit guard (matches GitLab adapter behavior for parity). |
| `getMyMergeRequests()` | `/search/issues?q=author:@me+type:pr+state:open`, then hydrate. |
| `getMrsAwaitingMyReview()` | `/search/issues?q=user-review-requested:@me+type:pr+state:open`, then hydrate. (Per GitHub docs, `user-review-requested` is the qualifier for *direct* review requests; `review-requested` matches team-owned requests too.) |

### Search hydration

`/search/issues` returns issue-shaped objects, not full PR objects. They
lack `head.ref`, `base.ref`, `mergeable`, `requested_reviewers`, and
review state — fields jmux's `MergeRequest` model requires
(`src/adapters/types.ts:6`, consumed by `src/panel-view-renderer.ts:498`).

The three search-backed methods (`searchMergeRequests`,
`getMyMergeRequests`, `getMrsAwaitingMyReview`) hydrate every result:

1. Run the `/search/issues` query, capped at 30 results per page
   (`per_page=30`). The 30-cap is a deliberate budget brake — the
   existing panel views show a finite list and pagination is out of
   scope for v1.
2. Each result includes `pull_request.url` (a full
   `/repos/{owner}/{repo}/pulls/{n}` URL). Fan out with `Promise.all` to
   `GET` each, mapped via the shared `mapMergeRequest()`.
3. **Hydrated MRs do not populate `pipeline`.** They keep
   `pipeline: null`. Rationale and budget detail in "Rate budget" below.

`pollMergeRequestsByIds` already returns full PR objects with pipeline
hydration, so callers that need pipeline state for global-list items can
re-poll a specific id after selection.

### Pipeline state mapping

GitHub exposes CI state across two separate surfaces — the Checks API
(GitHub Actions and modern third-party integrations) and the legacy
Statuses API (older CI/CD tools like CircleCI's pre-Checks integration,
some bots). **v1 is scoped to the Checks API only.** Modern projects use
Actions/Checks; the Statuses fallback is a documented gap (see
"Out-of-scope follow-ups").

`GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs`

Combine results into a single `PipelineStatus`:

| Check states present | → `PipelineStatus.state` |
|----------------------|--------------------------|
| any `conclusion ∈ {failure, timed_out, action_required}` | `failed` |
| any `conclusion = cancelled` and no failures | `canceled` |
| any `status ∈ {queued, in_progress, waiting, pending}` | `running` |
| all `conclusion ∈ {success, neutral, skipped}` | `passed` |
| empty list | `null` (no pipeline, no glyph) |

`PipelineStatus.webUrl` is `${pr.html_url}/checks`.

Caveat: a project that uses *only* legacy commit statuses (no Actions, no
Checks-API-emitting CI) will display no pipeline glyph in v1. The
Statuses API hit (`GET /commits/{sha}/status`) is a one-line addition;
deferred because the rate-budget implication needs deliberate sign-off,
not because it's hard.

### Rate budget

GitHub's authenticated rate limit is 5000 requests/hour (15000/hour for
GitHub Apps). The cadences below are the ones PollCoordinator already
runs (`src/adapters/poll-coordinator.ts:15-18`).

| PollCoordinator path | Adapter method | Calls per cycle |
|---------------------|----------------|-----------------|
| Active session poll (20 s) — refreshes the focused session's *known* MRs by id (`poll-coordinator.ts:278`) | `pollMergeRequestsByIds(ids)` | 2 calls **per known MR** (1 PR fetch + 1 check-runs). Typically 1–3 MRs per session. |
| Background batch (180 s) — discovers MRs for non-focused sessions from branch context (`poll-coordinator.ts:350`) | `pollAllMergeRequests(remotes)` | 1 list call per repo + 1 check-runs call **per matched MR**. Match filter applied before hydration. |
| Single MR poll | `pollMergeRequest(id)` | 2 calls (1 PR + 1 check-runs). |
| Global lists (`getMyMergeRequests`, etc.) | search-backed | 1 search + ≤30 PR-hydration calls. No pipeline (see "Search hydration"). |

The critical constraint: **`pollAllMergeRequests` MUST NOT hydrate
pipeline state for unmatched PRs.** Order of operations is:

1. `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100` — one call.
2. In-memory: filter to PRs whose `head.ref` matches a
   `BranchContext.branch` in the input.
3. For the (typically small) matched subset, fan out check-runs calls.

Worst-case real number: a user with 10 sessions across 5 repos, one is
focused, nine in background.

- Active path: 1 focused session × 1–3 MRs × 2 calls / 20 s ≈ 6–18
  calls/min for the focused session.
- Background path: 5 repos × (1 list + ~9 check-runs across matched
  sessions) / 180 s ≈ 17 calls/min.
- Total ≈ 25–35 calls/min = 1500–2100 calls/hour. Well inside the
  5000/hour budget.

For a global list ("review queue") refresh: 1 + 30 calls per minute if
the user keeps the panel open. Still inside budget. The 30-cap is the
controlling lever — pagination would change this and is out of scope.

### MR ID format

`<owner>/<repo>#<number>` — three pieces of data needed to round-trip
to/from the API. Mirrors GitLab's `<encoded_project>:<iid>` shape.

## Display: per-host MR ID prefix

`src/session-view.ts:90` currently builds:

```ts
const mrId = selectedMr ? `!${extractMrIid(selectedMr.id)}` : null;
```

Change to derive the prefix from the host type:

```ts
const mrId = selectedMr ? formatMrId(selectedMr) : null;

function formatMrId(mr: MergeRequest): string {
  // mr.id encodes the host: "owner/repo#N" → GitHub; "<encoded>:<iid>" → GitLab
  if (mr.id.includes("#")) return `#${mr.id.split("#")[1]}`;
  return `!${extractMrIid(mr.id)}`;
}
```

This keeps the rendering pure (no adapter dependency in the view layer)
and uses the id shape itself as the discriminant.

`PIPELINE_GLYPH_MAP` in `sidebar.ts` already covers all five state values
the GitLab adapter emits, and the GitHub mapping above only emits those
same values. No sidebar change needed beyond the prefix tweak above.

## Hotkey: `Ctrl-a o`

Add to `src/input-router.ts` alongside the existing `Ctrl-a p|n|i` soft
prefix intercepts:

- `Ctrl-a o` → call `onOpenSessionMr()`.
- `main.ts` provides the callback: resolve the focused session's name,
  call `pollCoordinator.getContext(name)`, run the same MR selection
  logic as `session-view.ts:78-88` (latest by `createdAt`, fallback to
  last), and call `adapters.codeHost.openInBrowser(selectedMr.id)`.
- If no MR is tracked for the session, call `tmux display-message` with
  `"No MR tracked for this session"`. This is the lowest-friction toast
  surface jmux already has access to.

Update the help-screen keybind list in `main.ts:3653-3662` to include
`Ctrl-a o`.

### Conflict check

`o` is currently used as a key inside the global panel-view handler at
`main.ts:1810-1817` for "open selected MR/issue in panel". That handler
runs only when a panel view is focused, so a `Ctrl-a o` soft prefix
binding does not collide — the soft prefix only fires after `Ctrl-a`.
Verified against `input-router.ts:144-187`.

## Testing

Unit tests in `src/__tests__/adapters/github.test.ts` mirror the existing
`gitlab.test.ts` patterns:

| Surface | Test cases |
|---------|------------|
| `extractOwnerRepo` | https URLs, ssh URLs, `.git` suffix stripping, malformed → null. |
| `parseMrUrl` | github.com PR URL, enterprise host PR URL, non-PR URL → null, issue URL → null. |
| `deriveWebOrigin` | `api.github.com` → `github.com`; `https://gh.acme.corp/api/v3` → `https://gh.acme.corp`; explicit `webUrl` config overrides derivation; non-matching → falls back to apiUrl origin. |
| `mapMergeRequest` | Full PR JSON → MergeRequest including: status mapping (`draft`/`open`/`merged`/`closed`), approvals from `requested_reviewers` + review count, pipeline derivation from check-runs (one happy case per state), `webUrl` preserved. |
| `derivePipelineState` | Pure helper covering each row of the mapping table (failure-wins, cancelled-without-failure, in-progress, all-success-with-neutral-and-skipped, empty). |
| `auth fallback` | `$GITHUB_TOKEN` present → uses env; absent + `gh auth token` succeeds → uses gh token; both absent → `authState = "failed"`. |
| Search hydration | Search returns issue-shaped JSON → adapter follows each `pull_request.url`, returns `MergeRequest[]` with `pipeline === null` and `sourceBranch`/`targetBranch`/etc. populated from the hydrated PR objects. Includes a fixture asserting the qualifier `user-review-requested:@me` is in the URL for `getMrsAwaitingMyReview`. |
| `pollAllMergeRequests` rate budget | Given 100-PR list response with 2 branch matches, the adapter issues exactly 1 list + 2 check-runs calls — not 100. Regression guard for the rate-budget contract. |
| `openInBrowser` | Spawns `open` with `${webOrigin}/${owner}/${repo}/pull/${number}` — covered for both `github.com` and enterprise host. |
| Network calls | Use `fetch` interception (matches GitLab adapter test setup) for happy path of each method; one 404 case; one 401 case (sets `authState = "failed"`). |

Sidebar test addition in `src/__tests__/sidebar.test.ts`:

| Test | Assertion |
|------|-----------|
| Render with GitHub MR id `"acme/repo#42"` | `view.mrId === "#42"`. |
| Render with GitLab MR id `"acme%2Frepo:42"` | `view.mrId === "!42"` (regression). |

Input-router test in `src/__tests__/input-router.test.ts`:

| Test | Assertion |
|------|-----------|
| `Ctrl-a o` within soft-prefix window | calls `onOpenSessionMr`, does not forward `o` to PTY. |
| `Ctrl-a o` outside soft-prefix window | forwards `o` to PTY normally. |

## Documentation

Two existing user-facing docs need touch-ups:

- `docs/getting-started.md` — keybind reference: add `Ctrl-a o`.
- `docs/configuration.md` — adapter config: add the `codeHost.type =
  "github"` entry with example.

## Out-of-scope follow-ups

These are intentionally deferred and tracked as separate work, not
because they're hard but because they're not the bottleneck:

1. **Optimization hook**: `jmux ctl session refresh-mr` invoked from a
   Claude PostToolUse `Bash` hook to nudge the PollCoordinator
   immediately when `gh pr create` runs. Adds ~immediate visibility for
   the freshly-opened MR instead of the 20 s active poll wait. Defer
   until we observe whether 20 s feels slow in practice. (If pursued:
   no new options or state — just a one-shot poll trigger.)
2. **Codex hook support**: requires verified Codex stdin payload
   contract with fixtures.
3. **Open MR for an unfocused session via the sidebar**: clicking the MR
   ID / pipeline glyph in a non-focused session row could open in
   browser. Trivial follow-up once `Ctrl-a o` lands and the click
   handlers are clear.
4. **Legacy commit statuses for CI state**: `GET /repos/{owner}/{repo}/commits/{sha}/status`
   merged into the same `PipelineStatus` so projects using only legacy
   statuses (no GitHub Actions, no Checks API integrations) show a glyph
   too. Adds one call per matched MR per poll, doubling the per-MR
   hydration cost — defer until requested.
5. **Search pagination**: lift the 30-result cap on
   `getMyMergeRequests` / `getMrsAwaitingMyReview` /
   `searchMergeRequests` and add page navigation in the panel views.
