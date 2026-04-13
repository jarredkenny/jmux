import type {
  CodeHostAdapter,
  AdapterAuthState,
  MergeRequest,
  BranchContext,
} from "../adapters/types";
import { DEMO_MRS, DEMO_REVIEW_MR_IDS } from "./seed-data";

export class DemoCodeHostAdapter implements CodeHostAdapter {
  type = "demo";
  authState: AdapterAuthState = "ok";
  authHint = "demo mode — no credentials needed";

  private mrs: Map<string, MergeRequest>;
  private byBranch: Map<string, MergeRequest>;

  constructor() {
    this.mrs = new Map();
    this.byBranch = new Map();
    for (const mr of DEMO_MRS) {
      const copy = { ...mr, approvals: { ...mr.approvals } };
      this.mrs.set(mr.id, copy);
      this.byBranch.set(mr.sourceBranch, copy);
    }
  }

  async authenticate(): Promise<void> {
    // no-op in demo mode
  }

  async getMergeRequest(_remote: string, branch: string): Promise<MergeRequest | null> {
    const mr = this.byBranch.get(branch);
    return mr ? { ...mr, approvals: { ...mr.approvals } } : null;
  }

  async pollMergeRequest(mrId: string): Promise<MergeRequest> {
    const mr = this.mrs.get(mrId);
    if (!mr) throw new Error(`Demo: MR not found: ${mrId}`);
    return { ...mr, approvals: { ...mr.approvals } };
  }

  async pollAllMergeRequests(remotes: BranchContext[]): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    for (const { sessionName, branch } of remotes) {
      const mr = this.byBranch.get(branch);
      if (mr) result.set(sessionName, { ...mr, approvals: { ...mr.approvals } });
    }
    return result;
  }

  async pollMergeRequestsByIds(ids: string[]): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    for (const id of ids) {
      const mr = this.mrs.get(id);
      if (mr) result.set(id, { ...mr, approvals: { ...mr.approvals } });
    }
    return result;
  }

  openInBrowser(_mrId: string): void {
    // no-op in demo mode
  }

  async markReady(mrId: string): Promise<void> {
    const mr = this.mrs.get(mrId);
    if (!mr) throw new Error(`Demo: MR not found: ${mrId}`);
    if (mr.status === "draft") {
      mr.status = "open";
      const branchMr = this.byBranch.get(mr.sourceBranch);
      if (branchMr) branchMr.status = "open";
    }
  }

  async approve(mrId: string): Promise<void> {
    const mr = this.mrs.get(mrId);
    if (!mr) throw new Error(`Demo: MR not found: ${mrId}`);
    mr.approvals.current += 1;
    const branchMr = this.byBranch.get(mr.sourceBranch);
    if (branchMr) branchMr.approvals.current = mr.approvals.current;
  }

  async searchMergeRequests(query: string): Promise<MergeRequest[]> {
    const q = query.toLowerCase();
    const results: MergeRequest[] = [];
    for (const mr of this.mrs.values()) {
      if (mr.title.toLowerCase().includes(q) || mr.sourceBranch.toLowerCase().includes(q)) {
        results.push({ ...mr, approvals: { ...mr.approvals } });
      }
    }
    return results;
  }

  parseMrUrl(url: string): string | null {
    const match = url.match(/^https?:\/\/gitlab\.com\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (!match) return null;
    const encodedPath = match[1].split("/").map(encodeURIComponent).join("%2F");
    return `${encodedPath}:${match[2]}`;
  }

  async getMyMergeRequests(): Promise<MergeRequest[]> {
    return Array.from(this.mrs.values()).map((mr) => ({
      ...mr,
      approvals: { ...mr.approvals },
    }));
  }

  async getMrsAwaitingMyReview(): Promise<MergeRequest[]> {
    return Array.from(this.mrs.values())
      .filter((mr) => DEMO_REVIEW_MR_IDS.has(mr.id))
      .map((mr) => ({ ...mr, approvals: { ...mr.approvals } }));
  }
}
