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
  `baseUrl` config field. (Matches GitLab adapter pattern.)
- **No write operations beyond what GitLabAdapter offers.** `approve` and
  `markReady` map to GitHub equivalents, but we don't add new verbs.

## Architecture

No new modules. Three files change; one new file is added.

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
new GitHubAdapter({ url?: string }) // url defaults to "https://api.github.com"
```

A user with a self-hosted GitHub Enterprise instance sets
`codeHost = { type: "github", url: "https://github.acme.corp/api/v3" }`
in their jmux config. Same shape as GitLab.

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
| `openInBrowser(mrId)` | Build URL from `mrId`: `https://github.com/{owner}/{repo}/pull/{number}` (or self-hosted base host swapped in). |
| `markReady(mrId)` | `PATCH /repos/{owner}/{repo}/pulls/{number}` with `{ draft: false }`. |
| `approve(mrId)` | `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with `{ event: "APPROVE" }`. |
| `searchMergeRequests(query)` | `GET /search/issues?q={query}+type:pr+state:open`. |
| `parseMrUrl(url)` | Regex against `https://(api\.)?github(\.com\|enterprise host)/[^/]+/[^/]+/pull/\d+`. Return `"<owner>/<repo>#<number>"` or null. |
| `pollMergeRequestsByIds(ids)` | One `GET` per id, executed sequentially with the existing rate-limit guard (matches GitLab adapter behavior for parity). |
| `getMyMergeRequests()` | `GET /search/issues?q=author:@me+type:pr+state:open`. |
| `getMrsAwaitingMyReview()` | `GET /search/issues?q=review-requested:@me+type:pr+state:open`. |

### Pipeline state mapping

GitHub does not expose a single "pipeline" object per PR. Instead each
commit has check-runs (Actions, third-party CI) and a legacy status API.
For v1, query the head SHA's combined status + check runs:

`GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs`

Combine results into a single `PipelineStatus`:

| Check states present | → `PipelineStatus.state` |
|----------------------|--------------------------|
| any `conclusion ∈ {failure, timed_out, action_required}` | `failed` |
| any `conclusion = cancelled` and no failures | `canceled` |
| any `status ∈ {queued, in_progress, waiting, pending}` | `running` |
| all `conclusion = success` (or `neutral` / `skipped`) | `passed` |
| empty list | `null` (no pipeline, render no glyph) |

`PipelineStatus.webUrl` is `pr.html_url + "/checks"`.

This calls one extra endpoint per MR poll. Acceptable: PollCoordinator's
20 s active cadence and 100-MR background list both already make ~one
call per session; doubling to two is well within GitHub's 5000 req/hour
authenticated limit. Skip the call when the PR has zero check runs (cache
the empty result on the MR object for the polling interval).

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
| `mapMergeRequest` | Full PR JSON → MergeRequest including: status mapping (`draft`/`open`/`merged`/`closed`), approvals from `requested_reviewers` + review count, pipeline derivation from check-runs (one happy case per state), `webUrl` preserved. |
| `pipeline state mapping` | Pure helper `derivePipelineState(checkRuns)` covering each row of the mapping table above. |
| `auth fallback` | `$GITHUB_TOKEN` present → uses env; absent + `gh auth token` succeeds → uses gh token; both absent → `authState = "failed"`. |
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
