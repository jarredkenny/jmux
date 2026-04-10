# Meta Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the vertical slice — "pick up a Linear ticket → create worktree/session → dispatch Claude with ticket context" — implementing just enough of the task registry, tool panel, and meta agent to make that flow work.

**Architecture:** Three layers compose into the flow: a task registry (`~/.config/jmux/tasks.json`) managed via `jmux ctl task` commands, a tool panel wrapping the existing diff panel with a new agent tab, and a Claude Code subprocess (spawn-per-message) that reads workflow configs and drives `ctl` commands. All external service interaction (Linear, GitHub) is delegated to Claude Code's MCP ecosystem.

**Tech Stack:** Bun 1.2+, TypeScript (strict mode), tmux 3.2+, Claude Code CLI (`--output-format stream-json`)

---

### Task 1: Task Registry — Types and Storage

**Files:**
- Create: `src/task-registry.ts`
- Test: `src/__tests__/task-registry.test.ts`

- [ ] **Step 1: Write failing tests for task registry types and CRUD**

```typescript
// src/__tests__/task-registry.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  type TaskEntry,
  type TaskRegistry,
  loadRegistry,
  saveRegistry,
  createTask,
  getTask,
  updateTask,
  removeTask,
  listTasks,
} from "../task-registry";

describe("TaskRegistry storage", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "jmux-test-"));
    filePath = resolve(dir, "tasks.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadRegistry returns empty tasks when file missing", () => {
    const reg = loadRegistry(filePath);
    expect(reg).toEqual({ tasks: {} });
  });

  test("saveRegistry writes and loadRegistry reads back", () => {
    const reg: TaskRegistry = {
      tasks: {
        "MYAPP-1": {
          source: "linear",
          externalId: "uuid-1",
          url: "https://linear.app/team/MYAPP-1",
          title: "Fix bug",
          session: null,
          worktree: null,
          project: "myapp",
          mrs: [],
          status: "pickup",
          createdAt: "2026-04-10T00:00:00Z",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
    };
    saveRegistry(filePath, reg);
    const loaded = loadRegistry(filePath);
    expect(loaded).toEqual(reg);
  });

  test("saveRegistry uses atomic write (temp + rename)", () => {
    const reg: TaskRegistry = { tasks: { "X-1": { source: "linear", externalId: "a", url: "", title: "t", session: null, worktree: null, project: "p", mrs: [], status: "pickup", createdAt: "", updatedAt: "" } } };
    saveRegistry(filePath, reg);
    // File should exist and be valid JSON
    const raw = readFileSync(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual(reg);
  });
});

describe("TaskRegistry CRUD", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "jmux-test-"));
    filePath = resolve(dir, "tasks.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("createTask adds a new task", () => {
    createTask(filePath, {
      ticket: "MYAPP-1",
      source: "linear",
      title: "Fix auth",
      project: "myapp",
    });
    const task = getTask(filePath, "MYAPP-1");
    expect(task).not.toBeNull();
    expect(task!.title).toBe("Fix auth");
    expect(task!.status).toBe("pickup");
    expect(task!.session).toBeNull();
  });

  test("createTask throws on duplicate", () => {
    createTask(filePath, { ticket: "MYAPP-1", source: "linear" });
    expect(() => createTask(filePath, { ticket: "MYAPP-1", source: "linear" })).toThrow("already exists");
  });

  test("updateTask modifies fields", () => {
    createTask(filePath, { ticket: "MYAPP-1", source: "linear" });
    updateTask(filePath, "MYAPP-1", { status: "in_progress", session: "myapp-1" });
    const task = getTask(filePath, "MYAPP-1");
    expect(task!.status).toBe("in_progress");
    expect(task!.session).toBe("myapp-1");
  });

  test("updateTask appends MR", () => {
    createTask(filePath, { ticket: "MYAPP-1", source: "linear" });
    updateTask(filePath, "MYAPP-1", { mr: "https://gitlab.com/mr/1", mrState: "open" });
    const task = getTask(filePath, "MYAPP-1");
    expect(task!.mrs).toEqual([{ url: "https://gitlab.com/mr/1", state: "open" }]);
  });

  test("updateTask throws on missing task", () => {
    expect(() => updateTask(filePath, "NOPE", { status: "in_progress" })).toThrow("not found");
  });

  test("removeTask deletes a task", () => {
    createTask(filePath, { ticket: "MYAPP-1", source: "linear" });
    removeTask(filePath, "MYAPP-1");
    expect(getTask(filePath, "MYAPP-1")).toBeNull();
  });

  test("listTasks returns all tasks", () => {
    createTask(filePath, { ticket: "MYAPP-1", source: "linear" });
    createTask(filePath, { ticket: "MYAPP-2", source: "linear", title: "Other" });
    const tasks = listTasks(filePath);
    expect(Object.keys(tasks)).toEqual(["MYAPP-1", "MYAPP-2"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/task-registry.test.ts`
Expected: FAIL — module `../task-registry` does not exist

- [ ] **Step 3: Implement task-registry.ts**

```typescript
// src/task-registry.ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

export interface MrEntry {
  url: string;
  state: string; // "open" | "merged" | "closed"
}

export type TaskStatus = "pickup" | "in_progress" | "review" | "merged" | "closed";

export interface TaskEntry {
  source: string;
  externalId: string;
  url: string;
  title: string;
  session: string | null;
  worktree: string | null;
  project: string;
  mrs: MrEntry[];
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRegistry {
  tasks: Record<string, TaskEntry>;
}

export const DEFAULT_REGISTRY_PATH = resolve(homedir(), ".config", "jmux", "tasks.json");

export function loadRegistry(filePath: string): TaskRegistry {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8")) as TaskRegistry;
    }
  } catch {
    // Corrupt file — return empty
  }
  return { tasks: {} };
}

export function saveRegistry(filePath: string, registry: TaskRegistry): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + `.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, filePath);
}

export interface CreateTaskOpts {
  ticket: string;
  source: string;
  externalId?: string;
  url?: string;
  title?: string;
  session?: string;
  worktree?: string;
  project?: string;
}

export function createTask(filePath: string, opts: CreateTaskOpts): TaskEntry {
  const reg = loadRegistry(filePath);
  if (reg.tasks[opts.ticket]) {
    throw new Error(`Task "${opts.ticket}" already exists`);
  }
  const now = new Date().toISOString();
  const entry: TaskEntry = {
    source: opts.source,
    externalId: opts.externalId ?? "",
    url: opts.url ?? "",
    title: opts.title ?? "",
    session: opts.session ?? null,
    worktree: opts.worktree ?? null,
    project: opts.project ?? "",
    mrs: [],
    status: "pickup",
    createdAt: now,
    updatedAt: now,
  };
  reg.tasks[opts.ticket] = entry;
  saveRegistry(filePath, reg);
  return entry;
}

export function getTask(filePath: string, ticket: string): TaskEntry | null {
  const reg = loadRegistry(filePath);
  return reg.tasks[ticket] ?? null;
}

export interface UpdateTaskOpts {
  status?: TaskStatus;
  session?: string;
  worktree?: string;
  mr?: string;
  mrState?: string;
  title?: string;
  externalId?: string;
  url?: string;
  project?: string;
}

export function updateTask(filePath: string, ticket: string, opts: UpdateTaskOpts): TaskEntry {
  const reg = loadRegistry(filePath);
  const task = reg.tasks[ticket];
  if (!task) {
    throw new Error(`Task "${ticket}" not found`);
  }
  if (opts.status !== undefined) task.status = opts.status;
  if (opts.session !== undefined) task.session = opts.session;
  if (opts.worktree !== undefined) task.worktree = opts.worktree;
  if (opts.title !== undefined) task.title = opts.title;
  if (opts.externalId !== undefined) task.externalId = opts.externalId;
  if (opts.url !== undefined) task.url = opts.url;
  if (opts.project !== undefined) task.project = opts.project;
  if (opts.mr) {
    task.mrs.push({ url: opts.mr, state: opts.mrState ?? "open" });
  }
  task.updatedAt = new Date().toISOString();
  reg.tasks[ticket] = task;
  saveRegistry(filePath, reg);
  return task;
}

export function removeTask(filePath: string, ticket: string): void {
  const reg = loadRegistry(filePath);
  if (!reg.tasks[ticket]) {
    throw new Error(`Task "${ticket}" not found`);
  }
  delete reg.tasks[ticket];
  saveRegistry(filePath, reg);
}

export function listTasks(filePath: string): Record<string, TaskEntry> {
  const reg = loadRegistry(filePath);
  return reg.tasks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/task-registry.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/task-registry.ts src/__tests__/task-registry.test.ts
git commit -m "feat: add task registry with CRUD operations and atomic writes"
```

---

### Task 2: CLI — `jmux ctl task` Subcommands

**Files:**
- Create: `src/cli/task.ts`
- Create: `src/__tests__/cli/task.test.ts`
- Modify: `src/cli.ts:14` (add "task" to KNOWN_GROUPS)
- Modify: `src/cli.ts:19-31` (add new flags to VALUE_FLAGS/BOOL_FLAGS)
- Modify: `src/cli.ts:170-185` (add task case to switch)

- [ ] **Step 1: Write failing tests for task CLI handler**

```typescript
// src/__tests__/cli/task.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { handleTask } from "../../cli/task";
import { loadRegistry } from "../../task-registry";
import type { CliContext } from "../../cli/context";
import type { ParsedCtlArgs } from "../../cli";

function makeCtx(): CliContext {
  return { socket: null, paneId: null, sessionOverride: null, insideTmux: false, insideJmux: false };
}

function makeParsed(action: string, flags: Record<string, string | boolean> = {}): ParsedCtlArgs {
  return { group: "task", action, flags, positional: [] };
}

describe("handleTask", () => {
  let dir: string;
  let registryPath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "jmux-task-cli-"));
    registryPath = resolve(dir, "tasks.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("create registers a new task", () => {
    const result = handleTask(makeCtx(), makeParsed("create", {
      ticket: "MYAPP-1",
      source: "linear",
      title: "Fix bug",
      project: "myapp",
    }), registryPath) as any;
    expect(result.ticket).toBe("MYAPP-1");
    expect(result.status).toBe("pickup");

    const reg = loadRegistry(registryPath);
    expect(reg.tasks["MYAPP-1"]).toBeDefined();
  });

  test("create requires --ticket", () => {
    expect(() => handleTask(makeCtx(), makeParsed("create", { source: "linear" }), registryPath)).toThrow("--ticket");
  });

  test("create requires --source", () => {
    expect(() => handleTask(makeCtx(), makeParsed("create", { ticket: "X-1" }), registryPath)).toThrow("--source");
  });

  test("list returns all tasks", () => {
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-1", source: "linear" }), registryPath);
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-2", source: "linear" }), registryPath);
    const result = handleTask(makeCtx(), makeParsed("list"), registryPath) as any;
    expect(Object.keys(result.tasks)).toEqual(["X-1", "X-2"]);
  });

  test("get returns a single task", () => {
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-1", source: "linear", title: "Hello" }), registryPath);
    const result = handleTask(makeCtx(), makeParsed("get", { ticket: "X-1" }), registryPath) as any;
    expect(result.title).toBe("Hello");
  });

  test("get throws on missing task", () => {
    expect(() => handleTask(makeCtx(), makeParsed("get", { ticket: "NOPE" }), registryPath)).toThrow("not found");
  });

  test("update modifies task fields", () => {
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-1", source: "linear" }), registryPath);
    const result = handleTask(makeCtx(), makeParsed("update", { ticket: "X-1", status: "in_progress", session: "x-1" }), registryPath) as any;
    expect(result.status).toBe("in_progress");
    expect(result.session).toBe("x-1");
  });

  test("update adds MR", () => {
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-1", source: "linear" }), registryPath);
    handleTask(makeCtx(), makeParsed("update", { ticket: "X-1", mr: "https://example.com/mr/1" }), registryPath);
    const task = loadRegistry(registryPath).tasks["X-1"];
    expect(task.mrs).toHaveLength(1);
    expect(task.mrs[0].url).toBe("https://example.com/mr/1");
  });

  test("remove deletes a task", () => {
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-1", source: "linear" }), registryPath);
    handleTask(makeCtx(), makeParsed("remove", { ticket: "X-1" }), registryPath);
    const reg = loadRegistry(registryPath);
    expect(reg.tasks["X-1"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/cli/task.test.ts`
Expected: FAIL — module `../../cli/task` does not exist

- [ ] **Step 3: Implement cli/task.ts**

```typescript
// src/cli/task.ts
import { CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";
import {
  createTask,
  getTask,
  updateTask,
  removeTask,
  listTasks,
  DEFAULT_REGISTRY_PATH,
  type TaskStatus,
} from "../task-registry";

const VALID_STATUSES = new Set(["pickup", "in_progress", "review", "merged", "closed"]);

export function handleTask(ctx: CliContext, parsed: ParsedCtlArgs, registryPath?: string): unknown {
  const { action, flags } = parsed;
  const path = registryPath ?? DEFAULT_REGISTRY_PATH;

  switch (action) {
    case "create": {
      if (!flags.ticket || typeof flags.ticket !== "string") {
        throw new CliError("--ticket is required");
      }
      if (!flags.source || typeof flags.source !== "string") {
        throw new CliError("--source is required");
      }
      const entry = createTask(path, {
        ticket: flags.ticket,
        source: flags.source,
        title: typeof flags.title === "string" ? flags.title : undefined,
        session: typeof flags.session === "string" ? flags.session : undefined,
        project: typeof flags.project === "string" ? flags.project : undefined,
        externalId: typeof flags["external-id"] === "string" ? flags["external-id"] : undefined,
        url: typeof flags.url === "string" ? flags.url : undefined,
      });
      return { ticket: flags.ticket, ...entry };
    }

    case "list": {
      const tasks = listTasks(path);
      return { tasks };
    }

    case "get": {
      if (!flags.ticket || typeof flags.ticket !== "string") {
        throw new CliError("--ticket is required");
      }
      const task = getTask(path, flags.ticket);
      if (!task) {
        throw new CliError(`Task "${flags.ticket}" not found`);
      }
      return { ticket: flags.ticket, ...task };
    }

    case "update": {
      if (!flags.ticket || typeof flags.ticket !== "string") {
        throw new CliError("--ticket is required");
      }
      const status = typeof flags.status === "string" ? flags.status : undefined;
      if (status && !VALID_STATUSES.has(status)) {
        throw new CliError(`Invalid status "${status}". Valid: ${[...VALID_STATUSES].join(", ")}`);
      }
      const entry = updateTask(path, flags.ticket, {
        status: status as TaskStatus | undefined,
        session: typeof flags.session === "string" ? flags.session : undefined,
        mr: typeof flags.mr === "string" ? flags.mr : undefined,
        mrState: typeof flags["mr-state"] === "string" ? flags["mr-state"] : undefined,
        title: typeof flags.title === "string" ? flags.title : undefined,
        worktree: typeof flags.worktree === "string" ? flags.worktree : undefined,
        project: typeof flags.project === "string" ? flags.project : undefined,
      });
      return { ticket: flags.ticket, ...entry };
    }

    case "remove": {
      if (!flags.ticket || typeof flags.ticket !== "string") {
        throw new CliError("--ticket is required");
      }
      removeTask(path, flags.ticket);
      return { removed: flags.ticket };
    }

    default:
      throw new CliError(
        `Unknown task action "${action}". Known actions: create, list, get, update, remove`,
      );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/cli/task.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Wire task into cli.ts**

In `src/cli.ts`, make these changes:

Add import at the top (after line 5):
```typescript
import { handleTask } from "./cli/task";
```

Add `"task"` to KNOWN_GROUPS (line 14):
```typescript
const KNOWN_GROUPS = ["session", "window", "pane", "run-claude", "task"] as const;
```

Add new value flags (extend the VALUE_FLAGS set, around line 19-30):
```typescript
const VALUE_FLAGS = new Set([
  "name",
  "dir",
  "target",
  "direction",
  "command",
  "message",
  "message-file",
  "file",
  "lines",
  "window",
  "ticket",
  "source",
  "status",
  "mr",
  "mr-state",
  "external-id",
  "url",
  "project",
  "base-branch",
]);
```

Add `"worktree"` to BOOL_FLAGS (line 31):
```typescript
const BOOL_FLAGS = new Set(["force", "no-enter", "enter", "raw", "clear", "stdin", "worktree"]);
```

Add task case in the switch (around line 180):
```typescript
      case "task":
        result = handleTask(ctx, parsed);
        break;
```

Update the help text `CTL_HELP` (around line 39) to include the `task` group:
```
  task       Manage tracked work items
```

And add the new flags to the help text:
```
  --ticket <val>       Ticket ID (e.g. MYAPP-123)
  --source <val>       Issue tracker (linear, github, etc.)
  --status <val>       Task status (pickup|in_progress|review|merged|closed)
  --mr <val>           Merge request URL
  --mr-state <val>     MR state (open|merged|closed)
  --external-id <val>  External issue ID (UUID)
  --url <val>          Issue URL
  --project <val>      Project name
  --base-branch <val>  Base branch for worktree
  --worktree           Create a git worktree
```

- [ ] **Step 6: Run all CLI tests**

Run: `bun test src/__tests__/cli/`
Expected: All tests PASS (existing + new)

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/cli/task.ts src/__tests__/cli/task.test.ts src/cli.ts
git commit -m "feat: add jmux ctl task subcommands for work item tracking"
```

---

### Task 3: CLI — `session create --worktree`

**Files:**
- Modify: `src/cli/session.ts:41-56` (extend validateSessionCreate)
- Modify: `src/cli/session.ts:73-96` (extend create handler)
- Modify: `src/__tests__/cli/session.test.ts` (add worktree validation tests)

- [ ] **Step 1: Write failing tests for worktree validation**

Add to `src/__tests__/cli/session.test.ts`:

```typescript
describe("validateSessionCreate with worktree", () => {
  test("worktree requires --base-branch", () => {
    expect(() =>
      validateSessionCreate({ name: "foo", dir: "/tmp/repo", worktree: true })
    ).toThrow("--base-branch");
  });

  test("worktree returns baseBranch", () => {
    const result = validateSessionCreate({
      name: "foo",
      dir: "/tmp/repo",
      worktree: true,
      "base-branch": "origin/main",
    });
    expect(result.worktree).toBe(true);
    expect(result.baseBranch).toBe("origin/main");
  });

  test("non-worktree does not require base-branch", () => {
    const result = validateSessionCreate({ name: "foo", dir: "/tmp" });
    expect(result.worktree).toBeUndefined();
    expect(result.baseBranch).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/cli/session.test.ts`
Expected: FAIL — `worktree` property doesn't exist on return type

- [ ] **Step 3: Extend validateSessionCreate**

In `src/cli/session.ts`, update `validateSessionCreate` (lines 41-56):

```typescript
export function validateSessionCreate(flags: Record<string, string | boolean>): {
  name: string;
  dir: string;
  command?: string;
  worktree?: boolean;
  baseBranch?: string;
} {
  if (!flags.name || typeof flags.name !== "string") {
    throw new CliError("--name is required");
  }
  if (!flags.dir || typeof flags.dir !== "string") {
    throw new CliError("--dir is required");
  }
  const name = sanitizeTmuxSessionName(flags.name);
  const dir = flags.dir;
  const command = typeof flags.command === "string" ? flags.command : undefined;

  if (flags.worktree) {
    if (!flags["base-branch"] || typeof flags["base-branch"] !== "string") {
      throw new CliError("--base-branch is required when using --worktree");
    }
    return { name, dir, ...(command !== undefined ? { command } : {}), worktree: true, baseBranch: flags["base-branch"] };
  }

  return { name, dir, ...(command !== undefined ? { command } : {}) };
}
```

- [ ] **Step 4: Extend the create handler to support worktrees**

In `src/cli/session.ts`, update the `case "create"` block (lines 73-96):

```typescript
    case "create": {
      const { name, dir, command, worktree, baseBranch } = validateSessionCreate(flags);
      const otel = buildOtelResourceAttrs(name);

      let sessionDir = dir;

      if (worktree && baseBranch) {
        // Create git worktree: git worktree add <dir>/<name> <baseBranch>
        const worktreePath = resolve(dir, name);
        const wtResult = Bun.spawnSync(
          ["git", "worktree", "add", worktreePath, baseBranch],
          { cwd: dir, stdout: "pipe", stderr: "pipe" },
        );
        if (wtResult.exitCode !== 0) {
          const stderr = wtResult.stderr.toString().trim();
          throw new CliError(`git worktree add failed: ${stderr}`);
        }
        sessionDir = worktreePath;
      }

      const createArgs = ["new-session", "-d", "-e", `OTEL_RESOURCE_ATTRIBUTES=${otel}`, "-s", name, "-c", sessionDir];
      if (command) {
        createArgs.push(command);
      }

      tmuxOrThrow(runTmuxDirect(createArgs, ctx.socket));

      // Resolve the session ID
      const idResult = runTmuxDirect(
        ["list-sessions", "-F", "#{session_id}:#{session_name}", "-f", `#{==:#{session_name},${name}}`],
        ctx.socket,
      );
      let id: string | null = null;
      if (idResult.ok && idResult.lines.length > 0) {
        const parts = idResult.lines[0].split(":");
        id = parts[0];
      }

      return { name, id, ...(worktree ? { worktree: sessionDir } : {}) };
    }
```

Add the `resolve` import at the top of session.ts:
```typescript
import { resolve } from "path";
```

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/cli/session.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/cli/session.ts src/__tests__/cli/session.test.ts
git commit -m "feat: add --worktree flag to session create for programmatic worktree setup"
```

---

### Task 4: Tool Panel Container

**Files:**
- Create: `src/tool-panel.ts`
- Create: `src/__tests__/tool-panel.test.ts`

This is the new layer that wraps the existing diff panel and will also host the agent tab. For now, it manages tab state and tab bar rendering. It does NOT touch the diff panel internals.

- [ ] **Step 1: Write failing tests for tool panel state and tab bar**

```typescript
// src/__tests__/tool-panel.test.ts
import { describe, test, expect } from "bun:test";
import { ToolPanel } from "../tool-panel";

describe("ToolPanel state", () => {
  test("starts with diff tab active", () => {
    const panel = new ToolPanel();
    expect(panel.activeTab).toBe("diff");
  });

  test("switchTab changes active tab", () => {
    const panel = new ToolPanel();
    panel.switchTab("agent");
    expect(panel.activeTab).toBe("agent");
    panel.switchTab("diff");
    expect(panel.activeTab).toBe("diff");
  });

  test("nextTab cycles through tabs", () => {
    const panel = new ToolPanel();
    expect(panel.activeTab).toBe("diff");
    panel.nextTab();
    expect(panel.activeTab).toBe("agent");
    panel.nextTab();
    expect(panel.activeTab).toBe("diff");
  });
});

describe("ToolPanel tab bar", () => {
  test("renderTabBar produces a grid row", () => {
    const panel = new ToolPanel();
    const grid = panel.renderTabBar(40);
    expect(grid.cols).toBe(40);
    expect(grid.rows).toBe(1);
    const text = grid.cells[0].map(c => c.char).join("");
    expect(text).toContain("Diff");
    expect(text).toContain("Agent");
  });

  test("active tab is highlighted", () => {
    const panel = new ToolPanel();
    const grid1 = panel.renderTabBar(40);
    // Find the 'D' of 'Diff' — it should be bold (active)
    const diffDIdx = grid1.cells[0].findIndex(c => c.char === "D");
    expect(grid1.cells[0][diffDIdx].bold).toBe(true);

    panel.switchTab("agent");
    const grid2 = panel.renderTabBar(40);
    const agentAIdx = grid2.cells[0].findIndex(c => c.char === "A");
    expect(grid2.cells[0][agentAIdx].bold).toBe(true);
    // Diff should no longer be bold
    const diffDIdx2 = grid2.cells[0].findIndex(c => c.char === "D");
    expect(grid2.cells[0][diffDIdx2].bold).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/tool-panel.test.ts`
Expected: FAIL — module `../tool-panel` does not exist

- [ ] **Step 3: Implement tool-panel.ts**

```typescript
// src/tool-panel.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

export type PanelTab = "diff" | "agent";

const TABS: PanelTab[] = ["diff", "agent"];
const TAB_LABELS: Record<PanelTab, string> = { diff: "Diff", agent: "Agent" };

const ACTIVE_TAB_ATTRS: CellAttrs = { bold: true, fg: 15, fgMode: ColorMode.Palette };
const INACTIVE_TAB_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };
const TAB_BAR_BG: CellAttrs = { bg: (0x1a << 16) | (0x1a << 8) | 0x1a, bgMode: ColorMode.RGB };
const SEPARATOR_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette };

export class ToolPanel {
  private _activeTab: PanelTab = "diff";

  get activeTab(): PanelTab {
    return this._activeTab;
  }

  switchTab(tab: PanelTab): void {
    this._activeTab = tab;
  }

  nextTab(): void {
    const idx = TABS.indexOf(this._activeTab);
    this._activeTab = TABS[(idx + 1) % TABS.length];
  }

  renderTabBar(cols: number): CellGrid {
    const grid = createGrid(cols, 1);

    // Fill background
    const bgFill = " ".repeat(cols);
    writeString(grid, 0, 0, bgFill, TAB_BAR_BG);

    let col = 1; // start with a space padding
    for (let i = 0; i < TABS.length; i++) {
      const tab = TABS[i];
      const label = TAB_LABELS[tab];
      const isActive = tab === this._activeTab;
      const attrs: CellAttrs = {
        ...(isActive ? ACTIVE_TAB_ATTRS : INACTIVE_TAB_ATTRS),
        ...TAB_BAR_BG,
      };
      writeString(grid, 0, col, label, attrs);
      col += label.length;

      if (i < TABS.length - 1) {
        writeString(grid, 0, col + 1, "|", { ...SEPARATOR_ATTRS, ...TAB_BAR_BG });
        col += 3; // space + separator + space
      }
    }

    return grid;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/tool-panel.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/tool-panel.ts src/__tests__/tool-panel.test.ts
git commit -m "feat: add tool panel container with tab bar for diff and agent tabs"
```

---

### Task 5: Wire Tool Panel into main.ts and Renderer

**Files:**
- Modify: `src/main.ts` (replace direct diffPanel references with toolPanel wrapper)
- Modify: `src/input-router.ts` (add agent tab prefix key and tab switching)
- Modify: `src/renderer.ts` (composite tab bar row above panel content)

This is the integration task. The goal: the existing diff panel behavior is fully preserved, but a tab bar appears above it, and `Ctrl-a m` opens the panel to the agent tab (which shows an empty placeholder for now).

- [ ] **Step 1: Add tool panel to main.ts**

In `src/main.ts`, add import near the top:
```typescript
import { ToolPanel } from "./tool-panel";
```

Near the existing `const diffPanel = new DiffPanel();` (line ~321), add:
```typescript
const toolPanel = new ToolPanel();
```

- [ ] **Step 2: Add prefix key for agent tab**

In `src/input-router.ts`, add a new callback to `InputRouterOptions` (around line 42):
```typescript
  onAgentToggle?: () => void;
  onPanelTabSwitch?: () => void;
```

In the prefix handling block (after the `"g"` check around line 128-131), add:
```typescript
        if (data === "m") {
          this.opts.onAgentToggle?.();
          return;
        }
```

And for tab switching within the panel (after the `"\t"` check around line 136-139), update the existing Tab handler to also support tab switching:
```typescript
        if (data === "\t" && this.diffPanelCols > 0) {
          if (this.diffPanelFocused) {
            this.opts.onPanelTabSwitch?.();
          } else {
            this.opts.onDiffPanelFocusToggle?.();
          }
          return;
        }
```

- [ ] **Step 3: Wire callbacks in main.ts**

Where the `InputRouter` is instantiated in `main.ts`, add the new callbacks:

```typescript
onAgentToggle: () => {
  if (!diffPanel.isActive()) {
    toggleDiffPanel(); // opens the panel
  }
  toolPanel.switchTab("agent");
  scheduleRender();
},
onPanelTabSwitch: () => {
  toolPanel.nextTab();
  scheduleRender();
},
```

- [ ] **Step 4: Modify renderFrame to include tab bar**

In `main.ts`'s `renderFrame()` function, where `diffPanelArg` is constructed (around line 645), wrap the existing diff panel grid with the tab bar. When the tool panel's active tab is "diff", use the existing diff grid. When it's "agent", use a placeholder empty grid.

After the existing `diffPanelArg` construction, add tab bar compositing:

```typescript
  // Composite tab bar above the panel content
  if (diffPanelArg) {
    const tabBarGrid = toolPanel.renderTabBar(diffPanelArg.grid.cols);
    // Create a new grid with tab bar row + panel content
    const panelRows = diffPanelArg.grid.rows;
    const withTabBar = createGrid(diffPanelArg.grid.cols, panelRows);
    // Row 0: tab bar
    for (let x = 0; x < tabBarGrid.cols; x++) {
      withTabBar.cells[0][x] = { ...tabBarGrid.cells[0][x] };
    }
    // Rows 1+: panel content (shifted up by 1 since we stole a row for the tab bar)
    for (let y = 1; y < panelRows; y++) {
      for (let x = 0; x < diffPanelArg.grid.cols; x++) {
        if (diffPanelArg.grid.cells[y - 1]?.[x]) {
          withTabBar.cells[y][x] = { ...diffPanelArg.grid.cells[y - 1][x] };
        }
      }
    }
    diffPanelArg = { ...diffPanelArg, grid: withTabBar };
  }
```

Note: This approach reuses the existing `diffPanelArg` plumbing — the renderer doesn't need changes. The tab bar is composited into the grid before it reaches `compositeGrids()`.

- [ ] **Step 5: Handle agent tab placeholder when active tab is "agent"**

When `toolPanel.activeTab === "agent"` and the panel is open, show a placeholder instead of the diff content. In the `renderFrame()` function, before the tab bar compositing:

```typescript
  // When agent tab is active, show placeholder instead of diff content
  if (diffPanel.isActive() && toolPanel.activeTab === "agent") {
    const dpCols = getDiffPanelCols();
    const dpRows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
    const placeholderGrid = createGrid(dpCols, dpRows);
    const centerRow = Math.floor(dpRows / 2);
    const hint = "Agent tab — coming soon";
    const col = Math.max(0, Math.floor((dpCols - hint.length) / 2));
    writeString(placeholderGrid, centerRow, col, hint, { fg: 8, fgMode: ColorMode.Palette, dim: true });
    diffPanelArg = { grid: placeholderGrid, mode: diffPanel.state as "split" | "full", focused: diffPanelFocused };
  }
```

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: All tests PASS (no regressions)

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 8: Manual test**

Run: `bun run dev`
- Press `Ctrl-a g` to open the diff panel — should see tab bar with [Diff] [Agent], Diff active
- Press `Ctrl-a m` — panel opens to Agent tab showing "Agent tab — coming soon"
- Press `Ctrl-a Tab` while panel focused — cycles between Diff and Agent tabs
- Press `Ctrl-a g` — closes panel (existing behavior preserved)

- [ ] **Step 9: Commit**

```bash
git add src/main.ts src/input-router.ts src/tool-panel.ts
git commit -m "feat: wire tool panel into main rendering with tab bar and agent placeholder"
```

---

### Task 6: Agent Tab — Claude Code Subprocess and Chat Rendering

**Files:**
- Create: `src/agent-tab.ts`
- Create: `src/__tests__/agent-tab.test.ts`

This is the riskiest and most complex piece. The agent tab manages: a single-line input editor, a scrollback buffer, and spawning Claude Code subprocesses in `--output-format stream-json` mode.

- [ ] **Step 1: Write failing tests for the input line editor**

```typescript
// src/__tests__/agent-tab.test.ts
import { describe, test, expect } from "bun:test";
import { InputLine } from "../agent-tab";

describe("InputLine", () => {
  test("starts empty", () => {
    const line = new InputLine();
    expect(line.text).toBe("");
    expect(line.cursor).toBe(0);
  });

  test("insert adds characters at cursor", () => {
    const line = new InputLine();
    line.insert("h");
    line.insert("i");
    expect(line.text).toBe("hi");
    expect(line.cursor).toBe(2);
  });

  test("backspace deletes before cursor", () => {
    const line = new InputLine();
    line.insert("abc");
    line.backspace();
    expect(line.text).toBe("ab");
    expect(line.cursor).toBe(2);
  });

  test("backspace at start does nothing", () => {
    const line = new InputLine();
    line.backspace();
    expect(line.text).toBe("");
  });

  test("left/right move cursor", () => {
    const line = new InputLine();
    line.insert("abc");
    line.left();
    expect(line.cursor).toBe(2);
    line.left();
    expect(line.cursor).toBe(1);
    line.right();
    expect(line.cursor).toBe(2);
  });

  test("home/end move to boundaries", () => {
    const line = new InputLine();
    line.insert("abc");
    line.home();
    expect(line.cursor).toBe(0);
    line.end();
    expect(line.cursor).toBe(3);
  });

  test("submit returns text and clears", () => {
    const line = new InputLine();
    line.insert("hello world");
    const text = line.submit();
    expect(text).toBe("hello world");
    expect(line.text).toBe("");
    expect(line.cursor).toBe(0);
  });

  test("delete removes character at cursor", () => {
    const line = new InputLine();
    line.insert("abc");
    line.home();
    line.del();
    expect(line.text).toBe("bc");
    expect(line.cursor).toBe(0);
  });

  test("insert in middle pushes text right", () => {
    const line = new InputLine();
    line.insert("ac");
    line.left();
    line.insert("b");
    expect(line.text).toBe("abc");
    expect(line.cursor).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/agent-tab.test.ts`
Expected: FAIL — module `../agent-tab` does not exist

- [ ] **Step 3: Write failing tests for scrollback buffer and message rendering**

Add to `src/__tests__/agent-tab.test.ts`:

```typescript
import { ScrollbackBuffer, type ChatMessage } from "../agent-tab";

describe("ScrollbackBuffer", () => {
  test("starts empty", () => {
    const buf = new ScrollbackBuffer();
    expect(buf.messages).toEqual([]);
  });

  test("addUserMessage appends user message", () => {
    const buf = new ScrollbackBuffer();
    buf.addUserMessage("hello");
    expect(buf.messages).toHaveLength(1);
    expect(buf.messages[0]).toEqual({ role: "user", content: "hello" });
  });

  test("addAssistantMessage appends assistant message", () => {
    const buf = new ScrollbackBuffer();
    buf.addAssistantMessage("hi back");
    expect(buf.messages).toHaveLength(1);
    expect(buf.messages[0]).toEqual({ role: "assistant", content: "hi back" });
  });

  test("addToolUse appends tool indicator", () => {
    const buf = new ScrollbackBuffer();
    buf.addToolUse("jmux ctl task create --ticket X-1");
    expect(buf.messages).toHaveLength(1);
    expect(buf.messages[0]).toEqual({ role: "tool", content: "jmux ctl task create --ticket X-1" });
  });

  test("appendToLast extends last assistant message", () => {
    const buf = new ScrollbackBuffer();
    buf.addAssistantMessage("hel");
    buf.appendToLast("lo");
    expect(buf.messages[0].content).toBe("hello");
  });

  test("getContextSummary returns last N exchanges", () => {
    const buf = new ScrollbackBuffer();
    buf.addUserMessage("msg1");
    buf.addAssistantMessage("resp1");
    buf.addUserMessage("msg2");
    buf.addAssistantMessage("resp2");
    buf.addUserMessage("msg3");
    buf.addAssistantMessage("resp3");
    const summary = buf.getContextSummary(2); // last 2 exchanges
    expect(summary).toHaveLength(4); // 2 user + 2 assistant
    expect(summary[0].content).toBe("msg2");
  });

  test("renderToLines wraps text to width", () => {
    const buf = new ScrollbackBuffer();
    buf.addUserMessage("hello world this is a long message");
    const lines = buf.renderToLines(20);
    // "you: " prefix + text = wrapping at 20 cols
    expect(lines.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 4: Implement agent-tab.ts**

```typescript
// src/agent-tab.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

// --- Input Line Editor ---

export class InputLine {
  private _text = "";
  private _cursor = 0;

  get text(): string { return this._text; }
  get cursor(): number { return this._cursor; }

  insert(chars: string): void {
    this._text = this._text.slice(0, this._cursor) + chars + this._text.slice(this._cursor);
    this._cursor += chars.length;
  }

  backspace(): void {
    if (this._cursor > 0) {
      this._text = this._text.slice(0, this._cursor - 1) + this._text.slice(this._cursor);
      this._cursor--;
    }
  }

  del(): void {
    if (this._cursor < this._text.length) {
      this._text = this._text.slice(0, this._cursor) + this._text.slice(this._cursor + 1);
    }
  }

  left(): void {
    if (this._cursor > 0) this._cursor--;
  }

  right(): void {
    if (this._cursor < this._text.length) this._cursor++;
  }

  home(): void { this._cursor = 0; }
  end(): void { this._cursor = this._text.length; }

  submit(): string {
    const text = this._text;
    this._text = "";
    this._cursor = 0;
    return text;
  }

  clear(): void {
    this._text = "";
    this._cursor = 0;
  }
}

// --- Scrollback Buffer ---

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}

export class ScrollbackBuffer {
  private _messages: ChatMessage[] = [];

  get messages(): readonly ChatMessage[] {
    return this._messages;
  }

  addUserMessage(content: string): void {
    this._messages.push({ role: "user", content });
  }

  addAssistantMessage(content: string): void {
    this._messages.push({ role: "assistant", content });
  }

  addToolUse(content: string): void {
    this._messages.push({ role: "tool", content });
  }

  appendToLast(text: string): void {
    if (this._messages.length > 0) {
      this._messages[this._messages.length - 1].content += text;
    }
  }

  getContextSummary(maxExchanges: number): ChatMessage[] {
    // Collect the last N user/assistant pairs (skip tool messages for context)
    const exchanges: ChatMessage[] = [];
    let count = 0;
    for (let i = this._messages.length - 1; i >= 0 && count < maxExchanges * 2; i--) {
      const msg = this._messages[i];
      if (msg.role === "user" || msg.role === "assistant") {
        exchanges.unshift(msg);
        count++;
      }
    }
    return exchanges;
  }

  renderToLines(width: number): { text: string; attrs: CellAttrs }[] {
    const lines: { text: string; attrs: CellAttrs }[] = [];
    const userAttrs: CellAttrs = { bold: true, fg: 4, fgMode: ColorMode.Palette };
    const assistantAttrs: CellAttrs = { fg: 15, fgMode: ColorMode.Palette };
    const toolAttrs: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };

    for (const msg of this._messages) {
      let prefix: string;
      let attrs: CellAttrs;
      if (msg.role === "user") {
        prefix = "you: ";
        attrs = userAttrs;
      } else if (msg.role === "assistant") {
        prefix = "";
        attrs = assistantAttrs;
      } else {
        prefix = "[tool: ";
        attrs = toolAttrs;
      }
      const suffix = msg.role === "tool" ? "]" : "";
      const fullText = prefix + msg.content + suffix;

      // Word-wrap at width
      let remaining = fullText;
      while (remaining.length > 0) {
        if (remaining.length <= width) {
          lines.push({ text: remaining, attrs });
          remaining = "";
        } else {
          // Find last space within width, or force-break
          let breakAt = remaining.lastIndexOf(" ", width);
          if (breakAt <= 0) breakAt = width;
          lines.push({ text: remaining.slice(0, breakAt), attrs });
          remaining = remaining.slice(breakAt).trimStart();
        }
      }
      // Empty line between messages
      lines.push({ text: "", attrs: assistantAttrs });
    }
    return lines;
  }
}

// --- Agent Tab State ---

export type AgentState = "idle" | "streaming" | "error";

const INPUT_PROMPT_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const INPUT_TEXT_ATTRS: CellAttrs = { fg: 15, fgMode: ColorMode.Palette };
const PLACEHOLDER_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const SPINNER_ATTRS: CellAttrs = { fg: 3, fgMode: ColorMode.Palette };

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class AgentTab {
  readonly input = new InputLine();
  readonly scrollback = new ScrollbackBuffer();
  private _state: AgentState = "idle";
  private _scrollOffset = 0; // lines scrolled up from bottom
  private _spinnerFrame = 0;

  get state(): AgentState { return this._state; }
  set state(s: AgentState) { this._state = s; }

  get scrollOffset(): number { return this._scrollOffset; }

  scrollUp(lines = 1): void {
    this._scrollOffset += lines;
  }

  scrollDown(lines = 1): void {
    this._scrollOffset = Math.max(0, this._scrollOffset - lines);
  }

  scrollToBottom(): void {
    this._scrollOffset = 0;
  }

  advanceSpinner(): void {
    this._spinnerFrame = (this._spinnerFrame + 1) % SPINNER_FRAMES.length;
  }

  render(cols: number, rows: number): CellGrid {
    const grid = createGrid(cols, rows);

    // Reserve bottom row for input
    const scrollbackRows = rows - 1;
    const inputRow = rows - 1;

    // Render scrollback
    const allLines = this.scrollback.renderToLines(cols - 1); // 1 col left margin
    const visibleStart = Math.max(0, allLines.length - scrollbackRows - this._scrollOffset);
    const visibleEnd = Math.min(allLines.length, visibleStart + scrollbackRows);

    for (let i = visibleStart; i < visibleEnd; i++) {
      const row = i - visibleStart;
      const line = allLines[i];
      writeString(grid, row, 1, line.text, line.attrs);
    }

    // Render input line
    if (this._state === "streaming") {
      const spinner = SPINNER_FRAMES[this._spinnerFrame];
      writeString(grid, inputRow, 1, spinner + " thinking...", SPINNER_ATTRS);
    } else {
      writeString(grid, inputRow, 1, "▸ ", INPUT_PROMPT_ATTRS);
      if (this.input.text.length === 0) {
        writeString(grid, inputRow, 3, "type a message...", PLACEHOLDER_ATTRS);
      } else {
        writeString(grid, inputRow, 3, this.input.text, INPUT_TEXT_ATTRS);
      }
    }

    return grid;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/__tests__/agent-tab.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/agent-tab.ts src/__tests__/agent-tab.test.ts
git commit -m "feat: add agent tab with input line editor and scrollback buffer"
```

---

### Task 7: Wire Agent Tab into Tool Panel and main.ts

**Files:**
- Modify: `src/main.ts` (replace agent placeholder with real AgentTab rendering and input handling)
- Modify: `src/input-router.ts` (route input to agent tab when focused)

- [ ] **Step 1: Import AgentTab in main.ts**

```typescript
import { AgentTab } from "./agent-tab";
```

Near `const toolPanel = new ToolPanel();`, add:
```typescript
const agentTab = new AgentTab();
```

- [ ] **Step 2: Replace agent placeholder with real rendering**

In `renderFrame()`, replace the placeholder grid code from Task 5 with:

```typescript
  if (diffPanel.isActive() && toolPanel.activeTab === "agent") {
    const dpCols = getDiffPanelCols();
    const dpRows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
    const agentGrid = agentTab.render(dpCols, dpRows);
    diffPanelArg = { grid: agentGrid, mode: diffPanel.state as "split" | "full", focused: diffPanelFocused };
  }
```

- [ ] **Step 3: Route keyboard input to agent tab**

In `src/input-router.ts`, update the diff panel input interception block (around line 262-265). When focused and the agent tab is active, route to a new callback:

Add to `InputRouterOptions`:
```typescript
  onAgentTabData?: (data: string) => void;
  isAgentTabActive?: () => boolean;
```

Update the focused keyboard routing:
```typescript
    if (this.diffPanelFocused && this.diffPanelCols > 0) {
      if (this.opts.isAgentTabActive?.()) {
        this.opts.onAgentTabData?.(data);
      } else {
        this.opts.onDiffPanelData?.(data);
      }
      return;
    }
```

- [ ] **Step 4: Implement agent tab input handling in main.ts**

Wire the new callbacks:

```typescript
isAgentTabActive: () => toolPanel.activeTab === "agent",
onAgentTabData: (data: string) => {
  if (agentTab.state === "streaming") return; // reject input while streaming

  // Enter — submit message
  if (data === "\r" || data === "\n") {
    const text = agentTab.input.submit();
    if (text.trim().length > 0) {
      agentTab.scrollback.addUserMessage(text);
      agentTab.scrollToBottom();
      spawnAgentMessage(text);
    }
    scheduleRender();
    return;
  }

  // Backspace
  if (data === "\x7f" || data === "\b") {
    agentTab.input.backspace();
    scheduleRender();
    return;
  }

  // Delete
  if (data === "\x1b[3~") {
    agentTab.input.del();
    scheduleRender();
    return;
  }

  // Arrow keys
  if (data === "\x1b[D") { agentTab.input.left(); scheduleRender(); return; }
  if (data === "\x1b[C") { agentTab.input.right(); scheduleRender(); return; }
  if (data === "\x1b[H" || data === "\x1b[1~") { agentTab.input.home(); scheduleRender(); return; }
  if (data === "\x1b[F" || data === "\x1b[4~") { agentTab.input.end(); scheduleRender(); return; }

  // Shift+Up/Down for scrollback
  if (data === "\x1b[1;2A") { agentTab.scrollUp(3); scheduleRender(); return; }
  if (data === "\x1b[1;2B") { agentTab.scrollDown(3); scheduleRender(); return; }

  // Printable characters
  if (data.length > 0 && data.charCodeAt(0) >= 32) {
    agentTab.input.insert(data);
    scheduleRender();
    return;
  }
},
```

- [ ] **Step 5: Add placeholder spawnAgentMessage function**

```typescript
async function spawnAgentMessage(userMessage: string): Promise<void> {
  agentTab.state = "streaming";
  scheduleRender();

  // TODO: Task 8 will implement the actual Claude Code subprocess spawning
  // For now, simulate a response after a short delay
  setTimeout(() => {
    agentTab.scrollback.addAssistantMessage("Agent not yet connected. The meta agent will be wired up in the next task.");
    agentTab.state = "idle";
    scheduleRender();
  }, 500);
}
```

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 8: Manual test**

Run: `bun run dev`
- Press `Ctrl-a m` to open agent tab
- Type text — should appear in the input line
- Press Enter — message appears in scrollback, brief "thinking..." spinner, then placeholder response
- Arrow keys move cursor in input line
- Shift+Up/Down scrolls the scrollback
- `Ctrl-a Tab` switches between Diff and Agent tabs
- `Ctrl-a g` closes the panel

- [ ] **Step 9: Commit**

```bash
git add src/main.ts src/input-router.ts
git commit -m "feat: wire agent tab rendering and input handling into tool panel"
```

---

### Task 8: Agent Tab — Claude Code Subprocess Spawning

**Files:**
- Modify: `src/agent-tab.ts` (add subprocess management)
- Modify: `src/main.ts` (replace placeholder spawnAgentMessage with real implementation)

- [ ] **Step 1: Add prompt assembly to agent-tab.ts**

Add to `src/agent-tab.ts`:

```typescript
export interface AgentContext {
  metaAgentSkill: string;
  workflowConfigs: { project: string; path: string; content: string }[];
  tasksSnapshot: string; // JSON string of active tasks
  sessionState: string;  // JSON string of jmux ctl session list output
}

export function assemblePrompt(
  ctx: AgentContext,
  scrollback: ScrollbackBuffer,
  userMessage: string,
  maxContextTokensEstimate = 8000,
): string {
  const parts: string[] = [];

  // 1. Meta agent skill (always included)
  parts.push(ctx.metaAgentSkill);

  // 2. Workflow configs (only for active projects)
  if (ctx.workflowConfigs.length > 0) {
    parts.push("\n## Workflow Configs\n");
    for (const wf of ctx.workflowConfigs) {
      parts.push(`### ${wf.project} (${wf.path})\n\`\`\`yaml\n${wf.content}\n\`\`\`\n`);
    }
  }

  // 3. Task snapshot
  if (ctx.tasksSnapshot !== "{}") {
    parts.push(`\n## Active Tasks\n\`\`\`json\n${ctx.tasksSnapshot}\n\`\`\`\n`);
  }

  // 4. Session state
  parts.push(`\n## Current Sessions\n\`\`\`json\n${ctx.sessionState}\n\`\`\`\n`);

  // 5. Scrollback — truncate from oldest if over budget
  // Rough estimate: 4 chars per token
  const baseSize = parts.join("").length;
  const budgetChars = maxContextTokensEstimate * 4;
  const remainingChars = Math.max(0, budgetChars - baseSize - userMessage.length);

  const exchanges = scrollback.getContextSummary(10); // up to 10 exchanges
  let scrollbackText = "";
  if (exchanges.length > 0) {
    const fullScrollback = exchanges.map(m =>
      `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
    ).join("\n\n");

    if (fullScrollback.length <= remainingChars) {
      scrollbackText = fullScrollback;
    } else {
      // Truncate from oldest — take last N that fit
      const msgs = [...exchanges];
      let text = "";
      while (msgs.length > 0) {
        const candidate = msgs.map(m =>
          `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
        ).join("\n\n");
        if (candidate.length <= remainingChars) {
          text = candidate;
          break;
        }
        msgs.shift(); // drop oldest
      }
      scrollbackText = text;
    }
  }

  if (scrollbackText) {
    parts.push(`\n## Conversation History\n${scrollbackText}\n`);
  }

  // 6. User message
  parts.push(`\n## Current Request\n${userMessage}`);

  return parts.join("\n");
}
```

- [ ] **Step 2: Implement spawnAgentMessage in main.ts**

Replace the placeholder `spawnAgentMessage` with the real implementation:

```typescript
async function spawnAgentMessage(userMessage: string): Promise<void> {
  agentTab.state = "streaming";
  agentTab.scrollToBottom();
  scheduleRender();

  // Start spinner animation
  const spinnerInterval = setInterval(() => {
    agentTab.advanceSpinner();
    scheduleRender();
  }, 80);

  try {
    // Assemble context
    const config = loadUserConfig();
    const claudeCmd = config.claudeCommand ?? "claude";

    // Load meta agent skill
    let metaAgentSkill = "";
    const skillPath = resolve(import.meta.dir, "../skills/jmux-meta-agent.md");
    try { metaAgentSkill = readFileSync(skillPath, "utf-8"); } catch {}

    // Load workflow configs from project dirs
    const workflowConfigs: { project: string; path: string; content: string }[] = [];
    for (const dir of cachedProjectDirs) {
      const wfPath = resolve(dir, ".jmux", "workflow.yml");
      try {
        if (existsSync(wfPath)) {
          const content = readFileSync(wfPath, "utf-8");
          const project = dir.split("/").pop() ?? dir;
          workflowConfigs.push({ project, path: wfPath, content });
        }
      } catch {}
    }

    // Load active tasks
    const allTasks = listTasks(DEFAULT_REGISTRY_PATH);
    const activeTasks: Record<string, any> = {};
    for (const [id, task] of Object.entries(allTasks)) {
      if (task.status === "in_progress" || task.status === "review" || task.status === "pickup") {
        activeTasks[id] = task;
      }
    }

    // Get session state
    let sessionState = "[]";
    try {
      const result = Bun.spawnSync(
        [process.argv[0], process.argv[1], "ctl", "session", "list"],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (result.exitCode === 0) {
        sessionState = result.stdout.toString().trim();
      }
    } catch {}

    const prompt = assemblePrompt(
      {
        metaAgentSkill,
        workflowConfigs,
        tasksSnapshot: JSON.stringify(activeTasks, null, 2),
        sessionState,
      },
      agentTab.scrollback,
      userMessage,
    );

    // Write prompt to temp file
    const rand = Math.random().toString(36).slice(2);
    const tempPath = resolve(tmpdir(), `jmux-agent-${Date.now()}-${rand}`);
    writeFileSync(tempPath, prompt, "utf-8");

    // Spawn Claude Code
    const promptContent = readFileSync(tempPath, "utf-8");
    const proc = Bun.spawn(
      [claudeCmd, "--output-format", "stream-json", "-p", promptContent],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      },
    );

    // Stream response
    agentTab.scrollback.addAssistantMessage("");
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    let fullResponse = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      // Parse stream-json lines
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") {
                const newText = block.text.slice(fullResponse.length);
                if (newText) {
                  agentTab.scrollback.appendToLast(newText);
                  fullResponse = block.text;
                  scheduleRender();
                }
              }
            }
          } else if (event.type === "content_block_delta" && event.delta?.text) {
            agentTab.scrollback.appendToLast(event.delta.text);
            fullResponse += event.delta.text;
            scheduleRender();
          } else if (event.type === "result" && event.result) {
            // Tool use indicator
            if (event.subtype === "tool_use") {
              agentTab.scrollback.addToolUse(event.tool_name + (event.tool_input ? ` ${JSON.stringify(event.tool_input).slice(0, 80)}` : ""));
              scheduleRender();
            }
          }
        } catch {
          // Non-JSON line, skip
        }
      }
    }

    // Clean up temp file
    try { await Bun.file(tempPath).exists() && (await import("fs/promises")).unlink(tempPath); } catch {}

  } catch (err) {
    agentTab.scrollback.addAssistantMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    agentTab.state = "error";
  } finally {
    clearInterval(spinnerInterval);
    agentTab.state = "idle";
    scheduleRender();
  }
}
```

Note: The stream-json format from Claude Code may vary. The implementation parses the most common event types. The exact event shapes should be validated during manual testing and adjusted as needed. For very long prompts that exceed shell argument limits, write the prompt to a temp file and use `Bun.spawn` with the file content read into the `-p` argument directly (Bun handles large args without shell interpolation issues).

- [ ] **Step 3: Add required imports to main.ts**

```typescript
import { existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { assemblePrompt, type AgentContext } from "./agent-tab";
import { listTasks, DEFAULT_REGISTRY_PATH } from "./task-registry";
```

(Some of these may already be imported — only add what's missing.)

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Manual test**

Run: `bun run dev`
- Open agent tab with `Ctrl-a m`
- Type "what tasks are currently tracked?" and press Enter
- Should see spinner, then Claude Code response streaming in
- If Claude Code is not installed or no API key configured, should see an error message
- Response should appear word-by-word in the scrollback

- [ ] **Step 7: Commit**

```bash
git add src/agent-tab.ts src/main.ts
git commit -m "feat: wire Claude Code subprocess spawning for meta agent"
```

---

### Task 9: Meta Agent Skill

**Files:**
- Create: `skills/jmux-meta-agent.md`

- [ ] **Step 1: Write the meta agent skill**

```markdown
<!-- skills/jmux-meta-agent.md -->
---
name: jmux-meta-agent
description: Playbook for the jmux workflow copilot — manages tickets, sessions, worktrees, and agent dispatch
---

# jmux Meta Agent

You are the workflow copilot for jmux, a tmux-wrapping TUI for running multiple coding agents in parallel. You help the user manage their development lifecycle: picking up tickets, creating worktrees and sessions, dispatching agents, and tracking work items.

## Your Tools

You interact with jmux exclusively through the `jmux ctl` CLI. All commands output JSON to stdout.

### Task Management

```bash
# Register a new work item
jmux ctl task create --ticket MYAPP-123 --source linear --title "Fix auth" --project myapp

# List all tracked tasks
jmux ctl task list

# Get details for a specific task
jmux ctl task get --ticket MYAPP-123

# Update task state
jmux ctl task update --ticket MYAPP-123 --status in_progress --session myapp-123

# Add an MR to a task
jmux ctl task update --ticket MYAPP-123 --mr https://gitlab.com/.../merge_requests/42

# Remove a completed task
jmux ctl task remove --ticket MYAPP-123
```

### Session Management

```bash
# Create a session with a worktree
jmux ctl session create --name myapp-123 --dir /path/to/repo --worktree --base-branch origin/main

# Create a plain session (no worktree)
jmux ctl session create --name myapp-123 --dir /path/to/project

# List all sessions
jmux ctl session list

# Dispatch Claude Code in a session
jmux ctl run-claude --name myapp-123 --dir /path/to/worktree --message "Your task: ..."
jmux ctl run-claude --name myapp-123 --dir /path/to/worktree --message-file /tmp/prompt.txt
```

### Task Status Values

- `pickup` — ticket registered, session not yet created
- `in_progress` — session created, agent working
- `review` — MR submitted, awaiting review
- `merged` — MR merged
- `closed` — work complete, ready for cleanup

Always update task status when state changes. The task registry is the source of truth for what's happening across sessions.

## Workflow Configs

Projects may have a `.jmux/workflow.yml` file that tells you how to handle tickets for that project. You receive these configs in your context. Key fields:

- `tickets.linear.projects` — which Linear project prefixes this repo handles
- `tickets.linear.team` — which Linear team this repo handles
- `setup.worktree` — whether to create a git worktree (true) or plain session (false)
- `setup.base_branch` — branch to base worktrees on (e.g. "origin/main")
- `setup.naming` — hint for how to name sessions (e.g. "lowercase-ticket-id")
- `agent.context` — text prepended before the ticket description in the agent prompt
- `agent.instructions` — text appended after the ticket description
- `merge_request.target_branch` — MR target branch

When no workflow config exists for a project, ask the user where the ticket should go.

## Picking Up a Ticket

When the user says "pick up MYAPP-123" or gives you a Linear ticket URL:

1. Check `jmux ctl task list` — is this ticket already tracked? If so, report its status.
2. Query Linear (via your MCP tools) to get the ticket title, description, and project.
3. Match the ticket to a repo by checking workflow configs. If no match, ask the user.
4. Register the task: `jmux ctl task create --ticket MYAPP-123 --source linear --title "..." --project myapp`
5. Create the session. Read `setup.worktree` and `setup.base_branch` from the workflow config:
   - If worktree: `jmux ctl session create --name myapp-123 --dir /path/to/repo --worktree --base-branch origin/main`
   - If not: `jmux ctl session create --name myapp-123 --dir /path/to/repo`
6. Assemble the agent prompt:
   - Start with `agent.context` from workflow config (if present)
   - Add the Linear ticket description (this is the main task)
   - End with `agent.instructions` from workflow config (if present)
   - Write to a temp file
7. Dispatch: `jmux ctl run-claude --name myapp-123 --dir <session-dir> --message-file /tmp/prompt.txt`
8. Update: `jmux ctl task update --ticket MYAPP-123 --session myapp-123 --status in_progress`
9. Report to the user what you did.

## Naming Sessions

Read the `setup.naming` hint from the workflow config:
- `"lowercase-ticket-id"` → lowercase the ticket ID (MYAPP-123 → myapp-123)
- `"ticket-id"` → use as-is (MYAPP-123)
- If no hint, default to lowercase ticket ID

Session names are sanitized by jmux (`.` and `:` become `_`).

## Principles

- Always check existing state before creating new resources
- Always update the task registry after every action
- Report what you did concisely — the user can see the sidebar update
- If something fails, report the error and suggest a fix
- You don't need to explain jmux internals — the user knows the tool
```

- [ ] **Step 2: Verify the skill file is loadable**

Run: `cat skills/jmux-meta-agent.md | head -5`
Expected: Shows the frontmatter

- [ ] **Step 3: Commit**

```bash
git add skills/jmux-meta-agent.md
git commit -m "feat: add meta agent skill teaching workflow patterns and ctl task commands"
```

---

### Task 10: Sidebar — Show Ticket ID for Task-Linked Sessions

**Files:**
- Modify: `src/types.ts:40-50` (add `ticketId` to SessionInfo)
- Modify: `src/sidebar.ts:560-575` (render ticket ID)
- Modify: `src/main.ts` (populate ticketId from task registry)
- Modify: `src/__tests__/sidebar.test.ts` (add test for ticket display)

- [ ] **Step 1: Add ticketId to SessionInfo**

In `src/types.ts`, add to the `SessionInfo` interface (around line 49):

```typescript
export interface SessionInfo {
  id: string;
  name: string;
  attached: boolean;
  activity: number;
  gitBranch?: string;
  attention: boolean;
  windowCount: number;
  directory?: string;
  project?: string;
  ticketId?: string; // from task registry
}
```

- [ ] **Step 2: Populate ticketId from task registry in main.ts**

In `main.ts`, where sessions are fetched and `SessionInfo` objects are built (find the `fetchSessions` or equivalent function), add after the session list is constructed:

```typescript
// Enrich sessions with ticket IDs from task registry
const tasks = listTasks(DEFAULT_REGISTRY_PATH);
for (const session of sessions) {
  for (const [ticketId, task] of Object.entries(tasks)) {
    if (task.session === session.name) {
      session.ticketId = ticketId;
      break;
    }
  }
}
```

- [ ] **Step 3: Render ticket ID in sidebar**

In `src/sidebar.ts`, in the `renderSession` method, after the session name is written (around line 575), add ticket ID rendering. The ticket ID should appear on the detail line, before the git branch:

Find the detail line rendering section (around line 606-614) and modify it. When `session.ticketId` is present, show it as a prefix on the detail line:

```typescript
    // Ticket ID on detail line (before branch/directory)
    if (session.ticketId) {
      const ticketAttrs: CellAttrs = isActive
        ? { fg: (0x58 << 16) | (0xa6 << 8) | 0xff, fgMode: ColorMode.RGB, bg: ACTIVE_BG, bgMode: ColorMode.RGB }
        : isHovered
          ? { fg: (0x58 << 16) | (0xa6 << 8) | 0xff, fgMode: ColorMode.RGB, bg: HOVER_BG, bgMode: ColorMode.RGB }
          : { fg: (0x58 << 16) | (0xa6 << 8) | 0xff, fgMode: ColorMode.RGB };
      let ticketDisplay = session.ticketId;
      const maxTicketLen = this.width - detailStart - 2;
      if (ticketDisplay.length > maxTicketLen) {
        ticketDisplay = ticketDisplay.slice(0, maxTicketLen - 1) + "\u2026";
      }
      writeString(grid, detailRow, detailStart, ticketDisplay, ticketAttrs);
    }
```

This replaces the git branch/directory on the detail line when a ticket is linked. The ticket ID is more useful context when working on tracked tasks.

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/sidebar.ts src/main.ts
git commit -m "feat: show ticket ID in sidebar for task-linked sessions"
```

---

### Task 11: Workflow Config Loader

**Files:**
- Create: `src/workflow-config.ts`
- Create: `src/__tests__/workflow-config.test.ts`

- [ ] **Step 1: Write failing tests for workflow config loading**

```typescript
// src/__tests__/workflow-config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { loadWorkflowConfig, discoverWorkflowConfigs, matchTicketToProject, type WorkflowConfig } from "../workflow-config";

describe("loadWorkflowConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "jmux-wf-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loads a valid workflow config", () => {
    const jmuxDir = resolve(dir, ".jmux");
    mkdirSync(jmuxDir, { recursive: true });
    writeFileSync(resolve(jmuxDir, "workflow.yml"), `
project: myapp
tickets:
  linear:
    projects: ["MYAPP"]
setup:
  worktree: true
  base_branch: origin/main
  naming: lowercase-ticket-id
`);
    const config = loadWorkflowConfig(dir);
    expect(config).not.toBeNull();
    expect(config!.project).toBe("myapp");
    expect(config!.tickets?.linear?.projects).toEqual(["MYAPP"]);
    expect(config!.setup?.worktree).toBe(true);
  });

  test("returns null when no .jmux/workflow.yml exists", () => {
    const config = loadWorkflowConfig(dir);
    expect(config).toBeNull();
  });

  test("returns null for invalid YAML", () => {
    const jmuxDir = resolve(dir, ".jmux");
    mkdirSync(jmuxDir, { recursive: true });
    writeFileSync(resolve(jmuxDir, "workflow.yml"), "{{{{invalid");
    const config = loadWorkflowConfig(dir);
    expect(config).toBeNull();
  });
});

describe("discoverWorkflowConfigs", () => {
  let dir1: string;
  let dir2: string;
  let dir3: string;

  beforeEach(() => {
    dir1 = mkdtempSync(resolve(tmpdir(), "jmux-wf1-"));
    dir2 = mkdtempSync(resolve(tmpdir(), "jmux-wf2-"));
    dir3 = mkdtempSync(resolve(tmpdir(), "jmux-wf3-"));

    // dir1 has a workflow
    mkdirSync(resolve(dir1, ".jmux"), { recursive: true });
    writeFileSync(resolve(dir1, ".jmux", "workflow.yml"), "project: app1\ntickets:\n  linear:\n    projects: [APP1]\n");

    // dir2 has a workflow
    mkdirSync(resolve(dir2, ".jmux"), { recursive: true });
    writeFileSync(resolve(dir2, ".jmux", "workflow.yml"), "project: app2\ntickets:\n  linear:\n    projects: [APP2]\n");

    // dir3 has no workflow
  });

  afterEach(() => {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
    rmSync(dir3, { recursive: true, force: true });
  });

  test("discovers configs from multiple directories", () => {
    const configs = discoverWorkflowConfigs([dir1, dir2, dir3]);
    expect(configs).toHaveLength(2);
    expect(configs.map(c => c.config.project).sort()).toEqual(["app1", "app2"]);
  });
});

describe("matchTicketToProject", () => {
  test("matches by project prefix", () => {
    const configs = [
      { dir: "/repo/app1", config: { project: "app1", tickets: { linear: { projects: ["APP1"] } } } as WorkflowConfig },
      { dir: "/repo/app2", config: { project: "app2", tickets: { linear: { projects: ["APP2"] } } } as WorkflowConfig },
    ];
    const match = matchTicketToProject("APP1-123", configs);
    expect(match).not.toBeNull();
    expect(match!.dir).toBe("/repo/app1");
  });

  test("matches by team", () => {
    const configs = [
      { dir: "/repo/app", config: { project: "app", tickets: { linear: { team: "Engineering" } } } as WorkflowConfig },
    ];
    const match = matchTicketToProject("PROJ-1", configs, "Engineering");
    expect(match).not.toBeNull();
  });

  test("returns null when no match", () => {
    const configs = [
      { dir: "/repo/app", config: { project: "app", tickets: { linear: { projects: ["OTHER"] } } } as WorkflowConfig },
    ];
    const match = matchTicketToProject("MYAPP-1", configs);
    expect(match).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/workflow-config.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement workflow-config.ts**

```typescript
// src/workflow-config.ts
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface WorkflowConfig {
  project: string;
  description?: string;
  tickets?: {
    linear?: {
      team?: string;
      projects?: string[];
    };
  };
  setup?: {
    worktree?: boolean;
    base_branch?: string;
    naming?: string;
  };
  agent?: {
    context?: string;
    instructions?: string;
    skill?: string;
  };
  merge_request?: {
    target_branch?: string;
  };
}

export function loadWorkflowConfig(projectDir: string): WorkflowConfig | null {
  const filePath = resolve(projectDir, ".jmux", "workflow.yml");
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    return parseSimpleYaml(raw);
  } catch {
    return null;
  }
}

export interface DiscoveredWorkflow {
  dir: string;
  config: WorkflowConfig;
  raw: string;
}

export function discoverWorkflowConfigs(projectDirs: string[]): DiscoveredWorkflow[] {
  const results: DiscoveredWorkflow[] = [];
  for (const dir of projectDirs) {
    const filePath = resolve(dir, ".jmux", "workflow.yml");
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const config = parseSimpleYaml(raw);
      if (config && config.project) {
        results.push({ dir, config, raw });
      }
    } catch {
      // Skip invalid configs
    }
  }
  return results;
}

export function matchTicketToProject(
  ticketId: string,
  configs: { dir: string; config: WorkflowConfig }[],
  teamName?: string,
): { dir: string; config: WorkflowConfig } | null {
  const prefix = ticketId.replace(/-\d+$/, ""); // "MYAPP-123" → "MYAPP"

  for (const entry of configs) {
    const linear = entry.config.tickets?.linear;
    if (!linear) continue;

    // Match by project prefix
    if (linear.projects?.includes(prefix)) {
      return entry;
    }

    // Match by team name
    if (teamName && linear.team === teamName) {
      return entry;
    }
  }

  return null;
}

/**
 * Minimal YAML parser for workflow configs. Handles the flat/shallow
 * structure we need without pulling in a full YAML library.
 * Supports: scalars, simple arrays ([a, b]), nested objects (2 levels).
 */
function parseSimpleYaml(raw: string): WorkflowConfig {
  const lines = raw.split("\n");
  const result: any = {};
  let currentSection: string | null = null;
  let currentSubSection: string | null = null;

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.trim().startsWith("#") || line.trim() === "") continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0 && trimmed.includes(":")) {
      // Top-level key
      const [key, ...valueParts] = trimmed.split(":");
      const value = valueParts.join(":").trim();
      currentSection = key.trim();
      currentSubSection = null;
      if (value) {
        result[currentSection] = parseYamlValue(value);
      } else {
        result[currentSection] = result[currentSection] ?? {};
      }
    } else if (indent === 2 && trimmed.includes(":") && currentSection) {
      const [key, ...valueParts] = trimmed.split(":");
      const value = valueParts.join(":").trim();
      currentSubSection = key.trim();
      if (typeof result[currentSection] !== "object") result[currentSection] = {};
      if (value) {
        result[currentSection][currentSubSection] = parseYamlValue(value);
      } else {
        result[currentSection][currentSubSection] = {};
      }
    } else if (indent === 4 && trimmed.includes(":") && currentSection && currentSubSection) {
      const [key, ...valueParts] = trimmed.split(":");
      const value = valueParts.join(":").trim();
      if (typeof result[currentSection][currentSubSection] !== "object") {
        result[currentSection][currentSubSection] = {};
      }
      result[currentSection][currentSubSection][key.trim()] = parseYamlValue(value);
    } else if (indent >= 2 && trimmed.startsWith("- ") && currentSection) {
      // Multiline string continuation with block scalar indicator
      // Not needed for our flat config
    }
  }

  // Handle block scalars (|) — re-parse for context/instructions
  const blockPattern = /^(\s+)(\w+):\s*\|\s*$/gm;
  let match;
  while ((match = blockPattern.exec(raw)) !== null) {
    const keyIndent = match[1].length;
    const key = match[2];
    const startIdx = match.index + match[0].length + 1;
    const blockLines: string[] = [];
    const remaining = raw.slice(startIdx).split("\n");
    for (const bline of remaining) {
      if (bline.trim() === "") { blockLines.push(""); continue; }
      const bi = bline.length - bline.trimStart().length;
      if (bi > keyIndent) {
        blockLines.push(bline.slice(keyIndent + 2));
      } else {
        break;
      }
    }
    // Find the right place to set this value
    if (keyIndent === 2 && currentSection) {
      // Look for which section this belongs to
      for (const section of Object.keys(result)) {
        if (typeof result[section] === "object" && key in result[section]) {
          result[section][key] = blockLines.join("\n").trimEnd();
        }
      }
    }
  }

  return result as WorkflowConfig;
}

function parseYamlValue(value: string): any {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  // Inline array: ["a", "b"] or [a, b]
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map(s => {
      const t = s.trim();
      return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
    });
  }
  // Quoted string
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/workflow-config.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/workflow-config.ts src/__tests__/workflow-config.test.ts
git commit -m "feat: add workflow config loader and ticket-to-project matching"
```

---

### Task 12: Integration — Wire Workflow Discovery into Agent Prompt

**Files:**
- Modify: `src/main.ts` (use discoverWorkflowConfigs in spawnAgentMessage)
- Modify: `src/agent-tab.ts` (update AgentContext to use WorkflowConfig types)

- [ ] **Step 1: Update imports in main.ts**

```typescript
import { discoverWorkflowConfigs } from "./workflow-config";
```

- [ ] **Step 2: Replace raw file scanning with discoverWorkflowConfigs**

In the `spawnAgentMessage` function in main.ts, replace the workflow config loading section:

```typescript
    // Load workflow configs from project dirs
    const discovered = discoverWorkflowConfigs(cachedProjectDirs);
    const workflowConfigs = discovered.map(d => ({
      project: d.config.project,
      path: resolve(d.dir, ".jmux", "workflow.yml"),
      content: d.raw,
    }));
```

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: End-to-end manual test**

Run: `bun run dev`
1. Open agent tab with `Ctrl-a m`
2. Type "Pick up MYAPP-123" and press Enter
3. If Linear MCP is configured, the agent should:
   - Query Linear for the ticket
   - Match it to a project (or ask if no match)
   - Create a task via `jmux ctl task create`
   - Create a session/worktree
   - Dispatch Claude Code
   - Update the task status
4. The new session should appear in the sidebar with the ticket ID
5. Switching to the new session should show Claude Code working

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/agent-tab.ts
git commit -m "feat: wire workflow config discovery into meta agent prompt assembly"
```

---

### Task 13: Final — Run Full Test Suite and Typecheck

**Files:** None (validation only)

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Run docker sanity check**

Run: `bun run docker`
Expected: Build succeeds, basic sanity checks pass

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "chore: fix any issues found during final validation"
```
