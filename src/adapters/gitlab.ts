import {
  HttpError,
  type CodeHostAdapter,
  type AdapterAuthState,
  type MergeRequest,
  type PipelineStatus,
  type BranchContext,
} from "./types";

const GITLAB_API = "https://gitlab.com/api/v4";

export function extractProjectPath(remoteUrl: string): string | null {
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

export class GitLabAdapter implements CodeHostAdapter {
  type = "gitlab";
  authState: AdapterAuthState = "unauthenticated";
  authHint = "$GITLAB_TOKEN or $GITLAB_PRIVATE_TOKEN";
  private token: string | null = null;
  private baseUrl: string;

  constructor(config: Record<string, unknown>) {
    this.baseUrl = (config.url as string) ?? GITLAB_API;
  }

  async authenticate(): Promise<void> {
    const token = process.env.GITLAB_TOKEN ?? process.env.GITLAB_PRIVATE_TOKEN ?? process.env.GITLAB_PERSONAL_ACCESS_TOKEN ?? null;
    if (!token) {
      try {
        const proc = Bun.spawnSync(["glab", "auth", "status", "-t"], { stdout: "pipe", stderr: "pipe" });
        const output = proc.stdout.toString() + proc.stderr.toString();
        const match = output.match(/Token:\s+(\S+)/);
        if (match) { this.token = match[1]; this.authState = "ok"; return; }
      } catch {}
      this.authState = "failed";
      return;
    }
    this.token = token;
    this.authState = "ok";
  }

  async getMergeRequest(remote: string, branch: string): Promise<MergeRequest | null> {
    const project = extractProjectPath(remote);
    if (!project) return null;
    const encoded = encodeURIComponent(project);
    const params = new URLSearchParams({ source_branch: branch, state: "opened", per_page: "1" });
    const resp = await this.fetch(`${this.baseUrl}/projects/${encoded}/merge_requests?${params}`);
    if (!resp.ok) { this.handleErrorStatus(resp.status); return null; }
    const mrs = await resp.json();
    if (!Array.isArray(mrs) || mrs.length === 0) return null;
    return this.mapMergeRequest(mrs[0]);
  }

  async pollMergeRequest(mrId: string): Promise<MergeRequest> {
    const [project, iid] = mrId.split(":");
    const resp = await this.fetch(`${this.baseUrl}/projects/${project}/merge_requests/${iid}`);
    if (!resp.ok) throw new HttpError(`GitLab API error: ${resp.status}`, resp.status);
    return this.mapMergeRequest(await resp.json());
  }

  async pollAllMergeRequests(remotes: BranchContext[]): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    const byProject = new Map<string, BranchContext[]>();
    for (const bc of remotes) {
      const project = extractProjectPath(bc.remote);
      if (!project) continue;
      const list = byProject.get(project) ?? [];
      list.push(bc);
      byProject.set(project, list);
    }
    for (const [project, contexts] of byProject) {
      const encoded = encodeURIComponent(project);
      const resp = await this.fetch(`${this.baseUrl}/projects/${encoded}/merge_requests?state=opened&per_page=100`);
      if (!resp.ok) continue;
      const mrs = await resp.json();
      if (!Array.isArray(mrs)) continue;
      for (const mr of mrs) {
        const matching = contexts.find((c) => c.branch === mr.source_branch);
        if (matching) result.set(matching.sessionName, this.mapMergeRequest(mr));
      }
    }
    return result;
  }

  openInBrowser(mrId: string): void {
    const [project, iid] = mrId.split(":");
    const projectPath = decodeURIComponent(project);
    const url = `https://gitlab.com/${projectPath}/-/merge_requests/${iid}`;
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  }

  async markReady(mrId: string): Promise<void> {
    const [project, iid] = mrId.split(":");
    const getResp = await this.fetch(`${this.baseUrl}/projects/${project}/merge_requests/${iid}`);
    if (getResp.ok) {
      const mr = await getResp.json();
      const newTitle = (mr.title as string).replace(/^Draft:\s*/i, "");
      await this.fetch(`${this.baseUrl}/projects/${project}/merge_requests/${iid}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
    }
  }

  async approve(mrId: string): Promise<void> {
    const [project, iid] = mrId.split(":");
    await this.fetch(`${this.baseUrl}/projects/${project}/merge_requests/${iid}/approve`, { method: "POST" });
  }

  async searchMergeRequests(query: string): Promise<MergeRequest[]> {
    const params = new URLSearchParams({
      search: query,
      state: "opened",
      scope: "all",
      per_page: "20",
    });
    const resp = await this.fetch(`${this.baseUrl}/merge_requests?${params}`);
    if (!resp.ok) return [];
    const mrs = await resp.json();
    if (!Array.isArray(mrs)) return [];
    return mrs.map((mr: any) => this.mapMergeRequest(mr));
  }

  parseMrUrl(url: string): string | null {
    // Match path after the hostname: /org/repo/-/merge_requests/42
    const match = url.match(/\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (!match) return null;
    return `${encodeURIComponent(match[1])}:${match[2]}`;
  }

  async pollMergeRequestsByIds(ids: string[]): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    for (const id of ids) {
      const [project, iid] = id.split(":");
      try {
        const resp = await this.fetch(
          `${this.baseUrl}/projects/${project}/merge_requests/${iid}`,
        );
        if (resp.ok) {
          const mr = this.mapMergeRequest(await resp.json());
          result.set(id, mr);
        }
      } catch {}
    }
    return result;
  }

  async getMyMergeRequests(): Promise<MergeRequest[]> {
    if (this.authState !== "ok") return [];
    const resp = await this.fetch(
      `${this.baseUrl}/merge_requests?scope=created_by_me&state=opened&per_page=100`,
    );
    if (!resp.ok) return [];
    const mrs = await resp.json();
    if (!Array.isArray(mrs)) return [];
    return mrs.map((mr: any) => this.mapMergeRequest(mr));
  }

  async getMrsAwaitingMyReview(): Promise<MergeRequest[]> {
    if (this.authState !== "ok") return [];
    let username = "";
    try {
      const userResp = await this.fetch(`${this.baseUrl}/user`);
      if (userResp.ok) {
        const user = await userResp.json();
        username = user.username ?? "";
      }
    } catch {}
    if (!username) return [];
    const resp = await this.fetch(
      `${this.baseUrl}/merge_requests?reviewer_username=${encodeURIComponent(username)}&state=opened&per_page=100`,
    );
    if (!resp.ok) return [];
    const mrs = await resp.json();
    if (!Array.isArray(mrs)) return [];
    return mrs.map((mr: any) => this.mapMergeRequest(mr));
  }

  private mapMergeRequest(raw: any): MergeRequest {
    let pipeline: PipelineStatus | null = null;
    if (raw.head_pipeline) {
      pipeline = { state: this.mapPipelineState(raw.head_pipeline.status), webUrl: raw.head_pipeline.web_url ?? "" };
    }
    return {
      id: `${encodeURIComponent(raw.project_id?.toString() ?? "")}:${raw.iid}`,
      title: raw.title ?? "",
      status: raw.draft ? "draft" : raw.state === "merged" ? "merged" : raw.state === "closed" ? "closed" : "open",
      sourceBranch: raw.source_branch ?? "",
      targetBranch: raw.target_branch ?? "",
      pipeline,
      approvals: { required: raw.approvals_required ?? 0, current: raw.approved_by?.length ?? 0 },
      webUrl: raw.web_url ?? "",
      author: raw.author?.username ?? raw.author?.name ?? undefined,
      reviewers: Array.isArray(raw.reviewers) ? raw.reviewers.map((r: any) => r.username ?? r.name) : undefined,
      updatedAt: raw.updated_at ? new Date(raw.updated_at).getTime() : undefined,
    };
  }

  private mapPipelineState(status: string): PipelineStatus["state"] {
    switch (status) {
      case "success": return "passed";
      case "failed": return "failed";
      case "running": return "running";
      case "pending": case "waiting_for_resource": case "preparing": return "pending";
      case "canceled": case "skipped": return "canceled";
      default: return "pending";
    }
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    return fetch(url, { ...init, headers: { ...init?.headers, "PRIVATE-TOKEN": this.token ?? "" } });
  }

  private handleErrorStatus(status: number): void {
    if (status === 401 || status === 403) this.authState = "failed";
  }
}
