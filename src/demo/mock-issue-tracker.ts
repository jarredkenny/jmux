import type { IssueTrackerAdapter, Issue, AdapterAuthState, IssueStateType, WorkflowState } from "../adapters/types";
import { buildLinearPrompt } from "../adapters/linear-prompt";
import { DEMO_ISSUES, DEMO_TEAMS } from "./seed-data";

/**
 * The statuses this demo tracker offers.
 *
 * Deliberately long, and deliberately longer than the set the demo's issues
 * actually sit in. The workflow screen's whole argument is that a real tracker
 * accumulates statuses named for other people's processes — QA sign-off,
 * release approval, escalation paths — and that you shouldn't have to think in
 * all of them. A demo offering five tidy statuses quietly refutes that: there is
 * nothing to collapse, so the feature looks like ceremony.
 *
 * Several of these intentionally map to no stage, so the screen has real
 * unmapped rows to show rather than a table where everything is already tidy.
 */
const AVAILABLE_STATUSES = [
  "Backlog",
  "Triaged",
  "Todo",
  "Ready for Development",
  "In Progress",
  "Reopened",
  "Blocked",
  "In Review",
  "In Code Review",
  "Awaiting QA Sign-off",
  "Failed QA",
  "Customer Escalation",
  "Pending Release Approval",
  "Ready to Deploy",
  "Released",
  "Done",
  "On Hold",
  "Won't Do",
  "Duplicate",
];

// Category per demo state, so demo mode exercises the same stateType-based
// stage fallback the real adapters do.
const DEMO_STATE_TYPES: Record<string, IssueStateType> = {
  Backlog: "backlog",
  Triaged: "backlog",
  "On Hold": "backlog",
  Todo: "unstarted",
  "Ready for Development": "unstarted",
  "In Progress": "started",
  Reopened: "started",
  Blocked: "started",
  "In Review": "started",
  "In Code Review": "started",
  "Awaiting QA Sign-off": "started",
  "Failed QA": "started",
  "Customer Escalation": "started",
  "Pending Release Approval": "started",
  "Ready to Deploy": "started",
  Released: "completed",
  Done: "completed",
  "Won't Do": "canceled",
  Duplicate: "canceled",
};

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
      // Stamp the category here, not in the seed data, so every path out of this
      // adapter carries it and the one table above stays the only place demo
      // statuses are classified. Without it every demo issue falls through
      // `stageFromStateType`'s default to "active" — which reads as a *correct*
      // demo right up until something keys off `done`, as the sidebar's ghost
      // rows do, and then a completed issue shows as unstarted work forever.
      const copy = {
        ...issue,
        stateType: issue.stateType ?? DEMO_STATE_TYPES[issue.status],
        linkedMrUrls: [...issue.linkedMrUrls],
      };
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

  async listWorkflowStates(): Promise<WorkflowState[]> {
    return AVAILABLE_STATUSES.map((name, i) => ({
      id: `demo-state-${i}`,
      name,
      type: DEMO_STATE_TYPES[name] ?? "unstarted",
      team: "Demo",
    }));
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
