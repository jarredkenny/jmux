import type { IssueTrackerAdapter, Issue, AdapterAuthState } from "../adapters/types";
import { buildLinearPrompt } from "../adapters/linear-prompt";
import { DEMO_ISSUES, DEMO_TEAMS } from "./seed-data";

const AVAILABLE_STATUSES = ["Backlog", "Todo", "In Progress", "In Review", "Done"];

export class DemoIssueTrackerAdapter implements IssueTrackerAdapter {
  type = "demo";
  authState: AdapterAuthState = "ok";
  authHint = "demo mode — no credentials needed";

  private issues: Map<string, Issue>;
  private byBranch: Map<string, Issue>;

  constructor() {
    this.issues = new Map();
    this.byBranch = new Map();

    for (const issue of DEMO_ISSUES) {
      const copy = { ...issue, linkedMrUrls: [...issue.linkedMrUrls] };
      this.issues.set(copy.id, copy);
      if (copy.branchName) {
        this.byBranch.set(copy.branchName, copy);
      }
    }
  }

  async authenticate(): Promise<void> {
    // no-op — always authenticated in demo mode
  }

  async getLinkedIssue(mrUrl: string): Promise<Issue | null> {
    for (const issue of this.issues.values()) {
      if (issue.linkedMrUrls.includes(mrUrl)) {
        return { ...issue, linkedMrUrls: [...issue.linkedMrUrls] };
      }
    }
    return null;
  }

  async getIssueByBranch(branch: string): Promise<Issue | null> {
    const issue = this.byBranch.get(branch);
    if (!issue) return null;
    return { ...issue, linkedMrUrls: [...issue.linkedMrUrls] };
  }

  async pollIssue(issueId: string): Promise<Issue> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Demo issue not found: ${issueId}`);
    return { ...issue, linkedMrUrls: [...issue.linkedMrUrls] };
  }

  async pollAllIssues(issueIds: string[]): Promise<Map<string, Issue>> {
    const result = new Map<string, Issue>();
    for (const id of issueIds) {
      const issue = this.issues.get(id);
      if (issue) {
        result.set(id, { ...issue, linkedMrUrls: [...issue.linkedMrUrls] });
      }
    }
    return result;
  }

  async getAvailableStatuses(_issueId: string): Promise<string[]> {
    return [...AVAILABLE_STATUSES];
  }

  openInBrowser(_issueId: string): void {
    // no-op in demo mode
  }

  async updateStatus(issueId: string, status: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Demo issue not found: ${issueId}`);
    issue.status = status;
    // byBranch holds a reference to the same object, so it's already updated
  }

  async createIssue(teamId: string, title: string, description: string): Promise<Issue> {
    const id = `demo-${Date.now()}`;
    const identifier = `DEMO-${this.issues.size + 1}`;
    const issue: Issue = {
      id,
      identifier,
      title,
      description,
      status: "Backlog",
      assignee: null,
      linkedMrUrls: [],
      webUrl: "",
      team: teamId,
    };
    this.issues.set(id, issue);
    return { ...issue, linkedMrUrls: [] };
  }

  async searchIssues(query: string): Promise<Issue[]> {
    const lower = query.toLowerCase();
    const results: Issue[] = [];
    for (const issue of this.issues.values()) {
      if (
        issue.title.toLowerCase().includes(lower) ||
        issue.identifier.toLowerCase().includes(lower)
      ) {
        results.push({ ...issue, linkedMrUrls: [...issue.linkedMrUrls] });
      }
    }
    return results;
  }

  async getMyIssues(): Promise<Issue[]> {
    return Array.from(this.issues.values()).map((issue) => ({
      ...issue,
      linkedMrUrls: [...issue.linkedMrUrls],
    }));
  }

  async getTeams(): Promise<Array<{ id: string; name: string }>> {
    return DEMO_TEAMS;
  }

  buildPrompt(issue: Issue): string {
    return buildLinearPrompt(issue);
  }
}
