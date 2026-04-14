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
    description:
      "Our public API has no rate limiting. We've seen a few customers accidentally " +
      "DDoS themselves with tight retry loops. Need per-key sliding window limits " +
      "(100 req/min default) on all /v2/ endpoints, with a 429 response and Retry-After header.",
    comments: [
      {
        author: "bob",
        body: "Should we also add a global per-IP fallback for unauthenticated endpoints?",
        createdAt: "2026-04-08T09:15:00Z",
      },
    ],
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
    description:
      "Replace offset-based pagination with cursor-based on all list endpoints. " +
      "Current offset pagination breaks when items are inserted/deleted between pages. " +
      "Use the existing `id` column as cursor since it's monotonically increasing. " +
      "The response shape changes from `{ items, total, page }` to `{ items, nextCursor, hasMore }`.",
    comments: [
      {
        author: "bob",
        body: "MR is up. I kept backward compat — offset params still work but emit a deprecation warning.",
        createdAt: "2026-04-11T16:40:00Z",
      },
      {
        author: "alice",
        body: "Looks good. One thing: the cursor should be opaque (base64-encoded) so clients don't try to construct them.",
        createdAt: "2026-04-12T09:05:00Z",
      },
    ],
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
    description:
      "The v1 webhook payload uses flat keys (`event_type`, `user_id`) while v2 uses " +
      "nested objects (`event.type`, `user.id`). ~30% of integrations still use v1. " +
      "Plan: add deprecation header to v1 responses, email affected API key owners, " +
      "sunset in 90 days.",
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
    comments: [
      {
        author: "alice",
        body: "Reproduced on staging with tc netem. The sync lookup blocks the event loop for 8-12 seconds on 600ms RTT.",
        createdAt: "2026-04-12T14:00:00Z",
      },
    ],
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
    description:
      "Users need to export their data in CSV and JSON formats. The export should be " +
      "async (queued job) for datasets over 10k rows, with a download link emailed when " +
      "complete. Smaller exports can stream directly. Need to respect field-level permissions " +
      "so exports don't leak columns the user shouldn't see.",
    comments: [
      {
        author: "carol",
        body: "Can we use the existing job queue or do we need a dedicated export worker?",
        createdAt: "2026-04-09T11:30:00Z",
      },
      {
        author: "Jarred Kenny",
        body: "Existing queue is fine — exports are IO-bound, not CPU-bound. I'll add a new job type.",
        createdAt: "2026-04-09T13:15:00Z",
      },
    ],
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
    description:
      "Compliance requires an immutable audit trail for all admin actions: user creation/deletion, " +
      "role changes, API key management, billing changes. Log to a dedicated append-only table with " +
      "actor, action, target, timestamp, and a JSON diff of the change. Retention: 2 years.",
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
    description:
      "The settings page is a single scrollable form with 40+ fields. Redesign into " +
      "tabbed sections: Profile, Notifications, Security, Integrations, Billing. " +
      "Each tab loads independently. Add search to quickly find a setting. " +
      "Mobile layout collapses tabs into an accordion.",
    comments: [
      {
        author: "dave",
        body: "Figma mockups are ready. I put the link in the issue attachments.",
        createdAt: "2026-04-07T10:00:00Z",
      },
      {
        author: "Jarred Kenny",
        body: "These look great. Starting with Profile + Security tabs, then the rest in a follow-up.",
        createdAt: "2026-04-07T14:20:00Z",
      },
    ],
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
    description:
      "Define a semantic color token system (background-primary, text-muted, border-subtle, etc.) " +
      "that maps to different palettes for light/dark mode. Currently we have ~200 raw hex values " +
      "scattered across components. The token layer lets us swap themes without touching components.",
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
    description:
      "The analytics charts drop to <15fps when rendering datasets with 10k+ data points. " +
      "Profiling shows the bottleneck is in the SVG path recalculation on every frame. " +
      "Fix: virtualize the visible viewport (only render points in the current zoom window) " +
      "and use canvas for the minimap overview.",
    comments: [
      {
        author: "bob",
        body: "After switching to canvas for the minimap, the 50k-point dataset renders at 60fps. The SVG detail view still uses path simplification for zoom levels showing >2k points.",
        createdAt: "2026-04-12T11:00:00Z",
      },
    ],
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
    description:
      "New users drop off during the first 5 minutes. Build a 4-step onboarding wizard: " +
      "1) workspace name, 2) invite teammates, 3) connect first integration, 4) create first project. " +
      "Each step should be skippable. Progress persists across sessions. " +
      "Show a completion checklist in the sidebar until all steps are done.",
    comments: [
      {
        author: "Jarred Kenny",
        body: "Draft MR is up with steps 1-2. The integration step needs the new OAuth flow from ENG-1234 to land first.",
        createdAt: "2026-04-11T18:30:00Z",
      },
    ],
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
    description:
      "External a11y audit found 23 issues. Top items: missing alt text on chart images, " +
      "color contrast below 4.5:1 on secondary text, keyboard navigation broken in modal dialogs, " +
      "data tables missing header associations. Full report linked in attachments.",
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
    description:
      "Replace the spinner on initial dashboard load with skeleton screens that match the " +
      "final layout. Each widget should have its own skeleton so they can fill in independently " +
      "as data arrives. Reduces perceived load time and eliminates layout shift.",
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
    description:
      "Our Terraform root module is 1200 lines with everything inlined. Split into reusable " +
      "child modules: networking, compute, database, monitoring. Each module gets its own " +
      "variables.tf/outputs.tf and can be versioned independently via git tags. " +
      "Migrate one environment at a time — staging first, then production.",
    comments: [
      {
        author: "eve",
        body: "Staging is migrated and plan shows no diff. Ready for prod whenever you are.",
        createdAt: "2026-04-12T08:45:00Z",
      },
    ],
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
    description:
      "12 integration tests fail intermittently (~5% of runs) due to timing issues with " +
      "the test database. Moved them to a quarantine suite that runs nightly instead of on " +
      "every push. Filed individual tickets for each flaky test. CI pass rate went from 87% to 99%.",
    comments: [
      {
        author: "alice",
        body: "The quarantine is working well. 4 of the 12 are now fixed and moved back to the main suite.",
        createdAt: "2026-04-10T16:00:00Z",
      },
    ],
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
    description:
      "CI takes 18 minutes end-to-end. Lint, unit tests, and integration tests run sequentially " +
      "but have no dependencies on each other. Parallelize into 3 jobs. Also cache node_modules " +
      "and the TypeScript build between runs. Target: under 7 minutes.",
    comments: [
      {
        author: "Jarred Kenny",
        body: "Parallelization landed and merged. Down to 8 minutes. The remaining gap is the Docker build step — investigating layer caching next.",
        createdAt: "2026-04-11T20:15:00Z",
      },
      {
        author: "eve",
        body: "Nice. The Docker layer cache should shave another 2-3 minutes easily.",
        createdAt: "2026-04-12T09:30:00Z",
      },
    ],
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
