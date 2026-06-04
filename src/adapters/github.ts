import {
  HttpError,
  type CodeHostAdapter,
  type AdapterAuthState,
  type MergeRequest,
  type PipelineStatus,
  type BranchContext,
} from "./types";
import { logError } from "../log";

const GITHUB_API = "https://api.github.com";

export function extractOwnerRepo(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  try {
    const url = new URL(remoteUrl);
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return path || null;
  } catch {
    return null;
  }
}

function deriveGraphqlUrl(restBaseUrl: string): string {
  try {
    const url = new URL(restBaseUrl);
    if (url.hostname === "api.github.com") return "https://api.github.com/graphql";
    // GitHub Enterprise: https://HOST/api/v3 → https://HOST/api/graphql
    return `${url.protocol}//${url.hostname}/api/graphql`;
  } catch {
    return "https://api.github.com/graphql";
  }
}

function deriveWebUrl(restBaseUrl: string, ownerRepo: string, path: string): string {
  try {
    const url = new URL(restBaseUrl);
    if (url.hostname === "api.github.com") return `https://github.com/${ownerRepo}/${path}`;
    return `${url.protocol}//${url.hostname}/${ownerRepo}/${path}`;
  } catch {
    return `https://github.com/${ownerRepo}/${path}`;
  }
}

/** A single GitHub Checks-API check-run, narrowed to the fields we reduce over. */
export interface GhCheckRun {
  status: string; // queued | in_progress | completed | waiting | pending
  conclusion: string | null; // success | failure | neutral | cancelled | timed_out | action_required | skipped | null
}

/**
 * Reduce a set of GitHub check-runs into a single PipelineStatus.state.
 * Precedence: any failing conclusion (failure/timed_out/action_required) wins;
 * cancelled (without a failure) wins next; any non-completed run -> running;
 * otherwise (all completed, no failures) -> passed. Empty list -> null, which
 * callers map to "no pipeline" — matching how GitLab represents a missing
 * pipeline. The returned state stays within the
 * passed|running|failed|pending|canceled vocabulary the sidebar glyph map
 * depends on.
 */
export function derivePipelineState(
  checkRuns: ReadonlyArray<GhCheckRun>,
): PipelineStatus["state"] | null {
  if (checkRuns.length === 0) return null;
  const FAIL_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);
  const IN_PROGRESS_STATUSES = new Set(["queued", "in_progress", "waiting", "pending"]);
  let sawCancelled = false;
  let sawInProgress = false;
  for (const run of checkRuns) {
    if (run.conclusion && FAIL_CONCLUSIONS.has(run.conclusion)) return "failed";
    if (run.conclusion === "cancelled") sawCancelled = true;
    if (IN_PROGRESS_STATUSES.has(run.status)) sawInProgress = true;
  }
  if (sawCancelled) return "canceled";
  if (sawInProgress) return "running";
  return "passed";
}

/** Parse an MR id "owner/repo#number" into parts. Null on malformed input. */
export function parseMrId(
  mrId: string,
): { ownerRepo: string; number: string } | null {
  const hashIdx = mrId.lastIndexOf("#");
  if (hashIdx < 0) return null;
  const ownerRepo = mrId.slice(0, hashIdx);
  const number = mrId.slice(hashIdx + 1);
  if (!ownerRepo || !/^\d+$/.test(number)) return null;
  return { ownerRepo, number };
}

export class GitHubAdapter implements CodeHostAdapter {
  type = "github";
  authState: AdapterAuthState = "unauthenticated";
  authHint = "$GH_TOKEN or $GITHUB_TOKEN";
  private token: string | null = null;
  private baseUrl: string;
  private username: string | null = null;

  constructor(config: Record<string, unknown>) {
    this.baseUrl = (config.url as string) ?? process.env.GITHUB_ENTERPRISE_URL ?? GITHUB_API;
  }

  async authenticate(): Promise<void> {
    // Match GitLabAdapter: authentication is token-presence only — no network
    // I/O here. A transient blip at startup must not permanently flip authState
    // to "failed" (the coordinator never retries once authState !== "ok").
    // The username needed by getMyMergeRequests / getMrsAwaitingMyReview is
    // resolved lazily on first use and surfaces auth failures through the
    // normal handleErrorStatus path.
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
    if (token) {
      this.token = token;
      this.authState = "ok";
      return;
    }
    const ghToken = this.readGhToken();
    if (ghToken) {
      this.token = ghToken;
      this.authState = "ok";
      return;
    }
    this.authState = "failed";
  }

  // Extracted so tests can stub it without spawning `gh`. The array-form spawn
  // is injection-safe; the exit code is checked before trusting stdout.
  private readGhToken(): string | null {
    try {
      const proc = Bun.spawnSync(["gh", "auth", "token"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) return null;
      const output = proc.stdout.toString().trim();
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve and cache the authenticated user's login. Returns "" on failure
   * and routes auth errors (401/403) through handleErrorStatus so a real
   * credential problem surfaces the same way as any other call.
   */
  private async resolveUsername(): Promise<string> {
    if (this.username) return this.username;
    try {
      const resp = await this.fetch(`${this.baseUrl}/user`);
      if (!resp.ok) {
        this.handleErrorStatus(resp.status);
        return "";
      }
      const user = await resp.json();
      this.username = user.login ?? null;
      return this.username ?? "";
    } catch {
      return "";
    }
  }

  async getMergeRequest(
    remote: string,
    branch: string
  ): Promise<MergeRequest | null> {
    const ownerRepo = extractOwnerRepo(remote);
    if (!ownerRepo) return null;
    const params = new URLSearchParams({
      head: `${ownerRepo.split("/")[0]}:${branch}`,
      state: "open",
      per_page: "1",
    });
    const resp = await this.fetch(
      `${this.baseUrl}/repos/${ownerRepo}/pulls?${params}`
    );
    if (!resp.ok) {
      this.handleErrorStatus(resp.status);
      return null;
    }
    const prs = await resp.json();
    if (!Array.isArray(prs) || prs.length === 0) return null;
    return await this.mapPullRequest(prs[0]);
  }

  async pollMergeRequest(mrId: string): Promise<MergeRequest> {
    const parsed = parseMrId(mrId);
    if (!parsed) throw new HttpError(`Malformed GitHub MR id: ${mrId}`, 400);
    const { ownerRepo, number } = parsed;
    const resp = await this.fetch(
      `${this.baseUrl}/repos/${ownerRepo}/pulls/${number}`
    );
    if (!resp.ok) {
      this.handleErrorStatus(resp.status);
      throw new HttpError(`GitHub API error: ${resp.status}`, resp.status);
    }
    const pr = await resp.json();
    return await this.mapPullRequest(pr);
  }

  async pollAllMergeRequests(
    remotes: BranchContext[]
  ): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    const byRepo = new Map<string, BranchContext[]>();
    for (const bc of remotes) {
      const ownerRepo = extractOwnerRepo(bc.remote);
      if (!ownerRepo) continue;
      const list = byRepo.get(ownerRepo) ?? [];
      list.push(bc);
      byRepo.set(ownerRepo, list);
    }
    for (const [ownerRepo, contexts] of byRepo) {
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const resp = await this.fetch(
          `${this.baseUrl}/repos/${ownerRepo}/pulls?state=open&per_page=100&page=${page}`
        );
        if (!resp.ok) {
          this.handleErrorStatus(resp.status);
          break;
        }
        const prs = await resp.json();
        if (!Array.isArray(prs) || prs.length === 0) break;
        for (const pr of prs) {
          const matching = contexts.find(
            (c) => c.branch === pr.head?.ref
          );
          if (matching)
            result.set(matching.sessionName, await this.mapPullRequest(pr));
        }
        const moreAvailable = prs.length === 100;
        if (moreAvailable && page >= 10) {
          // Pagination cap reached. A repo with >1000 open PRs would otherwise
          // silently fail to resolve sessions whose branch lives past page 10.
          logError(
            "github",
            `pollAllMergeRequests: hit 10-page cap for ${ownerRepo} (>1000 open PRs); some sessions may not resolve their MR`,
          );
        }
        hasMore = moreAvailable && page < 10;
        page++;
      }
    }
    return result;
  }

  openInBrowser(mrId: string): void {
    const parsed = parseMrId(mrId);
    if (!parsed) return;
    const url = deriveWebUrl(this.baseUrl, parsed.ownerRepo, `pull/${parsed.number}`);
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  }

  async markReady(mrId: string): Promise<void> {
    const parsed = parseMrId(mrId);
    if (!parsed) return;
    const { ownerRepo, number } = parsed;
    const getResp = await this.fetch(
      `${this.baseUrl}/repos/${ownerRepo}/pulls/${number}`
    );
    if (!getResp.ok) return;
    const pr = await getResp.json();
    if (pr.draft) {
      const nodeId = pr.node_id;
      if (nodeId) {
        await this.graphql(
          `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${nodeId}" }) { pullRequest { id } } }`
        );
      }
    }
  }

  async approve(mrId: string): Promise<void> {
    const parsed = parseMrId(mrId);
    if (!parsed) return;
    const { ownerRepo, number } = parsed;
    await this.fetch(
      `${this.baseUrl}/repos/${ownerRepo}/pulls/${number}/reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "APPROVE" }),
      }
    );
  }

  async searchMergeRequests(query: string): Promise<MergeRequest[]> {
    return this.searchAndHydrate(`${query} is:pr is:open`);
  }

  parseMrUrl(url: string): string | null {
    const match = url.match(
      /\/([^/]+\/[^/]+)\/pull\/(\d+)/
    );
    if (!match) return null;
    return `${match[1]}#${match[2]}`;
  }

  async pollMergeRequestsByIds(
    ids: string[]
  ): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    for (const id of ids) {
      try {
        const mr = await this.pollMergeRequest(id);
        result.set(id, mr);
      } catch {
        // Mirrors GitLabAdapter's per-id resilience: one failed PR doesn't
        // poison the rest of the batch.
      }
    }
    return result;
  }

  async getMyMergeRequests(): Promise<MergeRequest[]> {
    if (this.authState !== "ok") return [];
    const username = await this.resolveUsername();
    if (!username) return [];
    return this.searchAndHydrate(`is:pr is:open author:${username}`);
  }

  async getMrsAwaitingMyReview(): Promise<MergeRequest[]> {
    if (this.authState !== "ok") return [];
    const username = await this.resolveUsername();
    if (!username) return [];
    // `user-review-requested:` matches PRs where the user is *directly*
    // requested. The shorter `review-requested:` also matches team-routed
    // requests, which is broader than this surface wants.
    return this.searchAndHydrate(
      `is:pr is:open user-review-requested:${username}`,
    );
  }

  /**
   * Run a /search/issues query and hydrate each hit into a fully-populated
   * MergeRequest. Search results are ISSUE objects with no head/base/draft —
   * so we follow each item's `pull_request.url` to the real PR and shape it
   * through mapPullRequest. This unifies searchMergeRequests /
   * getMyMergeRequests / getMrsAwaitingMyReview on one shape. Pipeline state
   * is hydrated like any other PR via mapPullRequest's check-runs fetch.
   */
  private async searchAndHydrate(query: string): Promise<MergeRequest[]> {
    const resp = await this.fetch(
      `${this.baseUrl}/search/issues?q=${encodeURIComponent(query)}&per_page=30`
    );
    if (!resp.ok) {
      this.handleErrorStatus(resp.status);
      return [];
    }
    const data = await resp.json();
    const items: any[] = Array.isArray(data?.items) ? data.items : [];
    const prUrls = items
      .map((it) => it?.pull_request?.url)
      .filter((u: unknown): u is string => typeof u === "string");
    const prResponses = await Promise.all(prUrls.map((u) => this.fetch(u)));
    const results: MergeRequest[] = [];
    for (const r of prResponses) {
      if (!r.ok) {
        this.handleErrorStatus(r.status);
        continue;
      }
      const raw = await r.json();
      results.push(await this.mapPullRequest(raw));
    }
    return results;
  }

  private async fetchCheckRunStatus(
    ownerRepo: string,
    sha: string
  ): Promise<PipelineStatus | null> {
    try {
      const resp = await this.fetch(
        `${this.baseUrl}/repos/${ownerRepo}/commits/${sha}/check-runs?per_page=100`
      );
      if (!resp.ok) {
        this.handleErrorStatus(resp.status);
        return null;
      }
      const data = await resp.json();
      const runs: GhCheckRun[] = Array.isArray(data.check_runs) ? data.check_runs : [];
      const state = derivePipelineState(runs);
      if (state === null) return null;
      const webUrl = deriveWebUrl(this.baseUrl, ownerRepo, "actions");
      return { state, webUrl };
    } catch {
      return null;
    }
  }

  private async fetchApprovals(
    ownerRepo: string,
    number: number,
    targetBranch: string
  ): Promise<{ required: number; current: number }> {
    try {
      const resp = await this.fetch(
        `${this.baseUrl}/repos/${ownerRepo}/pulls/${number}/reviews`
      );
      if (!resp.ok) return { required: 0, current: 0 };
      const reviews = await resp.json();
      if (!Array.isArray(reviews)) return { required: 0, current: 0 };
      const approvers = new Set<string>();
      for (const review of reviews) {
        const login = review.user?.login;
        // Skip reviews with no resolvable author — an empty login must never
        // pollute the approver set (it would inflate the approval count).
        if (!login) continue;
        if (review.state === "APPROVED") approvers.add(login);
        else if (review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED")
          approvers.delete(login);
      }
      let required = 0;
      const branch = targetBranch || "main";
      try {
        const branchResp = await this.fetch(
          `${this.baseUrl}/repos/${ownerRepo}/branches/${encodeURIComponent(branch)}/protection`
        );
        // Branch protection is frequently 403 (token lacks admin scope) or 404
        // (no protection rule). Both are non-fatal here: we only read the gate
        // when it's exposed, and the branchResp.ok guard keeps authState
        // untouched in those cases.
        if (branchResp.ok) {
          const protection = await branchResp.json();
          required =
            protection.required_pull_request_reviews
              ?.required_approving_review_count ?? 0;
        }
      } catch {}
      return { required, current: approvers.size };
    } catch {
      return { required: 0, current: 0 };
    }
  }

  private async mapPullRequest(raw: any): Promise<MergeRequest> {
    const ownerRepo: string = raw.base?.repo?.full_name ?? "";
    const number: number = raw.number ?? 0;
    const sha = raw.head?.sha;
    const targetBranch = raw.base?.ref ?? "";
    const [pipeline, approvals] = await Promise.all([
      sha && ownerRepo ? this.fetchCheckRunStatus(ownerRepo, sha) : Promise.resolve(null),
      ownerRepo ? this.fetchApprovals(ownerRepo, number, targetBranch) : Promise.resolve({ required: 0, current: 0 }),
    ]);
    return {
      id: `${ownerRepo}#${number}`,
      title: raw.title ?? "",
      status: raw.draft
        ? "draft"
        : raw.merged_at
          ? "merged"
          : raw.state === "closed"
            ? "closed"
            : "open",
      sourceBranch: raw.head?.ref ?? "",
      targetBranch,
      pipeline,
      approvals,
      webUrl: raw.html_url ?? "",
      author: raw.user?.login ?? undefined,
      reviewers: Array.isArray(raw.requested_reviewers)
        ? raw.requested_reviewers
            .map((r: any) => r.login)
            .filter((l: unknown): l is string => typeof l === "string")
        : undefined,
      createdAt: raw.created_at
        ? new Date(raw.created_at).getTime()
        : undefined,
      updatedAt: raw.updated_at
        ? new Date(raw.updated_at).getTime()
        : undefined,
    };
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    const resp = await fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${this.token ?? ""}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    this.inspectRateLimit(resp);
    return resp;
  }

  private inspectRateLimit(resp: Response): void {
    const remaining = resp.headers.get("x-ratelimit-remaining");
    if (remaining !== null && parseInt(remaining, 10) <= 10) {
      const reset = resp.headers.get("x-ratelimit-reset");
      const resetAt = reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : "unknown";
      logError("github", `rate limit low: ${remaining} remaining, resets at ${resetAt}`);
    }
  }

  private async graphql(query: string): Promise<any> {
    const graphqlUrl = deriveGraphqlUrl(this.baseUrl);
    const resp = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) throw new HttpError(`GitHub GraphQL error: ${resp.status}`, resp.status);
    return resp.json();
  }

  private handleErrorStatus(status: number): void {
    if (status === 401 || status === 403) this.authState = "failed";
  }
}
