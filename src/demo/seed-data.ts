import type { MergeRequest, Issue, PipelineStatus } from "../adapters/types";

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export const DEMO_TEAMS: Array<{ id: string; name: string }> = [
  { id: "team-platform", name: "Platform" },
  { id: "team-dashboard", name: "Dashboard" },
  { id: "team-infra", name: "Infrastructure" },
];

// ---------------------------------------------------------------------------
// Session definitions
// ---------------------------------------------------------------------------

export interface DemoSessionDef {
  name: string;
  group: string;
  project: string;
  branch: string;
  remote: string;
  attention: boolean;
}

export const DEMO_SESSIONS: DemoSessionDef[] = [
  {
    name: "auth-refactor",
    group: "acme-platform",
    project: "platform",
    branch: "feat/eng-1234-auth-refactor",
    remote: "git@gitlab.com:acme/platform.git",
    attention: true,
  },
  {
    name: "api-pagination",
    group: "acme-platform",
    project: "platform",
    branch: "feat/eng-1241-cursor-pagination",
    remote: "git@gitlab.com:acme/platform.git",
    attention: false,
  },
  {
    name: "hotfix-login",
    group: "acme-platform",
    project: "platform",
    branch: "fix/eng-1248-login-timeout",
    remote: "git@gitlab.com:acme/platform.git",
    attention: false,
  },
  {
    name: "data-export",
    group: "acme-platform",
    project: "platform",
    branch: "feat/eng-1252-data-export",
    remote: "git@gitlab.com:acme/platform.git",
    attention: false,
  },
  {
    name: "user-settings",
    group: "acme-dashboard",
    project: "dashboard",
    branch: "feat/dash-301-settings-redesign",
    remote: "git@gitlab.com:acme/dashboard.git",
    attention: false,
  },
  {
    name: "chart-perf",
    group: "acme-dashboard",
    project: "dashboard",
    branch: "perf/dash-315-chart-rendering",
    remote: "git@gitlab.com:acme/dashboard.git",
    attention: false,
  },
  {
    name: "onboarding-flow",
    group: "acme-dashboard",
    project: "dashboard",
    branch: "feat/dash-320-onboarding-wizard",
    remote: "git@gitlab.com:acme/dashboard.git",
    attention: true,
  },
  {
    name: "terraform-modules",
    group: "acme-infra",
    project: "infra",
    branch: "refactor/ops-42-tf-modules",
    remote: "git@gitlab.com:acme/infra.git",
    attention: false,
  },
  {
    name: "ci-pipeline",
    group: "acme-infra",
    project: "infra",
    branch: "feat/ops-51-ci-speed",
    remote: "git@gitlab.com:acme/infra.git",
    attention: false,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a GitLab MR ID in the format the GitLab adapter's parseMrUrl produces. */
function mrId(project: string, number: number): string {
  return `acme%2F${project}:${number}`;
}

/** Canonical GitLab MR web URL. */
function mrUrl(project: string, number: number): string {
  return `https://gitlab.com/acme/${project}/-/merge_requests/${number}`;
}

/** Canonical Linear issue web URL. */
function issueUrl(identifier: string): string {
  return `https://linear.app/acme/issue/${identifier}`;
}

function pipeline(
  state: PipelineStatus["state"],
  project: string,
  number: number,
): PipelineStatus {
  return {
    state,
    webUrl: `${mrUrl(project, number)}/pipelines`,
  };
}

// ---------------------------------------------------------------------------
// Merge Requests (9)
// ---------------------------------------------------------------------------

export const DEMO_MRS: MergeRequest[] = [
  {
    id: mrId("platform", 101),
    title: "Refactor auth middleware",
    status: "open",
    sourceBranch: "feat/eng-1234-auth-refactor",
    targetBranch: "main",
    pipeline: pipeline("running", "platform", 101),
    approvals: { required: 2, current: 0 },
    webUrl: mrUrl("platform", 101),
    author: "Jarred Kenny",
    reviewers: ["alice"],
    updatedAt: Date.now() - 1000 * 60 * 15, // 15 min ago
  },
  {
    id: mrId("platform", 102),
    title: "Cursor pagination for list endpoints",
    status: "open",
    sourceBranch: "feat/eng-1241-cursor-pagination",
    targetBranch: "main",
    pipeline: pipeline("passed", "platform", 102),
    approvals: { required: 2, current: 1 },
    webUrl: mrUrl("platform", 102),
    author: "Jarred Kenny",
    reviewers: ["bob"],
    updatedAt: Date.now() - 1000 * 60 * 45,
  },
  {
    id: mrId("platform", 103),
    title: "Fix login timeout handling",
    status: "draft",
    sourceBranch: "fix/eng-1248-login-timeout",
    targetBranch: "main",
    pipeline: pipeline("failed", "platform", 103),
    approvals: { required: 1, current: 0 },
    webUrl: mrUrl("platform", 103),
    author: "Jarred Kenny",
    reviewers: [],
    updatedAt: Date.now() - 1000 * 60 * 5,
  },
  {
    id: mrId("platform", 104),
    title: "Data export: CSV + JSON formats",
    status: "open",
    sourceBranch: "feat/eng-1252-data-export",
    targetBranch: "main",
    pipeline: pipeline("pending", "platform", 104),
    approvals: { required: 2, current: 0 },
    webUrl: mrUrl("platform", 104),
    author: "Jarred Kenny",
    reviewers: ["alice", "carol"],
    updatedAt: Date.now() - 1000 * 60 * 90,
  },
  {
    id: mrId("dashboard", 201),
    title: "Settings page redesign",
    status: "open",
    sourceBranch: "feat/dash-301-settings-redesign",
    targetBranch: "main",
    pipeline: pipeline("passed", "dashboard", 201),
    approvals: { required: 2, current: 2 },
    webUrl: mrUrl("dashboard", 201),
    author: "Jarred Kenny",
    reviewers: ["dave"],
    updatedAt: Date.now() - 1000 * 60 * 30,
  },
  {
    id: mrId("dashboard", 202),
    title: "Chart rendering: virtualize large datasets",
    status: "open",
    sourceBranch: "perf/dash-315-chart-rendering",
    targetBranch: "main",
    pipeline: pipeline("running", "dashboard", 202),
    approvals: { required: 2, current: 1 },
    webUrl: mrUrl("dashboard", 202),
    author: "Jarred Kenny",
    reviewers: ["bob"],
    updatedAt: Date.now() - 1000 * 60 * 10,
  },
  {
    id: mrId("dashboard", 203),
    title: "Onboarding wizard v1",
    status: "draft",
    sourceBranch: "feat/dash-320-onboarding-wizard",
    targetBranch: "main",
    pipeline: pipeline("passed", "dashboard", 203),
    approvals: { required: 1, current: 0 },
    webUrl: mrUrl("dashboard", 203),
    author: "Jarred Kenny",
    reviewers: [],
    updatedAt: Date.now() - 1000 * 60 * 60 * 2,
  },
  {
    id: mrId("infra", 301),
    title: "Restructure TF modules",
    status: "open",
    sourceBranch: "refactor/ops-42-tf-modules",
    targetBranch: "main",
    pipeline: pipeline("canceled", "infra", 301),
    approvals: { required: 1, current: 0 },
    webUrl: mrUrl("infra", 301),
    author: "Jarred Kenny",
    reviewers: ["eve"],
    updatedAt: Date.now() - 1000 * 60 * 60 * 5,
  },
  {
    id: mrId("infra", 302),
    title: "Parallelize CI stages",
    status: "merged",
    sourceBranch: "feat/ops-51-ci-speed",
    targetBranch: "main",
    pipeline: pipeline("passed", "infra", 302),
    approvals: { required: 2, current: 2 },
    webUrl: mrUrl("infra", 302),
    author: "Jarred Kenny",
    reviewers: ["alice"],
    updatedAt: Date.now() - 1000 * 60 * 60 * 24,
  },
];

// ---------------------------------------------------------------------------
// Issues (16)
// ---------------------------------------------------------------------------

export const DEMO_ISSUES: Issue[] = [
  {
    id: "issue-1234",
    identifier: "ENG-1234",
    title: "Refactor auth middleware for SSO support",
    status: "In Progress",
    assignee: "Jarred Kenny",
    team: "Platform",
    priority: 2,
    branchName: "feat/eng-1234-auth-refactor",
    linkedMrUrls: [mrUrl("platform", 101)],
    webUrl: issueUrl("ENG-1234"),
    updatedAt: Date.now() - 1000 * 60 * 20,
    description:
      "The current auth middleware doesn't support SSO providers. " +
      "We need to refactor `middleware/auth.ts` to accept pluggable identity providers, " +
      "starting with SAML and OIDC. The session token format will need to be versioned to " +
      "support both old and new flows during rollout.",
    comments: [
      {
        author: "alice",
        body: "The OIDC discovery endpoint should be cached — it's hit on every request right now.",
        createdAt: "2026-04-10T14:22:00Z",
      },
      {
        author: "Jarred Kenny",
        body: "Good catch. I'll add a 5-minute TTL cache keyed by issuer URL.",
        createdAt: "2026-04-10T15:08:00Z",
      },
    ],
  },
  {
    id: "issue-1237",
    identifier: "ENG-1237",
    title: "Rate limiting on public API endpoints",
    status: "Todo",
    assignee: "Jarred Kenny",
    team: "Platform",
    priority: 2,
    branchName: undefined,
    linkedMrUrls: [],
    webUrl: issueUrl("ENG-1237"),
    updatedAt: Date.now() - 1000 * 60 * 60 * 48,
  },
  {
    id: "issue-1241",
    identifier: "ENG-1241",
    title: "Cursor-based pagination for list endpoints",
    status: "In Review",
    assignee: "Jarred Kenny",
    team: "Platform",
    priority: 3,
    branchName: "feat/eng-1241-cursor-pagination",
    linkedMrUrls: [mrUrl("platform", 102)],
    webUrl: issueUrl("ENG-1241"),
    updatedAt: Date.now() - 1000 * 60 * 50,
  },
  {
    id: "issue-1245",
    identifier: "ENG-1245",
    title: "Deprecate v1 webhook format",
    status: "Backlog",
    assignee: "Jarred Kenny",
    team: "Platform",
    priority: 4,
    branchName: undefined,
    linkedMrUrls: [],
    webUrl: issueUrl("ENG-1245"),
    updatedAt: Date.now() - 1000 * 60 * 60 * 72,
  },
  {
    id: "issue-1248",
    identifier: "ENG-1248",
    title: "Login timeout on slow connections",
    status: "In Progress",
    assignee: "Jarred Kenny",
    team: "Platform",
    priority: 1,
    branchName: "fix/eng-1248-login-timeout",
    linkedMrUrls: [mrUrl("platform", 103)],
    webUrl: issueUrl("ENG-1248"),
    updatedAt: Date.now() - 1000 * 60 * 8,
    description:
      "Users on high-latency connections (>500ms RTT) intermittently hit a 10-second " +
      "timeout before the login form responds. Root cause traced to a synchronous DNS " +
      "lookup in `auth/session.ts:initSession()`. Fix: make the lookup async and add " +
      "a configurable timeout with sensible default (30s).",
  },
  {
    id: "issue-1252",
    identifier: "ENG-1252",
    title: "CSV/JSON data export",
    status: "In Progress",
    assignee: "Jarred Kenny",
    team: "Platform",
    priority: 3,
    branchName: "feat/eng-1252-data-export",
    linkedMrUrls: [mrUrl("platform", 104)],
    webUrl: issueUrl("ENG-1252"),
    updatedAt: Date.now() - 1000 * 60 * 95,
  },
  {
    id: "issue-1255",
    identifier: "ENG-1255",
    title: "Add audit log for admin actions",
    status: "Todo",
    assignee: "Jarred Kenny",
    team: "Platform",
    priority: 3,
    branchName: undefined,
    linkedMrUrls: [],
    webUrl: issueUrl("ENG-1255"),
    updatedAt: Date.now() - 1000 * 60 * 60 * 36,
  },
  {
    id: "issue-301",
    identifier: "DASH-301",
    title: "Settings page redesign",
    status: "In Progress",
    assignee: "Jarred Kenny",
    team: "Dashboard",
    priority: 2,
    branchName: "feat/dash-301-settings-redesign",
    linkedMrUrls: [mrUrl("dashboard", 201)],
    webUrl: issueUrl("DASH-301"),
    updatedAt: Date.now() - 1000 * 60 * 35,
  },
  {
    id: "issue-308",
    identifier: "DASH-308",
    title: "Dark mode color tokens",
    status: "Todo",
    assignee: "Jarred Kenny",
    team: "Dashboard",
    priority: 3,
    branchName: undefined,
    linkedMrUrls: [],
    webUrl: issueUrl("DASH-308"),
    updatedAt: Date.now() - 1000 * 60 * 60 * 24,
  },
  {
    id: "issue-315",
    identifier: "DASH-315",
    title: "Chart rendering drops frames at 10k+ points",
    status: "In Review",
    assignee: "Jarred Kenny",
    team: "Dashboard",
    priority: 2,
    branchName: "perf/dash-315-chart-rendering",
    linkedMrUrls: [mrUrl("dashboard", 202)],
    webUrl: issueUrl("DASH-315"),
    updatedAt: Date.now() - 1000 * 60 * 12,
  },
  {
    id: "issue-320",
    identifier: "DASH-320",
    title: "New user onboarding wizard",
    status: "In Progress",
    assignee: "Jarred Kenny",
    team: "Dashboard",
    priority: 3,
    branchName: "feat/dash-320-onboarding-wizard",
    linkedMrUrls: [mrUrl("dashboard", 203)],
    webUrl: issueUrl("DASH-320"),
    updatedAt: Date.now() - 1000 * 60 * 60 * 2,
  },
  {
    id: "issue-325",
    identifier: "DASH-325",
    title: "Accessibility audit fixes",
    status: "Backlog",
    assignee: "Jarred Kenny",
    team: "Dashboard",
    priority: 4,
    branchName: undefined,
    linkedMrUrls: [],
    webUrl: issueUrl("DASH-325"),
    updatedAt: Date.now() - 1000 * 60 * 60 * 96,
  },
  {
    id: "issue-330",
    identifier: "DASH-330",
    title: "Dashboard loading skeleton",
    status: "Todo",
    assignee: "Jarred Kenny",
    team: "Dashboard",
    priority: 4,
    branchName: undefined,
    linkedMrUrls: [],
    webUrl: issueUrl("DASH-330"),
    updatedAt: Date.now() - 1000 * 60 * 60 * 48,
  },
  {
    id: "issue-42",
    identifier: "OPS-42",
    title: "Restructure Terraform modules",
    status: "In Progress",
    assignee: "Jarred Kenny",
    team: "Infrastructure",
    priority: 3,
    branchName: "refactor/ops-42-tf-modules",
    linkedMrUrls: [mrUrl("infra", 301)],
    webUrl: issueUrl("OPS-42"),
    updatedAt: Date.now() - 1000 * 60 * 60 * 6,
  },
  {
    id: "issue-48",
    identifier: "OPS-48",
    title: "Flaky integration test quarantine",
    status: "Done",
    assignee: "Jarred Kenny",
    team: "Infrastructure",
    priority: 2,
    branchName: undefined,
    linkedMrUrls: [],
    webUrl: issueUrl("OPS-48"),
    updatedAt: Date.now() - 1000 * 60 * 60 * 30,
  },
  {
    id: "issue-51",
    identifier: "OPS-51",
    title: "CI pipeline parallelization",
    status: "In Progress",
    assignee: "Jarred Kenny",
    team: "Infrastructure",
    priority: 2,
    branchName: "feat/ops-51-ci-speed",
    linkedMrUrls: [mrUrl("infra", 302)],
    webUrl: issueUrl("OPS-51"),
    updatedAt: Date.now() - 1000 * 60 * 60 * 25,
  },
];

// ---------------------------------------------------------------------------
// Review MR IDs — MRs where I'm a reviewer ("awaiting my review")
// ---------------------------------------------------------------------------

export const DEMO_REVIEW_MR_IDS: Set<string> = new Set([
  mrId("dashboard", 201), // Settings page redesign
  mrId("dashboard", 202), // Chart rendering
]);

// ---------------------------------------------------------------------------
// Manual session-to-issue links for state.json seeding
// ---------------------------------------------------------------------------

export const DEMO_MANUAL_LINKS: Array<{ session: string; issueId: string }> = [
  { session: "auth-refactor", issueId: "issue-1237" },
  { session: "ci-pipeline", issueId: "issue-48" },
];
