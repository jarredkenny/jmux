export interface PipelineStatus {
  state: "running" | "passed" | "failed" | "pending" | "canceled";
  webUrl: string;
}

export interface MergeRequest {
  id: string;
  title: string;
  status: "draft" | "open" | "merged" | "closed";
  sourceBranch: string;
  targetBranch: string;
  pipeline: PipelineStatus | null;
  approvals: { required: number; current: number };
  webUrl: string;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assignee: string | null;
  linkedMrUrls: string[];
  webUrl: string;
}

export interface BranchContext {
  sessionName: string;
  remote: string;
  branch: string;
}

export interface SessionContext {
  sessionName: string;
  dir: string;
  branch: string | null;
  remote: string | null;
  mrs: Array<MergeRequest & { source: LinkSource }>;
  issues: Array<Issue & { source: LinkSource }>;
  resolvedAt: number;
}

export type AdapterAuthState = "ok" | "failed" | "unauthenticated";

export type LinkSource = "manual" | "branch" | "mr-link" | "transitive";

export interface CodeHostAdapter {
  type: string;
  authState: AdapterAuthState;
  authHint: string;

  authenticate(): Promise<void>;
  getMergeRequest(remote: string, branch: string): Promise<MergeRequest | null>;
  pollMergeRequest(mrId: string): Promise<MergeRequest>;
  pollAllMergeRequests(remotes: BranchContext[]): Promise<Map<string, MergeRequest>>;
  openInBrowser(mrId: string): void;
  markReady(mrId: string): Promise<void>;
  approve(mrId: string): Promise<void>;
  searchMergeRequests(query: string): Promise<MergeRequest[]>;
  parseMrUrl(url: string): string | null;
  pollMergeRequestsByIds(ids: string[]): Promise<Map<string, MergeRequest>>;
}

export interface IssueTrackerAdapter {
  type: string;
  authState: AdapterAuthState;
  authHint: string;

  authenticate(): Promise<void>;
  getLinkedIssue(mrUrl: string): Promise<Issue | null>;
  getIssueByBranch(branch: string): Promise<Issue | null>;
  pollIssue(issueId: string): Promise<Issue>;
  pollAllIssues(issueIds: string[]): Promise<Map<string, Issue>>;
  getAvailableStatuses(issueId: string): Promise<string[]>;
  openInBrowser(issueId: string): void;
  updateStatus(issueId: string, status: string): Promise<void>;
  searchIssues(query: string): Promise<Issue[]>;
}

export interface AdapterConfig {
  codeHost?: { type: string; [key: string]: unknown };
  issueTracker?: { type: string; [key: string]: unknown };
}
