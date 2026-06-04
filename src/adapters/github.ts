import {
  HttpError,
  type CodeHostAdapter,
  type AdapterAuthState,
  type MergeRequest,
  type PipelineStatus,
  type BranchContext,
} from "./types";

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
    const token =
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      null;
    if (!token) {
      try {
        const proc = Bun.spawnSync(["gh", "auth", "token"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = proc.stdout.toString().trim();
        if (output) {
          this.token = output;
          await this.validateAndFetchUsername();
          return;
        }
      } catch {}
      this.authState = "failed";
      return;
    }
    this.token = token;
    await this.validateAndFetchUsername();
  }

  private async validateAndFetchUsername(): Promise<void> {
    try {
      const resp = await this.fetch(`${this.baseUrl}/user`);
      if (resp.ok) {
        const user = await resp.json();
        this.username = user.login ?? null;
        this.authState = "ok";
      } else {
        this.authState = "failed";
      }
    } catch {
      this.authState = "failed";
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
    return await this.mapPullRequest(prs[0], ownerRepo);
  }

  async pollMergeRequest(mrId: string): Promise<MergeRequest> {
    const [ownerRepo, number] = this.parseId(mrId);
    const resp = await this.fetch(
      `${this.baseUrl}/repos/${ownerRepo}/pulls/${number}`
    );
    if (!resp.ok) throw new HttpError(`GitHub API error: ${resp.status}`, resp.status);
    const pr = await resp.json();
    return await this.mapPullRequest(pr, ownerRepo);
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
        if (!resp.ok) break;
        const prs = await resp.json();
        if (!Array.isArray(prs) || prs.length === 0) break;
        for (const pr of prs) {
          const matching = contexts.find(
            (c) => c.branch === pr.head?.ref
          );
          if (matching)
            result.set(matching.sessionName, await this.mapPullRequest(pr, ownerRepo));
        }
        hasMore = prs.length === 100 && page < 10;
        page++;
      }
    }
    return result;
  }

  openInBrowser(mrId: string): void {
    const [ownerRepo, number] = this.parseId(mrId);
    const url = deriveWebUrl(this.baseUrl, ownerRepo, `pull/${number}`);
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  }

  async markReady(mrId: string): Promise<void> {
    const [ownerRepo, number] = this.parseId(mrId);
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
    const [ownerRepo, number] = this.parseId(mrId);
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
    const searchQuery = `${query} is:pr is:open`;
    const resp = await this.fetch(
      `${this.baseUrl}/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=20`
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.items || !Array.isArray(data.items)) return [];
    const results: MergeRequest[] = [];
    for (const item of data.items) {
      const repoMatch = item.repository_url?.match(
        /repos\/(.+)$/
      );
      const ownerRepo = repoMatch ? repoMatch[1] : "";
      results.push({
        id: `${ownerRepo}:${item.number}`,
        title: item.title ?? "",
        status: item.draft ? "draft" : "open",
        sourceBranch: item.head?.ref ?? "",
        targetBranch: item.base?.ref ?? "",
        pipeline: null,
        approvals: { required: 0, current: 0 },
        webUrl: item.html_url ?? "",
        author: item.user?.login ?? undefined,
        createdAt: item.created_at
          ? new Date(item.created_at).getTime()
          : undefined,
        updatedAt: item.updated_at
          ? new Date(item.updated_at).getTime()
          : undefined,
      });
    }
    return results;
  }

  parseMrUrl(url: string): string | null {
    const match = url.match(
      /\/([^/]+\/[^/]+)\/pull\/(\d+)/
    );
    if (!match) return null;
    return `${match[1]}:${match[2]}`;
  }

  async pollMergeRequestsByIds(
    ids: string[]
  ): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    for (const id of ids) {
      const [ownerRepo, number] = this.parseId(id);
      try {
        const resp = await this.fetch(
          `${this.baseUrl}/repos/${ownerRepo}/pulls/${number}`
        );
        if (resp.ok) {
          result.set(id, await this.mapPullRequest(await resp.json(), ownerRepo));
        }
      } catch {}
    }
    return result;
  }

  async getMyMergeRequests(): Promise<MergeRequest[]> {
    if (this.authState !== "ok" || !this.username) return [];
    const query = `is:pr is:open author:${this.username}`;
    const resp = await this.fetch(
      `${this.baseUrl}/search/issues?q=${encodeURIComponent(query)}&per_page=100`
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.items || !Array.isArray(data.items)) return [];
    return data.items.map((item: any) => {
      const repoMatch = item.repository_url?.match(/repos\/(.+)$/);
      const ownerRepo = repoMatch ? repoMatch[1] : "";
      return this.mapSearchItem(item, ownerRepo);
    });
  }

  async getMrsAwaitingMyReview(): Promise<MergeRequest[]> {
    if (this.authState !== "ok" || !this.username) return [];
    const query = `is:pr is:open review-requested:${this.username}`;
    const resp = await this.fetch(
      `${this.baseUrl}/search/issues?q=${encodeURIComponent(query)}&per_page=100`
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.items || !Array.isArray(data.items)) return [];
    return data.items.map((item: any) => {
      const repoMatch = item.repository_url?.match(/repos\/(.+)$/);
      const ownerRepo = repoMatch ? repoMatch[1] : "";
      return this.mapSearchItem(item, ownerRepo);
    });
  }

  private async fetchCheckRunStatus(
    ownerRepo: string,
    sha: string
  ): Promise<PipelineStatus | null> {
    try {
      const resp = await this.fetch(
        `${this.baseUrl}/repos/${ownerRepo}/commits/${sha}/check-runs?per_page=100`
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      const runs = data.check_runs;
      if (!Array.isArray(runs) || runs.length === 0) return null;
      const hasFailure = runs.some((r: any) => r.conclusion === "failure");
      const hasRunning = runs.some((r: any) => r.status !== "completed");
      const allSuccess = runs.every(
        (r: any) => r.status === "completed" && r.conclusion === "success"
      );
      const hasCancelled = runs.some(
        (r: any) => r.conclusion === "cancelled" || r.conclusion === "skipped"
      );
      let state: PipelineStatus["state"] = "pending";
      if (hasFailure) state = "failed";
      else if (hasRunning) state = "running";
      else if (allSuccess) state = "passed";
      else if (hasCancelled) state = "canceled";
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
        if (review.state === "APPROVED") approvers.add(review.user?.login ?? "");
        else if (review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED")
          approvers.delete(review.user?.login ?? "");
      }
      let required = 0;
      const branch = targetBranch || "main";
      try {
        const branchResp = await this.fetch(
          `${this.baseUrl}/repos/${ownerRepo}/branches/${encodeURIComponent(branch)}/protection`
        );
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

  private async mapPullRequest(raw: any, ownerRepo: string): Promise<MergeRequest> {
    const sha = raw.head?.sha;
    const targetBranch = raw.base?.ref ?? "";
    const [pipeline, approvals] = await Promise.all([
      sha ? this.fetchCheckRunStatus(ownerRepo, sha) : Promise.resolve(null),
      this.fetchApprovals(ownerRepo, raw.number, targetBranch),
    ]);
    return {
      id: `${ownerRepo}:${raw.number}`,
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
        ? raw.requested_reviewers.map((r: any) => r.login)
        : undefined,
      createdAt: raw.created_at
        ? new Date(raw.created_at).getTime()
        : undefined,
      updatedAt: raw.updated_at
        ? new Date(raw.updated_at).getTime()
        : undefined,
    };
  }

  private mapSearchItem(item: any, ownerRepo: string): MergeRequest {
    return {
      id: `${ownerRepo}:${item.number}`,
      title: item.title ?? "",
      status: item.draft ? "draft" : "open",
      sourceBranch: "",
      targetBranch: "",
      pipeline: null,
      approvals: { required: 0, current: 0 },
      webUrl: item.html_url ?? "",
      author: item.user?.login ?? undefined,
      createdAt: item.created_at
        ? new Date(item.created_at).getTime()
        : undefined,
      updatedAt: item.updated_at
        ? new Date(item.updated_at).getTime()
        : undefined,
    };
  }

  private parseId(mrId: string): [string, string] {
    const lastColon = mrId.lastIndexOf(":");
    return [mrId.slice(0, lastColon), mrId.slice(lastColon + 1)];
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
      console.warn(`[github] rate limit low: ${remaining} remaining, resets at ${resetAt}`);
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
