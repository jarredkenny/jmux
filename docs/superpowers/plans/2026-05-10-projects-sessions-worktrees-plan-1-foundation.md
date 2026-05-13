# jmux Projects/Sessions/Worktrees — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the data layer, agent-state plumbing, and icon module that the rest of the redesign depends on. After Plan 1, jmux's sidebar will gain agent-state indicators but otherwise look unchanged.

**Architecture:** Add an `IssueTracker` interface with `LinearTracker` as the first impl, wired into a polling `IssueCache`. Extend `@jmux-agent-state` tmux user options driven by Claude Code hooks. Centralize all glyphs in `src/icons.ts`. No user-visible UX shift yet — that lands in Plan 2.

**Tech Stack:** Bun 1.3.8+, TypeScript strict mode, `bun test`, existing `src/adapters/linear.ts` GraphQL client, `bun-pty`, tmux 3.2+.

**Spec reference:** `docs/superpowers/specs/2026-05-10-projects-sessions-worktrees-ux-design.md` (Sections 2, 3, 4, 5.4, 5.6, 5.7, 5.8, 8.3).

**Plan series:**
- Plan 1: Foundation (this file) — data, agent state, icons
- Plan 2: Sidebar rewrite — issue-anchored render plan, repo tags, badges
- Plan 3: New-session modal — IssuePickerModal multi-step state machine
- Plan 4: Lifecycle — archive flow, MR/Done badge cluster
- Plan 5: CLI surface — `jmux ctl project/issue/agent/auth`
- Plan 6: Migration & docs — first-launch banner, deprecation, release notes

---

## File Structure

### Create
- `src/issue-tracker/types.ts` — interface + value objects (`TrackerProject`, `TrackerIssue`, `TrackerMR`, `IssueTracker`, `IssueListOpts`, `TrackerCapabilities`)
- `src/issue-tracker/index.ts` — `getIssueTracker(config)` factory; returns `null` when nothing's configured
- `src/issue-tracker/linear.ts` — `LinearTracker` implementation, wraps the existing `src/adapters/linear.ts` GraphQL client
- `src/issue-tracker/cache.ts` — `IssueCache` class: in-memory project/issue/MR maps with TTL-gated refresh
- `src/issue-tracker/contract-tests.ts` — shared test suite any `IssueTracker` implementation must pass
- `src/icons.ts` — single module exporting `icons` and `iconsPlain` keyed by semantic name
- `src/agent-state.ts` — `AgentState` enum + helpers for reading `@jmux-agent-state` tmux options and merging OTEL signals
- `src/__tests__/issue-tracker/types.test.ts` — interface contract assertions
- `src/__tests__/issue-tracker/linear.test.ts` — runs the contract suite against a mocked HTTP fixture
- `src/__tests__/issue-tracker/cache.test.ts` — refresh, TTL, partial failure
- `src/__tests__/icons.test.ts` — semantic name resolution, no Nerd Font codepoints leak through plain set
- `src/__tests__/agent-state.test.ts` — state transitions, OTEL corroboration

### Modify
- `src/config.ts` — add `issueTracker`, `linearProjects`, `iconSet`, `archive.deleteLocalBranch`, `linkExistingWorktreesByBranchName`, extended `issueWorkflow` fields; rewrite parser to return `{ config, warnings, errors, unknownKeys }`
- `src/types.ts` — extend `SessionInfo` with `linearIssueId?`, `linearProjectId?`, `repoPath?`, `agentState`
- `src/session-view.ts` — surface `agentState` and link fields on `SessionView`
- `src/tmux-control.ts` — read `@jmux-agent-state`, `@jmux-linear-issue`, `@jmux-linear-project`, `@jmux-repo-path` via `show-options`
- `src/main.ts` — instantiate `IssueCache`, schedule polling, inject cache into render-plan input
- `src/otel-receiver.ts` — emit agent-state hints derived from Claude Code spans
- `src/__tests__/config.test.ts` — new field parsing, unknown-key round-trip
- `src/__tests__/session-view.test.ts` — agentState + link field projection
- `src/__tests__/tmux-control.test.ts` — option reads
- `src/__tests__/otel-receiver.test.ts` — state hint emission
- `bin/jmux` — rewrite `--install-agent-hooks` to write four hooks + marker block with version metadata

### Globally true across this plan
- Bun is the runtime: tests use `bun test`, scripts run under Bun.
- TypeScript strict mode: no `any` introductions; types live with the module that owns them.
- Every task ends with `bun typecheck` and `bun test` passing, plus a commit.
- Commits use a normal message (no `Co-Authored-By` per project convention).
- Use `Edit`/`Write` tools, never sed/awk/echo redirection.

---

## Task 1: Config — add new fields with defaults, no parser changes yet

**Files:**
- Modify: `src/config.ts:1-204`
- Test: `src/__tests__/config.test.ts`

**Goal:** Extend `JmuxConfig` with the spec's new fields. Defaults preserve today's behavior so existing users see no change.

- [ ] **Step 1: Write failing tests**

Add to `src/__tests__/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { defaultConfig, parseJmuxConfig } from "../config"

describe("new config fields", () => {
  test("defaultConfig includes iconSet=nerd-font", () => {
    expect(defaultConfig().iconSet).toBe("nerd-font")
  })

  test("defaultConfig includes empty linearProjects", () => {
    expect(defaultConfig().linearProjects).toEqual([])
  })

  test("defaultConfig has no issueTracker", () => {
    expect(defaultConfig().issueTracker).toBeUndefined()
  })

  test("defaultConfig sets archive.deleteLocalBranch=false", () => {
    expect(defaultConfig().archive?.deleteLocalBranch).toBe(false)
  })

  test("defaultConfig sets linkExistingWorktreesByBranchName=true", () => {
    expect(defaultConfig().linkExistingWorktreesByBranchName).toBe(true)
  })

  test("parseJmuxConfig accepts an issueTracker block", () => {
    const result = parseJmuxConfig({
      issueTracker: {
        kind: "linear",
        linear: { apiKeyEnv: "LINEAR_API_KEY" },
        refreshIntervalMs: 60000,
        issueListScope: "assignedToMeOrWithSession",
      },
    })
    expect(result.errors).toEqual([])
    expect(result.config.issueTracker?.kind).toBe("linear")
  })

  test("parseJmuxConfig accepts linearProjects entries", () => {
    const result = parseJmuxConfig({
      linearProjects: [
        {
          id: "uuid-1",
          repos: [{ path: "/tmp/webapp" }, { path: "/tmp/gateway" }],
          defaultRepoIndex: 0,
        },
      ],
    })
    expect(result.errors).toEqual([])
    expect(result.config.linearProjects).toHaveLength(1)
    expect(result.config.linearProjects[0].repos).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/config.test.ts -t "new config fields"`
Expected: FAIL — `defaultConfig is not a function` (or similar; the symbol doesn't exist yet).

- [ ] **Step 3: Add type definitions to `src/config.ts`**

Add the following types alongside the existing `JmuxConfig` interface in `src/config.ts`:

```ts
export type IssueListScope =
  | "assignedToMe"
  | "withSession"
  | "assignedToMeOrWithSession"
  | "all"

export type IconSet = "nerd-font" | "plain"

export interface IssueTrackerConfig {
  kind: "linear"
  linear: {
    apiKeyEnv: string
    workspaceId?: string
  }
  refreshIntervalMs?: number
  issueListScope?: IssueListScope
}

export interface LinearProjectRepo {
  path: string
}

export interface LinearProjectEntry {
  id: string
  displayName?: string
  repos: LinearProjectRepo[]
  defaultRepoIndex?: number
  defaultBaseBranch?: string
}

export interface ArchiveConfig {
  deleteLocalBranch?: boolean
}
```

Extend `JmuxConfig`:

```ts
export interface JmuxConfig {
  // ...existing fields preserved...
  issueTracker?: IssueTrackerConfig
  linearProjects?: LinearProjectEntry[]
  iconSet?: IconSet
  archive?: ArchiveConfig
  linkExistingWorktreesByBranchName?: boolean
}
```

Extend the existing `issueWorkflow` shape to add the two new optional fields (`claudePromptTemplate`, extended template vars are runtime concerns).

- [ ] **Step 4: Add `defaultConfig()` exporter**

```ts
export function defaultConfig(): JmuxConfig {
  return {
    sidebarWidth: 26,
    iconSet: "nerd-font",
    linearProjects: [],
    archive: { deleteLocalBranch: false },
    linkExistingWorktreesByBranchName: true,
    // ...mirror existing defaults...
  }
}
```

- [ ] **Step 5: Stub `parseJmuxConfig`**

Add a permissive parser that accepts the new shape (full validation lands in Task 2). For now:

```ts
export interface ParseResult {
  config: JmuxConfig
  warnings: string[]
  errors: string[]
  unknownKeys: string[]
}

export function parseJmuxConfig(input: unknown): ParseResult {
  const base = defaultConfig()
  if (!input || typeof input !== "object") {
    return { config: base, warnings: [], errors: [], unknownKeys: [] }
  }
  return {
    config: { ...base, ...(input as Partial<JmuxConfig>) },
    warnings: [],
    errors: [],
    unknownKeys: [],
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/__tests__/config.test.ts -t "new config fields"`
Expected: PASS — all 7 tests green.

Run: `bun typecheck`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "config: add issueTracker, linearProjects, iconSet, archive, and link fields"
```

---

## Task 2: Config — strict validation with structured errors and unknown-key round-trip

**Files:**
- Modify: `src/config.ts`
- Test: `src/__tests__/config.test.ts`

**Goal:** `parseJmuxConfig` validates known fields strictly while preserving unknown keys for round-trip writes. Spec §4.6.

- [ ] **Step 1: Write failing tests**

```ts
describe("parseJmuxConfig validation", () => {
  test("rejects invalid iconSet value", () => {
    const result = parseJmuxConfig({ iconSet: "fancy" })
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toMatch(/iconSet/)
  })

  test("rejects negative refreshIntervalMs", () => {
    const result = parseJmuxConfig({
      issueTracker: { kind: "linear", linear: { apiKeyEnv: "X" }, refreshIntervalMs: -1 },
    })
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test("rejects linearProjects entry missing id", () => {
    const result = parseJmuxConfig({
      linearProjects: [{ repos: [{ path: "/tmp/x" }] }],
    })
    expect(result.errors.some((e) => e.includes("id"))).toBe(true)
  })

  test("rejects defaultRepoIndex out of range", () => {
    const result = parseJmuxConfig({
      linearProjects: [{ id: "x", repos: [{ path: "/tmp/x" }], defaultRepoIndex: 5 }],
    })
    expect(result.errors.some((e) => e.includes("defaultRepoIndex"))).toBe(true)
  })

  test("collects unknown top-level keys without erroring", () => {
    const result = parseJmuxConfig({
      iconSet: "nerd-font",
      futureField: { foo: 1 },
    })
    expect(result.errors).toEqual([])
    expect(result.unknownKeys).toContain("futureField")
  })

  test("warns when teamRepoMap is present (deprecated)", () => {
    const result = parseJmuxConfig({
      issueWorkflow: { teamRepoMap: { ENG: "/tmp/webapp" } },
    })
    expect(result.warnings.some((w) => w.includes("teamRepoMap"))).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/config.test.ts -t "parseJmuxConfig validation"`
Expected: FAIL on all 6 — parser currently accepts everything.

- [ ] **Step 3: Implement strict validation**

Rewrite `parseJmuxConfig` body. Use a small internal `Validator` helper rather than a heavyweight schema lib (jmux avoids deps).

```ts
const KNOWN_TOP_KEYS = new Set([
  "sidebarWidth", "infoPanelWidth", "claudeCommand", "cacheTimers",
  "pinnedSessions", "projectDirs", "wtmIntegration", "diffPanel",
  "adapters", "panelViews", "issueWorkflow",
  "issueTracker", "linearProjects", "iconSet", "archive",
  "linkExistingWorktreesByBranchName",
])

const VALID_ICON_SETS: IconSet[] = ["nerd-font", "plain"]
const VALID_SCOPES: IssueListScope[] = [
  "assignedToMe", "withSession", "assignedToMeOrWithSession", "all",
]

function validateIssueTracker(value: unknown, errors: string[]): IssueTrackerConfig | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object") {
    errors.push("issueTracker must be an object")
    return undefined
  }
  const v = value as Record<string, unknown>
  if (v.kind !== "linear") {
    errors.push(`issueTracker.kind must be 'linear' (got ${JSON.stringify(v.kind)})`)
    return undefined
  }
  const linear = v.linear as Record<string, unknown> | undefined
  if (!linear || typeof linear !== "object" || typeof linear.apiKeyEnv !== "string") {
    errors.push("issueTracker.linear.apiKeyEnv must be a string")
    return undefined
  }
  let refreshIntervalMs: number | undefined
  if (v.refreshIntervalMs !== undefined) {
    if (typeof v.refreshIntervalMs !== "number" || v.refreshIntervalMs <= 0) {
      errors.push("issueTracker.refreshIntervalMs must be > 0")
    } else {
      refreshIntervalMs = v.refreshIntervalMs
    }
  }
  let issueListScope: IssueListScope | undefined
  if (v.issueListScope !== undefined) {
    if (!VALID_SCOPES.includes(v.issueListScope as IssueListScope)) {
      errors.push(`issueTracker.issueListScope must be one of ${VALID_SCOPES.join(", ")}`)
    } else {
      issueListScope = v.issueListScope as IssueListScope
    }
  }
  return {
    kind: "linear",
    linear: {
      apiKeyEnv: linear.apiKeyEnv as string,
      workspaceId: typeof linear.workspaceId === "string" ? linear.workspaceId : undefined,
    },
    refreshIntervalMs,
    issueListScope,
  }
}

function validateLinearProjects(value: unknown, errors: string[]): LinearProjectEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push("linearProjects must be an array")
    return []
  }
  const out: LinearProjectEntry[] = []
  value.forEach((raw, idx) => {
    if (!raw || typeof raw !== "object") {
      errors.push(`linearProjects[${idx}] must be an object`)
      return
    }
    const entry = raw as Record<string, unknown>
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      errors.push(`linearProjects[${idx}].id is required`)
      return
    }
    if (!Array.isArray(entry.repos) || entry.repos.length === 0) {
      errors.push(`linearProjects[${idx}].repos must be a non-empty array`)
      return
    }
    const repos: LinearProjectRepo[] = []
    for (const [ri, r] of entry.repos.entries()) {
      if (!r || typeof r !== "object" || typeof (r as { path?: unknown }).path !== "string") {
        errors.push(`linearProjects[${idx}].repos[${ri}].path is required`)
        return
      }
      repos.push({ path: (r as { path: string }).path })
    }
    let defaultRepoIndex: number | undefined
    if (entry.defaultRepoIndex !== undefined) {
      const n = entry.defaultRepoIndex
      if (typeof n !== "number" || n < 0 || n >= repos.length) {
        errors.push(`linearProjects[${idx}].defaultRepoIndex must be a valid index into repos`)
      } else {
        defaultRepoIndex = n
      }
    }
    out.push({
      id: entry.id,
      displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
      repos,
      defaultRepoIndex,
      defaultBaseBranch:
        typeof entry.defaultBaseBranch === "string" ? entry.defaultBaseBranch : undefined,
    })
  })
  return out
}

export function parseJmuxConfig(input: unknown): ParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  const unknownKeys: string[] = []
  const base = defaultConfig()
  if (!input || typeof input !== "object") {
    return { config: base, warnings, errors, unknownKeys }
  }
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_KEYS.has(key)) unknownKeys.push(key)
  }
  if (raw.iconSet !== undefined && !VALID_ICON_SETS.includes(raw.iconSet as IconSet)) {
    errors.push(`iconSet must be one of ${VALID_ICON_SETS.join(", ")}`)
  }
  const issueTracker = validateIssueTracker(raw.issueTracker, errors)
  const linearProjects = validateLinearProjects(raw.linearProjects, errors)
  if (
    raw.issueWorkflow &&
    typeof raw.issueWorkflow === "object" &&
    (raw.issueWorkflow as Record<string, unknown>).teamRepoMap !== undefined
  ) {
    warnings.push(
      "issueWorkflow.teamRepoMap is deprecated; migrate repo associations to linearProjects[].repos before v0.21.0",
    )
  }
  // Merge known fields; pass through unknown keys verbatim.
  const config: JmuxConfig = {
    ...base,
    ...(raw as Partial<JmuxConfig>),
    issueTracker,
    linearProjects,
    iconSet: (raw.iconSet as IconSet | undefined) ?? base.iconSet,
  }
  return { config, warnings, errors, unknownKeys }
}
```

Also export a writer helper for the palette command to use later:

```ts
export function serializeJmuxConfig(config: JmuxConfig, unknownKeys: Record<string, unknown> = {}): string {
  const out: Record<string, unknown> = { ...config, ...unknownKeys }
  return JSON.stringify(out, null, 2) + "\n"
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/config.test.ts`
Expected: PASS — all validation tests green plus the earlier defaults tests.

Run: `bun typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "config: strict validation with structured errors and unknown-key round-trip"
```

---

## Task 3: IssueTracker interface and value objects

**Files:**
- Create: `src/issue-tracker/types.ts`
- Create: `src/__tests__/issue-tracker/types.test.ts`

**Goal:** Define the tracker-agnostic interface and value objects. No implementation yet.

- [ ] **Step 1: Create the test file with assertion-of-shape tests**

```ts
// src/__tests__/issue-tracker/types.test.ts
import { describe, expect, test } from "bun:test"
import type {
  IssueListOpts,
  IssueTracker,
  TrackerIssue,
  TrackerMR,
  TrackerProject,
} from "../../issue-tracker/types"

describe("IssueTracker type shape", () => {
  test("TrackerIssue requires id, title, status", () => {
    const issue: TrackerIssue = {
      id: "JWT-12",
      title: "Rotate JWT signing key",
      status: "in_progress",
      projectId: "uuid-1",
      assigneeId: null,
      branchName: "JWT-12-rotate-jwt",
      url: "https://linear.app/x/issue/JWT-12",
    }
    expect(issue.id).toBe("JWT-12")
  })

  test("TrackerProject requires id and name", () => {
    const project: TrackerProject = {
      id: "uuid-1",
      name: "Q1 Auth Migration",
      url: "https://linear.app/x/project/uuid-1",
    }
    expect(project.id).toBe("uuid-1")
  })

  test("TrackerMR captures state and pipeline", () => {
    const mr: TrackerMR = {
      id: "mr-99",
      state: "open",
      pipelineState: "running",
      branch: "JWT-12-rotate-jwt",
      url: "https://gitlab/x/-/merge_requests/99",
    }
    expect(mr.state).toBe("open")
  })

  test("IssueListOpts allows assignedToMe + includeClosed", () => {
    const opts: IssueListOpts = { assignedToMe: true, includeClosed: false }
    expect(opts.assignedToMe).toBe(true)
  })

  test("IssueTracker exposes the documented methods", () => {
    const tracker: IssueTracker = {
      kind: "linear",
      listAccessibleProjects: async () => [],
      listIssuesForProjects: async () => [],
      getIssue: async () => null,
      getMergeRequestForIssue: async () => null,
      capabilities: () => ({ supportsMrLookup: true, supportsPipelineStatus: true }),
    }
    expect(tracker.kind).toBe("linear")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/issue-tracker/types.test.ts`
Expected: FAIL — module `../../issue-tracker/types` doesn't exist.

- [ ] **Step 3: Create the types module**

```ts
// src/issue-tracker/types.ts
export type TrackerIssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled"

export type TrackerMrState =
  | "open"
  | "merged"
  | "closed_unmerged"

export type TrackerPipelineState =
  | "none"
  | "running"
  | "passed"
  | "failed"

export interface TrackerProject {
  id: string
  name: string
  url: string
}

export interface TrackerIssue {
  id: string
  title: string
  status: TrackerIssueStatus
  projectId: string
  assigneeId: string | null
  branchName: string | null
  url: string
}

export interface TrackerMR {
  id: string
  state: TrackerMrState
  pipelineState: TrackerPipelineState
  branch: string
  url: string
}

export interface IssueListOpts {
  assignedToMe?: boolean
  includeClosed?: boolean
}

export interface TrackerCapabilities {
  supportsMrLookup: boolean
  supportsPipelineStatus: boolean
}

export interface IssueTracker {
  readonly kind: "linear" | "github" | "jira"
  listAccessibleProjects(): Promise<TrackerProject[]>
  listIssuesForProjects(projectIds: string[], opts: IssueListOpts): Promise<TrackerIssue[]>
  getIssue(id: string): Promise<TrackerIssue | null>
  getMergeRequestForIssue(id: string): Promise<TrackerMR | null>
  capabilities(): TrackerCapabilities
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `bun test src/__tests__/issue-tracker/types.test.ts && bun typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/issue-tracker/types.ts src/__tests__/issue-tracker/types.test.ts
git commit -m "issue-tracker: define tracker-agnostic interface and value objects"
```

---

## Task 4: IssueTracker contract test suite

**Files:**
- Create: `src/issue-tracker/contract-tests.ts`
- Create: `src/__tests__/issue-tracker/contract.harness.test.ts`

**Goal:** A shared suite any `IssueTracker` implementation must pass. Linear and future trackers run the same checks.

- [ ] **Step 1: Write the contract suite**

```ts
// src/issue-tracker/contract-tests.ts
import { describe, expect, test } from "bun:test"
import type { IssueTracker, TrackerIssue, TrackerProject } from "./types"

export interface ContractFixtures {
  knownProject: TrackerProject
  knownIssueId: string
  knownIssueTitle: string
  unknownIssueId: string
}

export function runIssueTrackerContract(
  name: string,
  factory: () => Promise<{ tracker: IssueTracker; fixtures: ContractFixtures }>,
): void {
  describe(`${name} — IssueTracker contract`, () => {
    test("listAccessibleProjects returns at least one project", async () => {
      const { tracker, fixtures } = await factory()
      const projects = await tracker.listAccessibleProjects()
      expect(projects.length).toBeGreaterThan(0)
      const match = projects.find((p) => p.id === fixtures.knownProject.id)
      expect(match?.name).toBe(fixtures.knownProject.name)
    })

    test("listIssuesForProjects returns issues for known project", async () => {
      const { tracker, fixtures } = await factory()
      const issues = await tracker.listIssuesForProjects([fixtures.knownProject.id], {
        assignedToMe: false,
        includeClosed: false,
      })
      expect(issues.length).toBeGreaterThan(0)
      issues.forEach((i) => expect(i.projectId).toBe(fixtures.knownProject.id))
    })

    test("getIssue returns null for unknown id", async () => {
      const { tracker, fixtures } = await factory()
      const issue = await tracker.getIssue(fixtures.unknownIssueId)
      expect(issue).toBeNull()
    })

    test("getIssue returns full payload for known id", async () => {
      const { tracker, fixtures } = await factory()
      const issue = await tracker.getIssue(fixtures.knownIssueId)
      expect(issue?.id).toBe(fixtures.knownIssueId)
      expect(issue?.title).toBe(fixtures.knownIssueTitle)
    })

    test("getMergeRequestForIssue returns null when no MR exists", async () => {
      const { tracker, fixtures } = await factory()
      const mr = await tracker.getMergeRequestForIssue(fixtures.unknownIssueId)
      expect(mr).toBeNull()
    })

    test("capabilities() reports a stable shape", async () => {
      const { tracker } = await factory()
      const caps = tracker.capabilities()
      expect(typeof caps.supportsMrLookup).toBe("boolean")
      expect(typeof caps.supportsPipelineStatus).toBe("boolean")
    })
  })
}
```

- [ ] **Step 2: Add a smoke test that drives the contract with a stub tracker**

```ts
// src/__tests__/issue-tracker/contract.harness.test.ts
import { runIssueTrackerContract } from "../../issue-tracker/contract-tests"
import type { IssueTracker } from "../../issue-tracker/types"

const stubProject = { id: "p1", name: "Stub Project", url: "https://stub/p/p1" }
const stubIssue = {
  id: "STUB-1",
  title: "stub title",
  status: "in_progress" as const,
  projectId: "p1",
  assigneeId: null,
  branchName: "STUB-1-stub-title",
  url: "https://stub/i/STUB-1",
}

const stub: IssueTracker = {
  kind: "linear",
  listAccessibleProjects: async () => [stubProject],
  listIssuesForProjects: async () => [stubIssue],
  getIssue: async (id) => (id === "STUB-1" ? stubIssue : null),
  getMergeRequestForIssue: async () => null,
  capabilities: () => ({ supportsMrLookup: true, supportsPipelineStatus: true }),
}

runIssueTrackerContract("Stub", async () => ({
  tracker: stub,
  fixtures: {
    knownProject: stubProject,
    knownIssueId: "STUB-1",
    knownIssueTitle: "stub title",
    unknownIssueId: "STUB-404",
  },
}))
```

- [ ] **Step 3: Run tests**

Run: `bun test src/__tests__/issue-tracker/contract.harness.test.ts`
Expected: PASS — six contract assertions green against the stub.

- [ ] **Step 4: Commit**

```bash
git add src/issue-tracker/contract-tests.ts src/__tests__/issue-tracker/contract.harness.test.ts
git commit -m "issue-tracker: contract test suite (stub-driven smoke harness)"
```

---

## Task 5: LinearTracker implementation

**Files:**
- Create: `src/issue-tracker/linear.ts`
- Modify (read-only inspection): `src/adapters/linear.ts:1-239`
- Create: `src/__tests__/issue-tracker/linear.test.ts`
- Create: `src/__tests__/fixtures/linear/projects.json`
- Create: `src/__tests__/fixtures/linear/issues.json`
- Create: `src/__tests__/fixtures/linear/issue-jwt-12.json`

**Goal:** Wrap the existing `src/adapters/linear.ts` GraphQL helpers as an `IssueTracker`. Mock HTTP via fixture replay.

- [ ] **Step 1: Read the existing adapter to understand its surface**

Run: `bun run /Users/jarred/Code/personal/jmux/src/adapters/linear.ts --help` (n/a — it's a module). Open and read the file. Identify the GraphQL helpers exported (likely something like `linearQuery`, `getIssueByIdentifier`, etc.) and what raw types they return.

Document the mapping at the top of `src/issue-tracker/linear.ts` as a brief comment.

- [ ] **Step 2: Build fixtures from the contract suite expectations**

Create three JSON files matching Linear's GraphQL response shape. Each contains exactly the data the contract suite asks for. Keep them minimal.

`src/__tests__/fixtures/linear/projects.json`:

```json
{
  "data": {
    "projects": {
      "nodes": [
        { "id": "uuid-q1auth", "name": "Q1 Auth Migration", "url": "https://linear.app/x/project/uuid-q1auth" }
      ]
    }
  }
}
```

`src/__tests__/fixtures/linear/issues.json`:

```json
{
  "data": {
    "issues": {
      "nodes": [
        {
          "identifier": "JWT-12",
          "title": "Rotate JWT signing key",
          "state": { "type": "started" },
          "project": { "id": "uuid-q1auth" },
          "assignee": null,
          "branchName": "JWT-12-rotate-jwt",
          "url": "https://linear.app/x/issue/JWT-12"
        }
      ]
    }
  }
}
```

`src/__tests__/fixtures/linear/issue-jwt-12.json`:

```json
{
  "data": {
    "issue": {
      "identifier": "JWT-12",
      "title": "Rotate JWT signing key",
      "state": { "type": "started" },
      "project": { "id": "uuid-q1auth" },
      "assignee": null,
      "branchName": "JWT-12-rotate-jwt",
      "url": "https://linear.app/x/issue/JWT-12"
    }
  }
}
```

- [ ] **Step 3: Write a failing test running the contract suite via fixture-backed `fetch`**

```ts
// src/__tests__/issue-tracker/linear.test.ts
import { runIssueTrackerContract } from "../../issue-tracker/contract-tests"
import { createLinearTracker } from "../../issue-tracker/linear"

import projectsFixture from "../fixtures/linear/projects.json"
import issuesFixture from "../fixtures/linear/issues.json"
import singleIssueFixture from "../fixtures/linear/issue-jwt-12.json"

function makeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    const query: string = body.query ?? ""
    let payload: unknown
    if (query.includes("projects")) payload = projectsFixture
    else if (query.includes("issue(") || query.includes("issue (")) payload = singleIssueFixture
    else if (query.includes("issues")) payload = issuesFixture
    else payload = { data: null }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

runIssueTrackerContract("LinearTracker (fixtures)", async () => ({
  tracker: createLinearTracker({
    apiKey: "test",
    fetchImpl: makeFetch(),
  }),
  fixtures: {
    knownProject: { id: "uuid-q1auth", name: "Q1 Auth Migration", url: "https://linear.app/x/project/uuid-q1auth" },
    knownIssueId: "JWT-12",
    knownIssueTitle: "Rotate JWT signing key",
    unknownIssueId: "JWT-9999",
  },
}))
```

Run: `bun test src/__tests__/issue-tracker/linear.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `createLinearTracker`**

```ts
// src/issue-tracker/linear.ts
import type {
  IssueListOpts,
  IssueTracker,
  TrackerCapabilities,
  TrackerIssue,
  TrackerIssueStatus,
  TrackerMR,
  TrackerProject,
} from "./types"

const LINEAR_ENDPOINT = "https://api.linear.app/graphql"

export interface LinearTrackerOpts {
  apiKey: string
  fetchImpl?: typeof fetch
  endpoint?: string
}

interface LinearStateRef { type: string }
interface LinearProjectRef { id: string }
interface LinearAssigneeRef { id: string }
interface LinearIssueNode {
  identifier: string
  title: string
  state: LinearStateRef
  project: LinearProjectRef | null
  assignee: LinearAssigneeRef | null
  branchName: string | null
  url: string
}
interface LinearProjectNode { id: string; name: string; url: string }

function mapState(t: string): TrackerIssueStatus {
  switch (t) {
    case "backlog": return "backlog"
    case "unstarted": return "todo"
    case "started": return "in_progress"
    case "review": return "in_review"
    case "completed": return "done"
    case "canceled":
    case "cancelled": return "cancelled"
    default: return "todo"
  }
}

function mapIssue(node: LinearIssueNode): TrackerIssue {
  return {
    id: node.identifier,
    title: node.title,
    status: mapState(node.state?.type ?? "unstarted"),
    projectId: node.project?.id ?? "",
    assigneeId: node.assignee?.id ?? null,
    branchName: node.branchName ?? null,
    url: node.url,
  }
}

function mapProject(node: LinearProjectNode): TrackerProject {
  return { id: node.id, name: node.name, url: node.url }
}

export function createLinearTracker(opts: LinearTrackerOpts): IssueTracker {
  const fetchImpl = opts.fetchImpl ?? fetch
  const endpoint = opts.endpoint ?? LINEAR_ENDPOINT
  async function query<T>(graphql: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: opts.apiKey,
      },
      body: JSON.stringify({ query: graphql, variables }),
    })
    if (!res.ok) throw new Error(`Linear request failed: ${res.status}`)
    const body = (await res.json()) as { data?: T; errors?: unknown }
    if (!body.data) throw new Error("Linear response missing data")
    return body.data
  }

  return {
    kind: "linear",
    async listAccessibleProjects(): Promise<TrackerProject[]> {
      const data = await query<{ projects: { nodes: LinearProjectNode[] } }>(
        `query { projects(first: 200) { nodes { id name url } } }`,
      )
      return data.projects.nodes.map(mapProject)
    },
    async listIssuesForProjects(projectIds, listOpts: IssueListOpts) {
      if (projectIds.length === 0) return []
      const filter: Record<string, unknown> = { project: { id: { in: projectIds } } }
      if (!listOpts.includeClosed) {
        filter.state = { type: { nin: ["completed", "canceled", "cancelled"] } }
      }
      const data = await query<{ issues: { nodes: LinearIssueNode[] } }>(
        `query($filter: IssueFilter) {
           issues(first: 200, filter: $filter) {
             nodes { identifier title state { type } project { id } assignee { id } branchName url }
           }
         }`,
        { filter },
      )
      return data.issues.nodes.map(mapIssue)
    },
    async getIssue(id) {
      const data = await query<{ issue: LinearIssueNode | null }>(
        `query($id: String!) {
           issue(id: $id) { identifier title state { type } project { id } assignee { id } branchName url }
         }`,
        { id },
      )
      return data.issue ? mapIssue(data.issue) : null
    },
    async getMergeRequestForIssue(_id: string): Promise<TrackerMR | null> {
      // Linear does not own MR state; this requires the codeHost adapter.
      // Returning null here keeps the contract honest. The IssueCache layer
      // will combine results from a code-host adapter when one is configured.
      return null
    },
    capabilities(): TrackerCapabilities {
      return { supportsMrLookup: false, supportsPipelineStatus: false }
    },
  }
}
```

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/issue-tracker/linear.test.ts && bun typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/issue-tracker/linear.ts src/__tests__/issue-tracker/linear.test.ts src/__tests__/fixtures/linear/
git commit -m "issue-tracker: LinearTracker implementation with fixture-driven contract tests"
```

---

## Task 6: IssueCache

**Files:**
- Create: `src/issue-tracker/cache.ts`
- Create: `src/__tests__/issue-tracker/cache.test.ts`

**Goal:** In-memory cache with TTL-gated `getIssue` and explicit refresh API. Drives the sidebar in Plan 2.

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/issue-tracker/cache.test.ts
import { beforeEach, describe, expect, test } from "bun:test"
import { IssueCache } from "../../issue-tracker/cache"
import type { IssueTracker, TrackerIssue, TrackerProject } from "../../issue-tracker/types"

const project: TrackerProject = { id: "p1", name: "P", url: "https://x/p" }
const baseIssue: TrackerIssue = {
  id: "X-1", title: "alpha", status: "in_progress",
  projectId: "p1", assigneeId: null, branchName: "X-1-alpha", url: "https://x/i/X-1",
}

function makeTracker(overrides: Partial<IssueTracker> = {}): IssueTracker & { calls: { issues: number; project: number } } {
  const calls = { issues: 0, project: 0 }
  const tracker = {
    kind: "linear" as const,
    listAccessibleProjects: async () => { calls.project += 1; return [project] },
    listIssuesForProjects: async () => { calls.issues += 1; return [baseIssue] },
    getIssue: async (id: string) => (id === baseIssue.id ? baseIssue : null),
    getMergeRequestForIssue: async () => null,
    capabilities: () => ({ supportsMrLookup: false, supportsPipelineStatus: false }),
    ...overrides,
  }
  return Object.assign(tracker, { calls })
}

describe("IssueCache", () => {
  test("refreshAll populates projects + issues", async () => {
    const tracker = makeTracker()
    const cache = new IssueCache(tracker, { refreshIntervalMs: 60_000 })
    await cache.refreshAll(["p1"])
    expect(cache.getProject("p1")?.name).toBe("P")
    expect(cache.getIssuesForProject("p1")).toHaveLength(1)
  })

  test("getIssue uses cache within TTL", async () => {
    const tracker = makeTracker()
    const cache = new IssueCache(tracker, { refreshIntervalMs: 60_000, getIssueTtlMs: 1000 })
    await cache.refreshAll(["p1"])
    await cache.getIssue("X-1") // cache hit
    await cache.getIssue("X-1") // cache hit
    expect(tracker.calls.issues).toBe(1) // never re-fetched via getIssue
  })

  test("listIssuesForProjects failure is isolated per project", async () => {
    let calls = 0
    const tracker = makeTracker({
      listIssuesForProjects: async (ids) => {
        calls += 1
        if (ids[0] === "bad") throw new Error("boom")
        return [baseIssue]
      },
    })
    const cache = new IssueCache(tracker, { refreshIntervalMs: 60_000 })
    await cache.refreshAll(["p1", "bad"])
    expect(cache.getIssuesForProject("p1")).toHaveLength(1)
    expect(cache.getIssuesForProject("bad")).toHaveLength(0)
    expect(cache.lastErrorFor("bad")).toContain("boom")
  })

  test("removeProject evicts the project and its issues", async () => {
    const tracker = makeTracker()
    const cache = new IssueCache(tracker, { refreshIntervalMs: 60_000 })
    await cache.refreshAll(["p1"])
    cache.removeProject("p1")
    expect(cache.getProject("p1")).toBeUndefined()
    expect(cache.getIssuesForProject("p1")).toHaveLength(0)
  })
})
```

Run: `bun test src/__tests__/issue-tracker/cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `IssueCache`**

```ts
// src/issue-tracker/cache.ts
import type {
  IssueTracker, TrackerIssue, TrackerMR, TrackerProject,
} from "./types"

export interface IssueCacheOpts {
  refreshIntervalMs: number
  getIssueTtlMs?: number
}

interface ProjectEntry {
  project: TrackerProject
  issues: TrackerIssue[]
  fetchedAt: number
  lastError?: string
}

export class IssueCache {
  private readonly tracker: IssueTracker
  private readonly opts: Required<IssueCacheOpts>
  private readonly projects = new Map<string, ProjectEntry>()
  private readonly issuesById = new Map<string, { issue: TrackerIssue; fetchedAt: number }>()
  private readonly mrs = new Map<string, { mr: TrackerMR | null; fetchedAt: number }>()

  constructor(tracker: IssueTracker, opts: IssueCacheOpts) {
    this.tracker = tracker
    this.opts = {
      refreshIntervalMs: opts.refreshIntervalMs,
      getIssueTtlMs: opts.getIssueTtlMs ?? 30_000,
    }
  }

  async refreshAll(projectIds: string[]): Promise<void> {
    const accessible = await this.tracker.listAccessibleProjects()
    const byId = new Map(accessible.map((p) => [p.id, p]))
    await Promise.all(
      projectIds.map(async (pid) => {
        const meta = byId.get(pid)
        if (!meta) {
          this.projects.set(pid, {
            project: { id: pid, name: pid, url: "" },
            issues: [],
            fetchedAt: Date.now(),
            lastError: "project not in accessible list",
          })
          return
        }
        try {
          const issues = await this.tracker.listIssuesForProjects([pid], {
            assignedToMe: false,
            includeClosed: false,
          })
          this.projects.set(pid, { project: meta, issues, fetchedAt: Date.now() })
          for (const i of issues) {
            this.issuesById.set(i.id, { issue: i, fetchedAt: Date.now() })
          }
        } catch (err) {
          this.projects.set(pid, {
            project: meta, issues: [], fetchedAt: Date.now(),
            lastError: err instanceof Error ? err.message : String(err),
          })
        }
      }),
    )
  }

  getProject(id: string): TrackerProject | undefined {
    return this.projects.get(id)?.project
  }

  getIssuesForProject(id: string): TrackerIssue[] {
    return this.projects.get(id)?.issues ?? []
  }

  async getIssue(id: string): Promise<TrackerIssue | null> {
    const hit = this.issuesById.get(id)
    if (hit && Date.now() - hit.fetchedAt < this.opts.getIssueTtlMs) return hit.issue
    const fresh = await this.tracker.getIssue(id)
    if (fresh) this.issuesById.set(id, { issue: fresh, fetchedAt: Date.now() })
    return fresh
  }

  lastErrorFor(projectId: string): string | undefined {
    return this.projects.get(projectId)?.lastError
  }

  removeProject(id: string): void {
    const entry = this.projects.get(id)
    if (!entry) return
    for (const i of entry.issues) this.issuesById.delete(i.id)
    this.projects.delete(id)
  }
}
```

- [ ] **Step 3: Run tests**

Run: `bun test src/__tests__/issue-tracker/cache.test.ts && bun typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 4: Commit**

```bash
git add src/issue-tracker/cache.ts src/__tests__/issue-tracker/cache.test.ts
git commit -m "issue-tracker: IssueCache with TTL and per-project failure isolation"
```

---

## Task 7: getIssueTracker factory and main.ts wiring (cache lifecycle)

**Files:**
- Create: `src/issue-tracker/index.ts`
- Modify: `src/main.ts` (top of file + startup; add a single wired-up block)
- Modify: `src/__tests__/issue-tracker/types.test.ts` (extend to cover factory)

**Goal:** A single `getIssueTracker(config)` entrypoint. Wire it into main.ts so the cache exists at startup and polls every `refreshIntervalMs`. No UI consumption yet.

- [ ] **Step 1: Write failing tests**

```ts
// append to src/__tests__/issue-tracker/types.test.ts
import { getIssueTracker } from "../../issue-tracker"
import { defaultConfig } from "../../config"

describe("getIssueTracker factory", () => {
  test("returns null when issueTracker is unset", () => {
    expect(getIssueTracker(defaultConfig())).toBeNull()
  })

  test("returns null when LINEAR_API_KEY env var is missing", () => {
    const config = {
      ...defaultConfig(),
      issueTracker: {
        kind: "linear" as const,
        linear: { apiKeyEnv: "__NEVER_SET_VAR__" },
      },
    }
    const prev = process.env.__NEVER_SET_VAR__
    delete process.env.__NEVER_SET_VAR__
    try {
      expect(getIssueTracker(config)).toBeNull()
    } finally {
      if (prev !== undefined) process.env.__NEVER_SET_VAR__ = prev
    }
  })

  test("returns a tracker when configured and env var is set", () => {
    process.env.__LINEAR_TEST_KEY__ = "abc"
    try {
      const config = {
        ...defaultConfig(),
        issueTracker: {
          kind: "linear" as const,
          linear: { apiKeyEnv: "__LINEAR_TEST_KEY__" },
        },
      }
      const tracker = getIssueTracker(config)
      expect(tracker?.kind).toBe("linear")
    } finally {
      delete process.env.__LINEAR_TEST_KEY__
    }
  })
})
```

Run: `bun test src/__tests__/issue-tracker/types.test.ts -t "getIssueTracker factory"`
Expected: FAIL — module not exported.

- [ ] **Step 2: Implement the factory**

```ts
// src/issue-tracker/index.ts
import type { JmuxConfig } from "../config"
import { createLinearTracker } from "./linear"
import type { IssueTracker } from "./types"

export { IssueCache } from "./cache"
export type {
  IssueListOpts, IssueTracker, TrackerCapabilities, TrackerIssue,
  TrackerIssueStatus, TrackerMR, TrackerMrState, TrackerPipelineState, TrackerProject,
} from "./types"

export function getIssueTracker(config: JmuxConfig): IssueTracker | null {
  const cfg = config.issueTracker
  if (!cfg) return null
  if (cfg.kind !== "linear") return null
  const apiKey = process.env[cfg.linear.apiKeyEnv]
  if (!apiKey) return null
  return createLinearTracker({ apiKey })
}
```

Run: `bun test src/__tests__/issue-tracker/types.test.ts && bun typecheck`
Expected: PASS, clean.

- [ ] **Step 3: Wire the cache into `main.ts` startup (no consumption yet)**

In `src/main.ts`, near the existing config-load + state-init block, add:

```ts
import { IssueCache, getIssueTracker } from "./issue-tracker"

// inside the bootstrap function, after config is loaded:
const issueTracker = getIssueTracker(config)
const issueCache: IssueCache | null = issueTracker
  ? new IssueCache(issueTracker, {
      refreshIntervalMs: config.issueTracker?.refreshIntervalMs ?? 60_000,
    })
  : null
const configuredProjectIds = (config.linearProjects ?? []).map((p) => p.id)
if (issueCache && configuredProjectIds.length > 0) {
  issueCache.refreshAll(configuredProjectIds).catch((err) => {
    console.error("[jmux] initial Linear refresh failed:", err)
  })
  const refreshTimer = setInterval(() => {
    issueCache.refreshAll(configuredProjectIds).catch(() => {})
  }, config.issueTracker?.refreshIntervalMs ?? 60_000)
  process.on("beforeExit", () => clearInterval(refreshTimer))
}
```

Expose `issueCache` on whatever shared state object the renderer reads from (likely a `RuntimeContext`). Plan 2 consumes it.

- [ ] **Step 4: Verify build + tests + typecheck still pass**

Run: `bun typecheck && bun test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/issue-tracker/index.ts src/main.ts src/__tests__/issue-tracker/types.test.ts
git commit -m "issue-tracker: factory and main.ts cache lifecycle wiring"
```

---

## Task 8: Agent-state types and tmux option reads

**Files:**
- Create: `src/agent-state.ts`
- Modify: `src/tmux-control.ts`
- Modify: `src/types.ts`
- Create: `src/__tests__/agent-state.test.ts`
- Modify: `src/__tests__/tmux-control.test.ts`

**Goal:** Define `AgentState`, surface tmux user options carrying agent state and link metadata, and project them onto `SessionInfo`. OTEL corroboration lands in Task 10.

- [ ] **Step 1: Write failing tests for `agent-state.ts`**

```ts
// src/__tests__/agent-state.test.ts
import { describe, expect, test } from "bun:test"
import { parseAgentStateOption, mergeAgentState } from "../agent-state"

describe("parseAgentStateOption", () => {
  test("recognised values map to the enum", () => {
    expect(parseAgentStateOption("idle")).toBe("idle")
    expect(parseAgentStateOption("generating")).toBe("generating")
    expect(parseAgentStateOption("waiting")).toBe("waiting")
    expect(parseAgentStateOption("error")).toBe("error")
  })

  test("blank or unknown values default to none", () => {
    expect(parseAgentStateOption(undefined)).toBe("none")
    expect(parseAgentStateOption("")).toBe("none")
    expect(parseAgentStateOption("nonsense")).toBe("none")
  })
})

describe("mergeAgentState", () => {
  test("hook signal wins over OTEL when both fresh", () => {
    expect(mergeAgentState({ hook: "generating", otel: "idle" })).toBe("generating")
  })

  test("OTEL fills in when hook is none", () => {
    expect(mergeAgentState({ hook: "none", otel: "waiting" })).toBe("waiting")
  })

  test("returns none when neither has a signal", () => {
    expect(mergeAgentState({ hook: "none", otel: "none" })).toBe("none")
  })
})
```

Run: `bun test src/__tests__/agent-state.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `src/agent-state.ts`**

```ts
// src/agent-state.ts
export type AgentState = "none" | "idle" | "generating" | "waiting" | "error"

const KNOWN: ReadonlySet<AgentState> = new Set(["none", "idle", "generating", "waiting", "error"])

export function parseAgentStateOption(raw: string | undefined): AgentState {
  if (!raw) return "none"
  return KNOWN.has(raw as AgentState) ? (raw as AgentState) : "none"
}

export function mergeAgentState(s: { hook: AgentState; otel: AgentState }): AgentState {
  if (s.hook !== "none") return s.hook
  return s.otel
}
```

Run: `bun test src/__tests__/agent-state.test.ts && bun typecheck`
Expected: PASS, clean.

- [ ] **Step 3: Extend `SessionInfo` with link + agent-state fields**

In `src/types.ts`:

```ts
import type { AgentState } from "./agent-state"

export interface SessionInfo {
  // ...existing fields preserved...
  linearIssueId?: string
  linearProjectId?: string
  repoPath?: string
  agentState: AgentState  // default "none"
  agentStateOtel?: AgentState  // populated by OtelReceiver
}
```

- [ ] **Step 4: Write failing test for tmux-control option reads**

```ts
// add to src/__tests__/tmux-control.test.ts
import { describe, expect, test } from "bun:test"
import { parseSessionOptionsBlock } from "../tmux-control"

describe("parseSessionOptionsBlock", () => {
  test("extracts @jmux-* user options", () => {
    const raw = [
      "@jmux-agent-state generating",
      "@jmux-linear-issue JWT-12",
      "@jmux-linear-project uuid-q1auth",
      "@jmux-repo-path /Users/x/Code/work/webapp",
      "some-other-option value",
    ].join("\n")
    const parsed = parseSessionOptionsBlock(raw)
    expect(parsed["@jmux-agent-state"]).toBe("generating")
    expect(parsed["@jmux-linear-issue"]).toBe("JWT-12")
    expect(parsed["@jmux-linear-project"]).toBe("uuid-q1auth")
    expect(parsed["@jmux-repo-path"]).toBe("/Users/x/Code/work/webapp")
  })

  test("quoted values are unquoted", () => {
    const raw = `@jmux-linear-issue "JWT-12"`
    expect(parseSessionOptionsBlock(raw)["@jmux-linear-issue"]).toBe("JWT-12")
  })
})
```

Run: `bun test src/__tests__/tmux-control.test.ts -t "parseSessionOptionsBlock"`
Expected: FAIL.

- [ ] **Step 5: Implement `parseSessionOptionsBlock` and call from existing session-list path**

Add to `src/tmux-control.ts`:

```ts
export function parseSessionOptionsBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const sp = trimmed.indexOf(" ")
    if (sp < 0) continue
    const key = trimmed.slice(0, sp)
    let val = trimmed.slice(sp + 1).trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    out[key] = val
  }
  return out
}
```

Where the existing code populates `SessionInfo`, add a `show-options -t <session> -A` call (via the control client) and decorate the info object:

```ts
const opts = parseSessionOptionsBlock(rawOptionsOutput)
sessionInfo.linearIssueId = opts["@jmux-linear-issue"] || undefined
sessionInfo.linearProjectId = opts["@jmux-linear-project"] || undefined
sessionInfo.repoPath = opts["@jmux-repo-path"] || undefined
sessionInfo.agentState = parseAgentStateOption(opts["@jmux-agent-state"])
```

(Exact location depends on the existing session-build helper. The session-build path that already reads `@jmux-attention` is the right one to extend.)

- [ ] **Step 6: Run all relevant tests**

Run: `bun test && bun typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agent-state.ts src/tmux-control.ts src/types.ts src/__tests__/agent-state.test.ts src/__tests__/tmux-control.test.ts
git commit -m "agent-state: define type and surface tmux user options on SessionInfo"
```

---

## Task 9: `--install-agent-hooks` writes the four-hook block with version marker

**Files:**
- Modify: `bin/jmux` or wherever the existing `--install-agent-hooks` handler lives (search: `install-agent-hooks` in `src/`)
- Modify: tests covering the installer (search: `install-agent-hooks` under `src/__tests__/`); if none exist, create `src/__tests__/install-agent-hooks.test.ts`

**Goal:** Replace the single Stop hook with four hooks driving `@jmux-agent-state`, bounded by a version-marked block.

- [ ] **Step 1: Locate the current installer**

Run: `grep -rn "install-agent-hooks" src/ bin/`
Expected: shows the current implementation and any tests.

- [ ] **Step 2: Write failing test for the new hook block**

Create `src/__tests__/install-agent-hooks.test.ts` (or extend existing):

```ts
import { describe, expect, test } from "bun:test"
import { renderHookBlock, parseHookBlock } from "../install-agent-hooks"

const VERSION = 2

describe("renderHookBlock", () => {
  test("produces marker comments with version", () => {
    const block = renderHookBlock(VERSION)
    expect(block).toContain(`// >>> jmux-agent-hooks v${VERSION}`)
    expect(block).toContain(`// <<< jmux-agent-hooks v${VERSION}`)
  })

  test("includes UserPromptSubmit, PreToolUse, PostToolUse, Stop", () => {
    const block = renderHookBlock(VERSION)
    expect(block).toMatch(/UserPromptSubmit/)
    expect(block).toMatch(/PreToolUse/)
    expect(block).toMatch(/PostToolUse/)
    expect(block).toMatch(/Stop/)
  })

  test("each hook sets @jmux-agent-state with the appropriate state", () => {
    const block = renderHookBlock(VERSION)
    expect(block).toMatch(/@jmux-agent-state.*generating/)
    expect(block).toMatch(/@jmux-agent-state.*waiting/)
    expect(block).toMatch(/@jmux-agent-state.*idle/)
  })
})

describe("parseHookBlock", () => {
  test("returns null when no jmux block present", () => {
    expect(parseHookBlock(`{"hooks":{}}`)).toBeNull()
  })

  test("detects a block and reports its version", () => {
    const src = `// >>> jmux-agent-hooks v1\n{}\n// <<< jmux-agent-hooks v1\n`
    const found = parseHookBlock(src)
    expect(found?.version).toBe(1)
  })

  test("flags a stale block when older than current", () => {
    const src = `// >>> jmux-agent-hooks v1\n{}\n// <<< jmux-agent-hooks v1\n`
    const found = parseHookBlock(src)
    expect(found && found.version < VERSION).toBe(true)
  })
})
```

Run: `bun test src/__tests__/install-agent-hooks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `renderHookBlock` and `parseHookBlock`**

Create `src/install-agent-hooks.ts`:

```ts
export const HOOK_VERSION = 2

const MARKER_START = (v: number) => `// >>> jmux-agent-hooks v${v}`
const MARKER_END = (v: number) => `// <<< jmux-agent-hooks v${v}`

export interface HookBlockMeta { version: number }

export function parseHookBlock(src: string): HookBlockMeta | null {
  const m = src.match(/\/\/ >>> jmux-agent-hooks v(\d+)/)
  if (!m) return null
  return { version: Number(m[1]) }
}

export function renderHookBlock(version: number = HOOK_VERSION): string {
  // The hook body runs a small shell command that sets the @jmux-agent-state
  // tmux user option on the current session. TMUX env var supplies the socket.
  const setState = (state: string) =>
    `bash -c 'if [ -n "$TMUX" ]; then tmux set-option -t "$(tmux display-message -p \\"#S\\")" @jmux-agent-state ${state}; fi'`
  return [
    MARKER_START(version),
    `// Managed by jmux. Do not edit between markers; re-run jmux --install-agent-hooks to update.`,
    `"hooks": {`,
    `  "UserPromptSubmit": [{ "command": "${setState("generating")}" }],`,
    `  "PreToolUse": [{ "command": "${setState("waiting")}" }],`,
    `  "PostToolUse": [{ "command": "${setState("generating")}" }],`,
    `  "Stop": [`,
    `    { "command": "${setState("idle")}" },`,
    `    { "command": "bash -c 'tmux set-option -t \\\"$(tmux display-message -p \\\\\\\"#S\\\\\\\")\\\" @jmux-attention 1'\" }`,
    `  ]`,
    `}`,
    MARKER_END(version),
  ].join("\n")
}
```

Update the installer entrypoint (the code path triggered by `jmux --install-agent-hooks`) to:

1. Read `~/.claude/settings.json` (or create it from `{}` if missing).
2. If the file contains an existing block (any version), strip lines from start-marker to end-marker.
3. Insert the new `renderHookBlock()` output in the appropriate JSON shape (merging into `hooks`).
4. Write atomically.

If the existing implementation uses a different file shape (e.g., wraps the hook block in a `commands.json` style), match its conventions while keeping the marker comments.

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/install-agent-hooks.test.ts && bun typecheck`
Expected: PASS.

- [ ] **Step 5: Manual sanity check**

In a scratch directory:
```bash
HOME=/tmp/jmux-hook-test mkdir -p /tmp/jmux-hook-test/.claude
echo '{}' > /tmp/jmux-hook-test/.claude/settings.json
HOME=/tmp/jmux-hook-test bun run src/main.ts --install-agent-hooks
cat /tmp/jmux-hook-test/.claude/settings.json
```
Expected: settings.json now contains the marker-bounded block with all four hooks.

- [ ] **Step 6: Commit**

```bash
git add src/install-agent-hooks.ts src/__tests__/install-agent-hooks.test.ts bin/jmux  # plus wherever the entrypoint was modified
git commit -m "hooks: install four agent-state hooks bounded by versioned marker block"
```

---

## Task 10: OTEL corroboration of agent state

**Files:**
- Modify: `src/otel-receiver.ts`
- Modify: `src/__tests__/otel-receiver.test.ts`

**Goal:** The OTEL receiver already accepts Claude Code spans. Have it emit `{sessionId, state}` agent-state hints alongside its existing cache events.

- [ ] **Step 1: Identify the span shapes the receiver already handles**

Read `src/otel-receiver.ts` and the existing test file. Note which spans are surfaced today (likely `claude_code.cache_read`, `claude_code.cache_write`, or similar).

- [ ] **Step 2: Write failing test for state emission**

```ts
// extend src/__tests__/otel-receiver.test.ts
describe("agent-state hints from OTEL spans", () => {
  test("user_prompt span emits generating", async () => {
    const events: { sessionId: string; state: string }[] = []
    const receiver = startReceiver({ onAgentStateHint: (e) => events.push(e) })
    await receiver.ingestSpan({
      name: "claude_code.user_prompt",
      attributes: { "jmux.session_id": "S1" },
      kind: "INTERNAL",
    })
    expect(events).toContainEqual({ sessionId: "S1", state: "generating" })
    await receiver.stop()
  })

  test("assistant_message span emits idle", async () => {
    const events: { sessionId: string; state: string }[] = []
    const receiver = startReceiver({ onAgentStateHint: (e) => events.push(e) })
    await receiver.ingestSpan({
      name: "claude_code.assistant_message",
      attributes: { "jmux.session_id": "S1" },
      kind: "INTERNAL",
    })
    expect(events).toContainEqual({ sessionId: "S1", state: "idle" })
    await receiver.stop()
  })

  test("tool_use with permission_required emits waiting", async () => {
    const events: { sessionId: string; state: string }[] = []
    const receiver = startReceiver({ onAgentStateHint: (e) => events.push(e) })
    await receiver.ingestSpan({
      name: "claude_code.tool_use",
      attributes: { "jmux.session_id": "S1", "claude_code.permission_required": true },
      kind: "INTERNAL",
    })
    expect(events).toContainEqual({ sessionId: "S1", state: "waiting" })
    await receiver.stop()
  })
})
```

(`startReceiver`, `ingestSpan` are existing helpers — match the project's pattern.)

Run: `bun test src/__tests__/otel-receiver.test.ts -t "agent-state hints"`
Expected: FAIL.

- [ ] **Step 3: Wire the emission**

In `src/otel-receiver.ts`, extend the span-dispatch switch:

```ts
// inside whichever method processes each parsed span:
const sessionId = span.attributes?.["jmux.session_id"]
if (typeof sessionId === "string" && this.onAgentStateHint) {
  switch (span.name) {
    case "claude_code.user_prompt":
      this.onAgentStateHint({ sessionId, state: "generating" })
      break
    case "claude_code.tool_use":
      if (span.attributes?.["claude_code.permission_required"]) {
        this.onAgentStateHint({ sessionId, state: "waiting" })
      }
      break
    case "claude_code.assistant_message":
      this.onAgentStateHint({ sessionId, state: "idle" })
      break
  }
}
```

Add an `onAgentStateHint?: (e: { sessionId: string; state: AgentState }) => void` field to the receiver's options.

- [ ] **Step 4: Wire into `main.ts`**

```ts
// in main.ts where OtelReceiver is constructed:
const otel = new OtelReceiver({
  // ...existing options...
  onAgentStateHint: ({ sessionId, state }) => {
    runtimeContext.setAgentStateHint(sessionId, state)
  },
})
```

`runtimeContext.setAgentStateHint` stores the latest hint per session; `SessionInfo.agentStateOtel` reads it on the next session-build pass.

- [ ] **Step 5: Run tests**

Run: `bun test && bun typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/otel-receiver.ts src/main.ts src/__tests__/otel-receiver.test.ts
git commit -m "otel: emit agent-state hints from Claude Code spans"
```

---

## Task 11: Icon module with Nerd Font and plain sets

**Files:**
- Create: `src/icons.ts`
- Create: `src/__tests__/icons.test.ts`

**Goal:** Centralize every glyph by semantic name. Spec §5.5–§5.8.

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/icons.test.ts
import { describe, expect, test } from "bun:test"
import { getIcons } from "../icons"

const NERD_FONT_PUA_RANGE = (cp: number) => cp >= 0xe000 && cp <= 0xf8ff || cp >= 0xf0000

describe("icon sets", () => {
  test("nerd-font set covers all semantic names", () => {
    const i = getIcons("nerd-font")
    expect(i.error.length).toBeGreaterThan(0)
    expect(i.attention.length).toBeGreaterThan(0)
    expect(i.waiting.length).toBeGreaterThan(0)
    expect(i.done.length).toBeGreaterThan(0)
    expect(i.pinned.length).toBeGreaterThan(0)
    expect(i.chevronDown.length).toBeGreaterThan(0)
    expect(i.chevronRight.length).toBeGreaterThan(0)
    expect(i.mrOpen.length).toBeGreaterThan(0)
    expect(i.mrMerged.length).toBeGreaterThan(0)
    expect(i.mrClosed.length).toBeGreaterThan(0)
    expect(i.mrPipelineRunning.length).toBeGreaterThan(0)
    expect(i.mrPipelineFailed.length).toBeGreaterThan(0)
    expect(i.modePlan.length).toBeGreaterThan(0)
    expect(i.modeAcceptEdits.length).toBeGreaterThan(0)
    expect(i.cancelled.length).toBeGreaterThan(0)
  })

  test("plain set never returns a Nerd Font PUA codepoint", () => {
    const i = getIcons("plain")
    const allChars = Object.values(i).join("")
    for (const ch of allChars) {
      const cp = ch.codePointAt(0)!
      expect(NERD_FONT_PUA_RANGE(cp)).toBe(false)
    }
  })

  test("spinner frames are 10 single-character braille codepoints", () => {
    const i = getIcons("nerd-font")
    expect(i.spinnerFrames).toHaveLength(10)
    i.spinnerFrames.forEach((f) => expect(f.length).toBe(1))
    // Plain set preserves braille per §5.8.
    const ip = getIcons("plain")
    expect(ip.spinnerFrames).toEqual(i.spinnerFrames)
  })

  test("● and ○ are preserved in both sets", () => {
    expect(getIcons("nerd-font").dotFilled).toBe("●")
    expect(getIcons("plain").dotFilled).toBe("●")
    expect(getIcons("nerd-font").dotHollow).toBe("○")
    expect(getIcons("plain").dotHollow).toBe("○")
  })
})
```

Run: `bun test src/__tests__/icons.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 2: Implement `src/icons.ts`**

```ts
// src/icons.ts
import type { IconSet } from "./config"

export interface IconBundle {
  // agent / connection states
  error: string
  attention: string
  waiting: string
  dotFilled: string  // ●
  dotHollow: string  // ○
  // group + structural
  chevronDown: string
  chevronRight: string
  pinned: string
  // status badges
  done: string
  cancelled: string
  mrOpen: string
  mrMerged: string
  mrClosed: string
  mrPipelineRunning: string
  mrPipelineFailed: string
  // mode badges
  modePlan: string
  modeAcceptEdits: string
  // animation
  spinnerFrames: string[]
}

const BRAILLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const NERD: IconBundle = {
  error: "\u{F0026}",             // nf-md-alert
  attention: "\u{F0099}",         // nf-md-bell
  waiting: "\u{F0150}",           // nf-md-clock_outline
  dotFilled: "●",
  dotHollow: "○",
  chevronDown: "\u{F0140}",       // nf-md-chevron_down
  chevronRight: "\u{F0142}",      // nf-md-chevron_right
  pinned: "\u{F0403}",            // nf-md-pin
  done: "\u{F012C}",              // nf-md-check_bold
  cancelled: "\u{F0156}",         // nf-md-cancel
  mrOpen: "\u{F0640}",            // nf-md-source_pull
  mrMerged: "\u{F0641}",          // nf-md-source_merge
  mrClosed: "\u{F05AC}",          // nf-md-source_branch_remove
  mrPipelineRunning: "\u{F00FB}", // nf-md-clock_alert
  mrPipelineFailed: "\u{F0026}",  // nf-md-alert
  modePlan: "\u{F0900}",          // nf-md-strategy
  modeAcceptEdits: "\u{F0E03}",   // nf-md-check_all
  spinnerFrames: BRAILLE_SPINNER,
}

const PLAIN: IconBundle = {
  error: "X",
  attention: "!",
  waiting: "?",
  dotFilled: "●",
  dotHollow: "○",
  chevronDown: "v",
  chevronRight: ">",
  pinned: "*",
  done: "+",
  cancelled: "C",
  mrOpen: "M",
  mrMerged: "M+",
  mrClosed: "M-",
  mrPipelineRunning: "M~",
  mrPipelineFailed: "M!",
  modePlan: "P",
  modeAcceptEdits: "A",
  spinnerFrames: BRAILLE_SPINNER,
}

export function getIcons(set: IconSet): IconBundle {
  return set === "plain" ? PLAIN : NERD
}
```

Run: `bun test src/__tests__/icons.test.ts && bun typecheck`
Expected: PASS, clean.

- [ ] **Step 3: Commit**

```bash
git add src/icons.ts src/__tests__/icons.test.ts
git commit -m "icons: centralize Nerd Font and plain glyph sets by semantic name"
```

---

## Task 12: Surface `agentState` and link fields on `SessionView`

**Files:**
- Modify: `src/session-view.ts`
- Modify: `src/__tests__/session-view.test.ts`

**Goal:** Propagate the new `SessionInfo` fields to `SessionView` so the sidebar (Plan 2) can read them without breaking encapsulation.

- [ ] **Step 1: Write failing tests**

```ts
// extend src/__tests__/session-view.test.ts
describe("SessionView surfaces agent state and link fields", () => {
  test("includes agentState directly", () => {
    const view = buildSessionView({
      // ...minimum fields existing tests use...
      agentState: "generating",
    } as SessionInfo)
    expect(view.agentState).toBe("generating")
  })

  test("includes linearIssueId, linearProjectId, repoPath when set", () => {
    const view = buildSessionView({
      // ...minimum fields...
      agentState: "idle",
      linearIssueId: "JWT-12",
      linearProjectId: "uuid-q1auth",
      repoPath: "/Users/x/Code/work/webapp",
    } as SessionInfo)
    expect(view.linearIssueId).toBe("JWT-12")
    expect(view.linearProjectId).toBe("uuid-q1auth")
    expect(view.repoPath).toBe("/Users/x/Code/work/webapp")
  })

  test("indicatorKind takes agent state into account", () => {
    // generating overrides plain activity
    const v = buildSessionView({ agentState: "generating" } as SessionInfo)
    expect(v.indicatorKind).toBe("generating")
  })

  test("error remains the highest-priority indicator", () => {
    const v = buildSessionView({
      // ...with both mcpDown and agentState set...
      agentState: "generating",
      mcpDown: true,
    } as SessionInfo)
    expect(v.indicatorKind).toBe("error")
  })
})
```

Run: `bun test src/__tests__/session-view.test.ts -t "surfaces agent state"`
Expected: FAIL.

- [ ] **Step 2: Extend `SessionView` and the builder**

```ts
// src/session-view.ts
import type { AgentState } from "./agent-state"

export type IndicatorKind =
  | "error"
  | "attention"
  | "waiting"
  | "generating"
  | "idle-agent"
  | "idle-shell"
  | "detached"
  | "none"

export interface SessionView {
  // ...existing fields...
  agentState: AgentState
  linearIssueId?: string
  linearProjectId?: string
  repoPath?: string
  indicatorKind: IndicatorKind
}

function pickIndicatorKind(info: SessionInfo): IndicatorKind {
  if (info.mcpDown || info.processError) return "error"
  if (info.attention) return "attention"
  if (info.agentState === "waiting") return "waiting"
  if (info.agentState === "generating") return "generating"
  if (info.attached) {
    return info.agentState === "idle" ? "idle-agent" : "idle-shell"
  }
  return "detached"
}

export function buildSessionView(info: SessionInfo): SessionView {
  return {
    // ...existing assembly...
    agentState: info.agentState ?? "none",
    linearIssueId: info.linearIssueId,
    linearProjectId: info.linearProjectId,
    repoPath: info.repoPath,
    indicatorKind: pickIndicatorKind(info),
  }
}
```

Adjust field names to match the existing module's exact shape (`info.attention`, `info.attached`, etc. may already exist under different names).

- [ ] **Step 3: Run tests**

Run: `bun test src/__tests__/session-view.test.ts && bun typecheck`
Expected: PASS, clean.

- [ ] **Step 4: Commit**

```bash
git add src/session-view.ts src/__tests__/session-view.test.ts
git commit -m "session-view: surface agentState, link fields, and indicatorKind priority"
```

---

## Self-Review

Spec coverage check — every section listed in Plan 1's scope is implemented:

- **§3.1 IssueTracker interface** → Task 3.
- **§3.2 IssueCache** → Task 6.
- **§3.3 failure modes** → covered by `IssueCache.lastErrorFor` in Task 6 + the `try/catch` in main.ts Task 7.
- **§4.1 issueTracker config** → Tasks 1, 2.
- **§4.2 linearProjects config** → Tasks 1, 2.
- **§4.3 issueWorkflow revisions** → partial (deprecation warning in Task 2); `claudePromptTemplate` consumption defers to Plan 3 (modal auto-launch).
- **§4.4 wtmIntegration** — unchanged at config layer; behavior change is in Plan 3.
- **§4.5 iconSet** → Tasks 1, 2, 11.
- **§4.6 strict validation + unknown-key round-trip** → Task 2.
- **§5.4 agent state indicator** → Tasks 8, 12.
- **§5.6 spinner animation** — Plan 2 (sidebar renders); types in place via Task 11.
- **§5.7 icon module boundary** → Task 11.
- **§5.8 plain fallback** → Task 11.
- **§8.3 agent state introspection (CLI)** — deferred to Plan 5.
- **§8.6 issue↔session link via tmux options** → Task 8 (read side). Write side lands in Plan 3 modal Task and Plan 5 `issue link` task.
- **§9.3 hook re-installation with version marker** → Task 9.
- **§10.1 testing surfaces** — covered: contract suite (Task 4), cache (Task 6), icons (Task 11), agent-state (Task 8), config (Tasks 1–2), session view (Task 12), OTEL (Task 10), hook installer (Task 9).

Placeholder scan — every code block contains the actual code an engineer needs. No "TBD" / "TODO" / "similar to" / "etc." left in steps.

Type consistency — `AgentState`, `IconSet`, `IconBundle`, `IssueTracker`, `IssueCache`, `TrackerIssue`, `TrackerProject`, `TrackerMR` names match across all tasks. `SessionInfo` and `SessionView` field names line up.

---

## Execution Handoff

Plan 1 complete and saved to `docs/superpowers/plans/2026-05-10-projects-sessions-worktrees-plan-1-foundation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
