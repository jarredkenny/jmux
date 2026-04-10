# Agent Control CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `jmux ctl` subcommands that let agents programmatically create sessions, dispatch Claude Code instances, monitor progress, and interact with sibling panes — all JSON output, all encapsulating jmux conventions.

**Architecture:** Standalone CLI processes under `jmux ctl <group> <action>`. Each invocation talks directly to the tmux server via `Bun.spawnSync`/`Bun.spawn`, prints JSON to stdout, and exits. No IPC to the running jmux TUI. Shared logic (session name sanitization, config loading, OTEL resource attrs) is extracted from `main.ts` into importable modules.

**Tech Stack:** Bun 1.2+, TypeScript (strict), tmux CLI

**Spec:** `docs/specs/2026-04-09-agent-control-cli-design.md`

---

### Task 1: Extract shared utilities from main.ts

Extract `sanitizeTmuxSessionName`, config loading, and OTEL resource attribute construction into importable modules so both the TUI and CLI can use them.

**Files:**
- Create: `src/config.ts`
- Modify: `src/new-session-modal.ts:13-15` (re-export sanitize from config.ts)
- Modify: `src/main.ts:12-16,140-168` (import from new modules)
- Test: `src/__tests__/config.test.ts`

- [ ] **Step 1: Write tests for extracted utilities**

```typescript
// src/__tests__/config.test.ts
import { describe, test, expect } from "bun:test";
import { sanitizeTmuxSessionName, loadUserConfig, buildOtelResourceAttrs } from "../config";

describe("sanitizeTmuxSessionName", () => {
  test("replaces dots with underscores", () => {
    expect(sanitizeTmuxSessionName("foo.bar")).toBe("foo_bar");
  });

  test("replaces colons with underscores", () => {
    expect(sanitizeTmuxSessionName("foo:bar")).toBe("foo_bar");
  });

  test("replaces mixed dots and colons", () => {
    expect(sanitizeTmuxSessionName("a.b:c")).toBe("a_b_c");
  });

  test("leaves clean names unchanged", () => {
    expect(sanitizeTmuxSessionName("my-project")).toBe("my-project");
  });
});

describe("buildOtelResourceAttrs", () => {
  test("produces correct env var value", () => {
    expect(buildOtelResourceAttrs("my-session")).toBe("tmux_session_name=my-session");
  });
});

describe("loadUserConfig", () => {
  test("returns empty object when config does not exist", () => {
    const config = loadUserConfig("/nonexistent/path/config.json");
    expect(config).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/config.test.ts`
Expected: FAIL — `../config` module does not exist

- [ ] **Step 3: Create src/config.ts with extracted utilities**

```typescript
// src/config.ts
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

/**
 * tmux silently rewrites '.' and ':' in session names to '_'. Mirror
 * that sanitization so callers and tmux agree on the final name.
 */
export function sanitizeTmuxSessionName(name: string): string {
  return name.replace(/[.:]/g, "_");
}

/**
 * Build the OTEL_RESOURCE_ATTRIBUTES value for a session.
 * The global OTEL exporter config is set on the tmux server by the TUI
 * at startup — this only constructs the per-session resource attribute.
 */
export function buildOtelResourceAttrs(sessionName: string): string {
  return `tmux_session_name=${sessionName}`;
}

export interface JmuxConfig {
  sidebarWidth?: number;
  claudeCommand?: string;
  cacheTimers?: boolean;
  pinnedSessions?: string[];
  diffPanel?: { splitRatio?: number; hunkCommand?: string };
}

const DEFAULT_CONFIG_PATH = resolve(homedir(), ".config", "jmux", "config.json");

export function loadUserConfig(configPath: string = DEFAULT_CONFIG_PATH): JmuxConfig {
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Invalid config — use defaults
  }
  return {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/config.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Update new-session-modal.ts to re-export from config.ts**

In `src/new-session-modal.ts`, replace the inline `sanitizeTmuxSessionName` function with a re-export:

```typescript
// Replace lines 7-15 (the doc comment + function) with:
export { sanitizeTmuxSessionName } from "./config";
```

This preserves the existing import path `from "./new-session-modal"` used in `main.ts:13`.

- [ ] **Step 6: Update main.ts to use loadUserConfig from config.ts**

In `src/main.ts`, add import and replace the inline `loadUserConfig`:

```typescript
// Add to imports (after existing imports):
import { loadUserConfig } from "./config";

// Remove the inline loadUserConfig function at lines 151-161.
// The call at line 162 stays: const userConfig = loadUserConfig();
```

- [ ] **Step 7: Run full test suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: All tests pass, no type errors

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts src/new-session-modal.ts src/main.ts
git commit -m "refactor: extract shared utilities into src/config.ts

Move sanitizeTmuxSessionName, loadUserConfig, and buildOtelResourceAttrs
into a shared module importable by both TUI and CLI code paths."
```

---

### Task 2: Create tmux command execution utility

A thin wrapper around `Bun.spawnSync` that runs tmux commands with the correct socket flag and returns parsed output.

**Files:**
- Create: `src/cli/tmux.ts`
- Test: `src/__tests__/cli/tmux.test.ts`

- [ ] **Step 1: Write tests for tmux execution utility**

```typescript
// src/__tests__/cli/tmux.test.ts
import { describe, test, expect } from "bun:test";
import { buildTmuxArgs, parseTmuxSocket } from "../../cli/tmux";

describe("buildTmuxArgs", () => {
  test("basic command without socket", () => {
    expect(buildTmuxArgs("list-sessions", null)).toEqual(["list-sessions"]);
  });

  test("command with socket name", () => {
    expect(buildTmuxArgs("list-sessions", "work")).toEqual(["-L", "work", "list-sessions"]);
  });

  test("command with socket path", () => {
    expect(buildTmuxArgs("list-sessions", "/tmp/tmux-501/default")).toEqual(
      ["-S", "/tmp/tmux-501/default", "list-sessions"]
    );
  });
});

describe("parseTmuxSocket", () => {
  test("extracts socket path from $TMUX env var", () => {
    expect(parseTmuxSocket("/tmp/tmux-501/default,12345,0")).toBe("/tmp/tmux-501/default");
  });

  test("returns null for undefined", () => {
    expect(parseTmuxSocket(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseTmuxSocket("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/cli/tmux.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement src/cli/tmux.ts**

```typescript
// src/cli/tmux.ts

/**
 * Parse the socket path from the $TMUX environment variable.
 * Format: /path/to/socket,PID,INDEX
 */
export function parseTmuxSocket(tmuxEnv: string | undefined): string | null {
  if (!tmuxEnv) return null;
  const comma = tmuxEnv.indexOf(",");
  return comma > 0 ? tmuxEnv.substring(0, comma) : null;
}

/**
 * Build the argument array for a tmux command, prepending socket flags if needed.
 * If socket contains a '/' it's treated as a path (-S), otherwise as a name (-L).
 */
export function buildTmuxArgs(command: string, socket: string | null): string[] {
  const prefix: string[] = [];
  if (socket) {
    prefix.push(socket.includes("/") ? "-S" : "-L", socket);
  }
  return [...prefix, command];
}

export interface TmuxResult {
  ok: boolean;
  lines: string[];
  error: string;
}

/**
 * Run a tmux command synchronously and return structured output.
 */
export function runTmux(command: string, socket: string | null): TmuxResult {
  const args = buildTmuxArgs(command, socket);
  const result = Bun.spawnSync(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();

  if (result.exitCode !== 0) {
    return { ok: false, lines: [], error: stderr || `tmux exited with code ${result.exitCode}` };
  }

  return {
    ok: true,
    lines: stdout ? stdout.split("\n") : [],
    error: "",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/cli/tmux.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli/tmux.ts src/__tests__/cli/tmux.test.ts
git commit -m "feat: add tmux command execution utility for CLI

Thin wrapper around Bun.spawnSync with socket flag handling and
structured output parsing."
```

---

### Task 3: Create context resolution module

Resolves the tmux socket, current session, and whether we're inside jmux — the foundation every subcommand uses.

**Files:**
- Create: `src/cli/context.ts`
- Test: `src/__tests__/cli/context.test.ts`

- [ ] **Step 1: Write tests for context resolution**

```typescript
// src/__tests__/cli/context.test.ts
import { describe, test, expect } from "bun:test";
import { resolveContext, type CliContext } from "../../cli/context";

describe("resolveContext", () => {
  test("detects inside-jmux from env", () => {
    const ctx = resolveContext({
      env: { JMUX: "1", TMUX: "/tmp/tmux-501/default,1234,0", TMUX_PANE: "%5" },
      flags: {},
    });
    expect(ctx.insideJmux).toBe(true);
    expect(ctx.socket).toBe("/tmp/tmux-501/default");
    expect(ctx.paneId).toBe("%5");
  });

  test("flags override env", () => {
    const ctx = resolveContext({
      env: { TMUX: "/tmp/tmux-501/default,1234,0" },
      flags: { socket: "custom" },
    });
    expect(ctx.socket).toBe("custom");
  });

  test("session flag overrides env-derived session", () => {
    const ctx = resolveContext({
      env: { TMUX: "/tmp/tmux-501/default,1234,0", TMUX_PANE: "%5" },
      flags: { session: "override" },
    });
    expect(ctx.sessionOverride).toBe("override");
  });

  test("outside tmux with no flags", () => {
    const ctx = resolveContext({ env: {}, flags: {} });
    expect(ctx.insideJmux).toBe(false);
    expect(ctx.socket).toBeNull();
    expect(ctx.paneId).toBeNull();
  });

  test("insideTmux is true when TMUX is set but JMUX is not", () => {
    const ctx = resolveContext({
      env: { TMUX: "/tmp/tmux-501/default,1234,0", TMUX_PANE: "%5" },
      flags: {},
    });
    expect(ctx.insideTmux).toBe(true);
    expect(ctx.insideJmux).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/cli/context.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement src/cli/context.ts**

```typescript
// src/cli/context.ts
import { parseTmuxSocket, runTmux } from "./tmux";

export interface CliFlags {
  socket?: string;
  session?: string;
}

export interface CliContext {
  socket: string | null;
  paneId: string | null;
  sessionOverride: string | null;
  insideTmux: boolean;
  insideJmux: boolean;
}

interface ResolveInput {
  env: Record<string, string | undefined>;
  flags: CliFlags;
}

export function resolveContext(input: ResolveInput): CliContext {
  const { env, flags } = input;
  const socket = flags.socket ?? parseTmuxSocket(env.TMUX);
  const paneId = env.TMUX_PANE ?? null;
  const insideTmux = !!env.TMUX;
  const insideJmux = env.JMUX === "1";
  const sessionOverride = flags.session ?? null;

  return { socket, paneId, sessionOverride, insideTmux, insideJmux };
}

/**
 * Resolve the current session name from $TMUX_PANE.
 * Requires a live tmux server — runs tmux display-message.
 */
export function resolveCurrentSession(ctx: CliContext): string | null {
  if (ctx.sessionOverride) return ctx.sessionOverride;
  if (!ctx.paneId) return null;

  const result = runTmux(`display-message -t ${ctx.paneId} -p '#{session_name}'`, ctx.socket);
  if (!result.ok || result.lines.length === 0) return null;
  return result.lines[0];
}

/**
 * Require a session name — either from override, env, or error.
 */
export function requireSession(ctx: CliContext): string {
  const session = resolveCurrentSession(ctx);
  if (!session) {
    throw new CliError("not inside tmux — use explicit --session flag or run from within a jmux session");
  }
  return session;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/cli/context.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli/context.ts src/__tests__/cli/context.test.ts
git commit -m "feat: add CLI context resolution module

Resolves tmux socket, current session, and jmux detection from
environment variables and CLI flags."
```

---

### Task 4: Create CLI entry point and argument parser

The `jmux ctl` dispatcher that parses subcommands and global flags, then delegates to handlers.

**Files:**
- Create: `src/cli.ts`
- Modify: `src/main.ts:72-85` (add `ctl` routing before TUI startup)
- Test: `src/__tests__/cli/parse.test.ts`

- [ ] **Step 1: Write tests for CLI argument parsing**

```typescript
// src/__tests__/cli/parse.test.ts
import { describe, test, expect } from "bun:test";
import { parseCtlArgs, type ParsedCtlArgs } from "../../cli";

describe("parseCtlArgs", () => {
  test("parses session list", () => {
    const result = parseCtlArgs(["session", "list"]);
    expect(result.group).toBe("session");
    expect(result.action).toBe("list");
    expect(result.flags).toEqual({});
    expect(result.positional).toEqual([]);
  });

  test("parses global --session flag", () => {
    const result = parseCtlArgs(["--session", "my-proj", "window", "list"]);
    expect(result.group).toBe("window");
    expect(result.action).toBe("list");
    expect(result.flags.session).toBe("my-proj");
  });

  test("parses global -L flag", () => {
    const result = parseCtlArgs(["-L", "work", "session", "list"]);
    expect(result.flags.socket).toBe("work");
  });

  test("parses --socket flag", () => {
    const result = parseCtlArgs(["--socket", "work", "session", "list"]);
    expect(result.flags.socket).toBe("work");
  });

  test("parses action-specific flags", () => {
    const result = parseCtlArgs(["session", "create", "--name", "foo", "--dir", "/tmp"]);
    expect(result.action).toBe("create");
    expect(result.flags.name).toBe("foo");
    expect(result.flags.dir).toBe("/tmp");
  });

  test("parses --target flag", () => {
    const result = parseCtlArgs(["session", "kill", "--target", "my-proj"]);
    expect(result.flags.target).toBe("my-proj");
  });

  test("parses --force flag", () => {
    const result = parseCtlArgs(["session", "kill", "--target", "foo", "--force"]);
    expect(result.flags.force).toBe(true);
  });

  test("parses --no-enter flag", () => {
    const result = parseCtlArgs(["pane", "send-keys", "--target", "%5", "--no-enter"]);
    expect(result.flags["no-enter"]).toBe(true);
  });

  test("collects positional args after flags", () => {
    const result = parseCtlArgs(["pane", "send-keys", "--target", "%5", "ls", "-la"]);
    expect(result.positional).toEqual(["ls", "-la"]);
  });

  test("parses run-claude as group", () => {
    const result = parseCtlArgs(["run-claude", "--name", "fix", "--dir", "/tmp"]);
    expect(result.group).toBe("run-claude");
    expect(result.action).toBeNull();
  });

  test("errors on missing group", () => {
    expect(() => parseCtlArgs([])).toThrow();
  });

  test("errors on unknown group", () => {
    expect(() => parseCtlArgs(["bogus", "list"])).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/cli/parse.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement src/cli.ts**

```typescript
// src/cli.ts
import { resolveContext, CliError, type CliFlags } from "./cli/context";
import { handleSession } from "./cli/session";
import { handleWindow } from "./cli/window";
import { handlePane } from "./cli/pane";
import { handleRunClaude } from "./cli/run-claude";

const KNOWN_GROUPS = new Set(["session", "window", "pane", "run-claude"]);

// Groups that don't have a sub-action (the group IS the action)
const STANDALONE_GROUPS = new Set(["run-claude"]);

export interface ParsedCtlArgs {
  group: string;
  action: string | null;
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseCtlArgs(argv: string[]): ParsedCtlArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let group: string | null = null;
  let action: string | null = null;

  let i = 0;

  // Parse global flags first (before group)
  while (i < argv.length && argv[i].startsWith("-")) {
    const arg = argv[i];
    if (arg === "--session" || arg === "-L" || arg === "--socket") {
      const key = arg === "-L" ? "socket" : arg.slice(2);
      if (i + 1 >= argv.length) throw new CliError(`${arg} requires a value`);
      flags[key] = argv[++i];
    } else {
      throw new CliError(`unknown global flag: ${arg}`);
    }
    i++;
  }

  // Group
  if (i >= argv.length) throw new CliError("missing subcommand — expected: session, window, pane, run-claude");
  group = argv[i++];
  if (!KNOWN_GROUPS.has(group)) throw new CliError(`unknown subcommand: ${group}`);

  // Action (unless standalone group)
  if (!STANDALONE_GROUPS.has(group)) {
    if (i >= argv.length) throw new CliError(`missing action for '${group}'`);
    action = argv[i++];
  }

  // Remaining flags and positional args
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--no-enter") {
      flags["no-enter"] = true;
    } else if (arg === "--enter") {
      flags.enter = true;
    } else if (arg === "--raw") {
      flags.raw = true;
    } else if (arg === "--clear") {
      flags.clear = true;
    } else if (arg === "--stdin") {
      flags.stdin = true;
    } else if (arg.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      // Check if next arg looks like a flag or positional
      const key = arg.slice(2);
      const next = argv[i + 1];
      // If next starts with - but is not a flag (e.g., -la), treat carefully
      flags[key] = next;
      i++;
    } else if (arg.startsWith("--")) {
      // Boolean flag
      flags[arg.slice(2)] = true;
    } else {
      positional.push(arg);
    }
    i++;
  }

  return { group, action, flags, positional };
}

function jsonOut(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function jsonErr(message: string): void {
  process.stderr.write(JSON.stringify({ error: message }) + "\n");
}

export async function runCtl(argv: string[]): Promise<void> {
  let parsed: ParsedCtlArgs;
  try {
    parsed = parseCtlArgs(argv);
  } catch (err) {
    jsonErr(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  const ctx = resolveContext({
    env: process.env as Record<string, string | undefined>,
    flags: { socket: parsed.flags.socket as string | undefined, session: parsed.flags.session as string | undefined },
  });

  try {
    let result: unknown;
    switch (parsed.group) {
      case "session":
        result = handleSession(ctx, parsed);
        break;
      case "window":
        result = handleWindow(ctx, parsed);
        break;
      case "pane":
        result = handlePane(ctx, parsed);
        break;
      case "run-claude":
        result = handleRunClaude(ctx, parsed);
        break;
    }
    jsonOut(result);
  } catch (err) {
    jsonErr(err instanceof CliError ? err.message : `unexpected error: ${err}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/cli/parse.test.ts`
Expected: PASS (all 11 tests)

Note: This will fail until the handler modules exist. Create empty stubs first:

```typescript
// src/cli/session.ts
export function handleSession(..._args: any[]): any { throw new Error("not implemented"); }

// src/cli/window.ts
export function handleWindow(..._args: any[]): any { throw new Error("not implemented"); }

// src/cli/pane.ts
export function handlePane(..._args: any[]): any { throw new Error("not implemented"); }

// src/cli/run-claude.ts
export function handleRunClaude(..._args: any[]): any { throw new Error("not implemented"); }
```

- [ ] **Step 5: Add ctl routing to main.ts**

In `src/main.ts`, add the `ctl` check after the `--install-agent-hooks` block (after line 85) and before the nesting guard (line 140):

```typescript
// Add after line 85 (after install-agent-hooks exit):
if (process.argv[2] === "ctl") {
  import("./cli").then(({ runCtl }) => runCtl(process.argv.slice(3)));
  // Do not fall through to TUI startup
} else {
```

The nesting guard and TUI startup become the `else` branch. Alternatively, use a simpler approach:

```typescript
// After line 85:
if (process.argv[2] === "ctl") {
  const { runCtl } = await import("./cli");
  await runCtl(process.argv.slice(3));
  process.exit(0);
}
```

Since the file uses top-level await later (line 1841+), we need to restructure slightly. The cleanest approach: add the check right after the `--install-agent-hooks` block, using dynamic import so the CLI modules don't load when running the TUI:

```typescript
if (process.argv[2] === "ctl") {
  const { runCtl } = require("./cli") as typeof import("./cli");
  await runCtl(process.argv.slice(3));
  process.exit(0);
}
```

Actually, since this is Bun and top-level await works, the simplest approach is to wrap it in an async IIFE or just use dynamic import directly. But looking at the file structure, the existing code at line 82-85 uses `process.exit(0)` synchronously. The `ctl` handler is async, so:

```typescript
// After line 85 (after --install-agent-hooks block):
if (process.argv[2] === "ctl") {
  const { runCtl } = await import("./cli");
  await runCtl(process.argv.slice(3));
  process.exit(0);
}
```

This works because in Bun, top-level `await` is valid in ESM modules, and `main.ts` already uses it (the `start()` call near the end of the file uses async patterns). However, examining the file more carefully — the top-level `await` is actually inside the `start()` function, not truly top-level. The early exits (lines 72-85) are synchronous.

The safest approach: match the existing pattern with `.then()`:

```typescript
// After line 85:
if (process.argv[2] === "ctl") {
  import("./cli").then(async ({ runCtl }) => {
    await runCtl(process.argv.slice(3));
  }).catch((err) => {
    process.stderr.write(JSON.stringify({ error: String(err) }) + "\n");
    process.exit(1);
  });
} else {
// ... rest of file wrapped in else? No — too invasive.
```

Actually, looking again at the file structure: lines 72-85 all call `process.exit(0)` so control never reaches the TUI code. We do the same:

```typescript
if (process.argv[2] === "ctl") {
  import("./cli").then(({ runCtl }) => runCtl(process.argv.slice(3)));
  // runCtl calls process.exit internally
}
```

But we need `runCtl` to not exit on success (it currently does `process.exit(1)` on error but just returns on success). We need to ensure `process.exit(0)` is called. Simplest: the routing code in main.ts does NOT fall through because `import()` returns a promise and the rest of the file is synchronous module-level code that would execute immediately. We need a different approach.

The cleanest solution for Bun: since Bun supports top-level await in the entry point, and `bin/jmux` does `import "../src/main.ts"`, we can safely put the check before any other module-level side effects. But the flag checks at lines 72-85 are already synchronous and exit. The issue is that the ctl path is async.

Final approach — keep it simple, match existing sync exits where possible:

```typescript
// After line 85:
if (process.argv[2] === "ctl") {
  // Dynamic import keeps CLI modules out of TUI startup
  const { runCtl } = await import("./cli");
  await runCtl(process.argv.slice(3));
  process.exit(0);
}
```

But wait — the file has no top-level await yet. Looking at the bottom of main.ts, `start()` is called but let me check how...

- [ ] **Step 6: Check how main.ts calls start() and finalize the routing approach**

Read `src/main.ts` from the bottom to understand the entry point pattern, then add the `ctl` routing in the correct place. The key constraint: the `ctl` check must run before TUI module-level setup code (which creates `ScreenBridge`, `Renderer`, etc.) but after the early exits for `--help`, `--version`, `--install-agent-hooks`.

- [ ] **Step 7: Run full test suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: All tests pass, no type errors

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/cli/session.ts src/cli/window.ts src/cli/pane.ts src/cli/run-claude.ts src/__tests__/cli/parse.test.ts src/main.ts
git commit -m "feat: add jmux ctl entry point and argument parser

Routes 'jmux ctl <group> <action>' to CLI handlers. Parses global
flags (--session, --socket/-L) and per-action flags. Stubs for
session/window/pane/run-claude handlers."
```

---

### Task 5: Implement session subcommands

The `session list`, `session create`, `session info`, `session kill`, `session rename`, `session switch`, and `session set-attention` handlers.

**Files:**
- Modify: `src/cli/session.ts` (replace stub)
- Test: `src/__tests__/cli/session.test.ts`

- [ ] **Step 1: Write tests for session argument validation and response shaping**

These test the argument validation and response shaping logic without hitting a real tmux server. We mock `runTmux` at the module boundary.

```typescript
// src/__tests__/cli/session.test.ts
import { describe, test, expect } from "bun:test";
import { parseSessionListOutput, parseSessionInfoOutput, validateSessionCreate } from "../../cli/session";

describe("parseSessionListOutput", () => {
  test("parses list-sessions format string output", () => {
    const lines = [
      "$1:my-project:1712678400:1:3:0:/Users/jarred/Code/project",
      "$2:other:1712678300:0:1:1:/Users/jarred/Code/other",
    ];
    const sessions = parseSessionListOutput(lines);
    expect(sessions).toEqual([
      { id: "$1", name: "my-project", activity: 1712678400, attached: true, windows: 3, attention: false, path: "/Users/jarred/Code/project" },
      { id: "$2", name: "other", activity: 1712678300, attached: false, windows: 1, attention: true, path: "/Users/jarred/Code/other" },
    ]);
  });

  test("handles empty output", () => {
    expect(parseSessionListOutput([])).toEqual([]);
  });
});

describe("validateSessionCreate", () => {
  test("requires --name", () => {
    expect(() => validateSessionCreate({ dir: "/tmp" })).toThrow("--name is required");
  });

  test("requires --dir", () => {
    expect(() => validateSessionCreate({ name: "foo" })).toThrow("--dir is required");
  });

  test("returns sanitized name", () => {
    const result = validateSessionCreate({ name: "foo.bar", dir: "/tmp" });
    expect(result.name).toBe("foo_bar");
    expect(result.dir).toBe("/tmp");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/cli/session.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement src/cli/session.ts**

```typescript
// src/cli/session.ts
import { sanitizeTmuxSessionName, buildOtelResourceAttrs } from "../config";
import { runTmux, type TmuxResult } from "./tmux";
import { resolveCurrentSession, CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

const LIST_FORMAT = "#{session_id}:#{session_name}:#{session_activity}:#{session_attached}:#{session_windows}:#{@jmux-attention}:#{pane_current_path}";

interface SessionEntry {
  id: string;
  name: string;
  activity: number;
  attached: boolean;
  windows: number;
  attention: boolean;
  path: string;
}

export function parseSessionListOutput(lines: string[]): SessionEntry[] {
  return lines.filter(l => l.length > 0).map(line => {
    const parts = line.split(":");
    // path may contain colons, so rejoin everything after index 6
    const [id, name, activity, attached, windows, attn, ...pathParts] = parts;
    return {
      id,
      name,
      activity: parseInt(activity, 10) || 0,
      attached: attached === "1",
      windows: parseInt(windows, 10) || 1,
      attention: attn === "1",
      path: pathParts.join(":") || "",
    };
  });
}

export function parseSessionInfoOutput(
  sessionLines: string[],
  windowLines: string[],
): Record<string, unknown> {
  const sessions = parseSessionListOutput(sessionLines);
  if (sessions.length === 0) throw new CliError("session not found");
  const session = sessions[0];

  const windows = windowLines.filter(l => l.length > 0).map(line => {
    const [id, index, name, active, bell, zoomed] = line.split(":");
    return {
      id,
      index: parseInt(index, 10),
      name,
      active: active === "1",
      zoomed: zoomed === "1",
      bell: bell === "1",
    };
  });

  return {
    ...session,
    windows_detail: windows,
  };
}

export function validateSessionCreate(flags: Record<string, string | boolean>): { name: string; dir: string; command?: string } {
  if (!flags.name || typeof flags.name !== "string") throw new CliError("--name is required");
  if (!flags.dir || typeof flags.dir !== "string") throw new CliError("--dir is required");
  return {
    name: sanitizeTmuxSessionName(flags.name),
    dir: flags.dir,
    command: typeof flags.command === "string" ? flags.command : undefined,
  };
}

function requireTarget(flags: Record<string, string | boolean>): string {
  if (!flags.target || typeof flags.target !== "string") throw new CliError("--target is required");
  return flags.target;
}

function tmuxOrThrow(result: TmuxResult): string[] {
  if (!result.ok) throw new CliError(result.error);
  return result.lines;
}

export function handleSession(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  switch (parsed.action) {
    case "list": {
      const lines = tmuxOrThrow(runTmux(`list-sessions -F '${LIST_FORMAT}'`, ctx.socket));
      return { sessions: parseSessionListOutput(lines) };
    }

    case "create": {
      const { name, dir, command } = validateSessionCreate(parsed.flags);
      const otel = buildOtelResourceAttrs(name);
      let cmd = `new-session -d -e 'OTEL_RESOURCE_ATTRIBUTES=${otel}' -s '${name}' -c '${dir}'`;
      if (command) cmd += ` '${command}'`;
      tmuxOrThrow(runTmux(cmd, ctx.socket));

      // Get the session ID
      const infoLines = tmuxOrThrow(runTmux(`list-sessions -F '#{session_id}:#{session_name}' -f '#{==:#{session_name},${name}}'`, ctx.socket));
      const id = infoLines[0]?.split(":")[0] ?? "";
      return { name, id };
    }

    case "info": {
      const target = requireTarget(parsed.flags);
      const sessionLines = tmuxOrThrow(runTmux(`list-sessions -F '${LIST_FORMAT}' -f '#{==:#{session_name},${target}}'`, ctx.socket));
      const windowLines = tmuxOrThrow(runTmux(`list-windows -t '${target}' -F '#{window_id}:#{window_index}:#{window_name}:#{window_active}:#{window_bell_flag}:#{window_zoomed_flag}'`, ctx.socket));
      return parseSessionInfoOutput(sessionLines, windowLines);
    }

    case "switch": {
      const target = requireTarget(parsed.flags);
      if (!ctx.insideTmux) throw new CliError("session switch requires running inside tmux");
      tmuxOrThrow(runTmux(`switch-client -t '${target}'`, ctx.socket));
      return { switched: target };
    }

    case "kill": {
      const target = requireTarget(parsed.flags);
      // Self-destruction guard
      if (!parsed.flags.force) {
        const current = resolveCurrentSession(ctx);
        if (current === target) throw new CliError("refusing to kill own session — use --force to override");

        // Check if it's the last session
        const listResult = runTmux("list-sessions -F '#{session_name}'", ctx.socket);
        if (listResult.ok && listResult.lines.filter(l => l.length > 0).length <= 1) {
          throw new CliError("refusing to kill last session — use --force to override");
        }
      }
      tmuxOrThrow(runTmux(`kill-session -t '${target}'`, ctx.socket));
      return { killed: target };
    }

    case "rename": {
      const target = requireTarget(parsed.flags);
      if (!parsed.flags.name || typeof parsed.flags.name !== "string") throw new CliError("--name is required");
      const newName = sanitizeTmuxSessionName(parsed.flags.name);
      tmuxOrThrow(runTmux(`rename-session -t '${target}' '${newName}'`, ctx.socket));
      return { renamed: newName, from: target };
    }

    case "set-attention": {
      const target = requireTarget(parsed.flags);
      if (parsed.flags.clear) {
        tmuxOrThrow(runTmux(`set-option -t '${target}' -u @jmux-attention`, ctx.socket));
        return { target, attention: false };
      } else {
        tmuxOrThrow(runTmux(`set-option -t '${target}' @jmux-attention 1`, ctx.socket));
        return { target, attention: true };
      }
    }

    default:
      throw new CliError(`unknown session action: ${parsed.action}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/cli/session.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/cli/session.ts src/__tests__/cli/session.test.ts
git commit -m "feat: implement session subcommands

list, create, info, switch, kill, rename, set-attention — all with
JSON output, safety guards, and name sanitization."
```

---

### Task 6: Implement window subcommands

**Files:**
- Modify: `src/cli/window.ts` (replace stub)
- Test: `src/__tests__/cli/window.test.ts`

- [ ] **Step 1: Write tests for window output parsing**

```typescript
// src/__tests__/cli/window.test.ts
import { describe, test, expect } from "bun:test";
import { parseWindowListOutput } from "../../cli/window";

describe("parseWindowListOutput", () => {
  test("parses list-windows format string output", () => {
    const lines = [
      "@1:0:editor:1:0:0",
      "@2:1:claude:0:1:0",
    ];
    const windows = parseWindowListOutput(lines);
    expect(windows).toEqual([
      { id: "@1", index: 0, name: "editor", active: true, bell: false, zoomed: false },
      { id: "@2", index: 1, name: "claude", active: false, bell: true, zoomed: false },
    ]);
  });

  test("handles empty output", () => {
    expect(parseWindowListOutput([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/cli/window.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement src/cli/window.ts**

```typescript
// src/cli/window.ts
import { runTmux, type TmuxResult } from "./tmux";
import { resolveCurrentSession, requireSession, CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

const WINDOW_FORMAT = "#{window_id}:#{window_index}:#{window_name}:#{window_active}:#{window_bell_flag}:#{window_zoomed_flag}";

interface WindowEntry {
  id: string;
  index: number;
  name: string;
  active: boolean;
  bell: boolean;
  zoomed: boolean;
}

export function parseWindowListOutput(lines: string[]): WindowEntry[] {
  return lines.filter(l => l.length > 0).map(line => {
    const [id, index, name, active, bell, zoomed] = line.split(":");
    return {
      id,
      index: parseInt(index, 10),
      name,
      active: active === "1",
      bell: bell === "1",
      zoomed: zoomed === "1",
    };
  });
}

function tmuxOrThrow(result: TmuxResult): string[] {
  if (!result.ok) throw new CliError(result.error);
  return result.lines;
}

export function handleWindow(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const session = (parsed.flags.session as string) || requireSession(ctx);

  switch (parsed.action) {
    case "list": {
      const lines = tmuxOrThrow(runTmux(`list-windows -t '${session}' -F '${WINDOW_FORMAT}'`, ctx.socket));
      return { windows: parseWindowListOutput(lines) };
    }

    case "create": {
      let cmd = `new-window -t '${session}'`;
      if (parsed.flags.dir && typeof parsed.flags.dir === "string") cmd += ` -c '${parsed.flags.dir}'`;
      if (parsed.flags.name && typeof parsed.flags.name === "string") cmd += ` -n '${parsed.flags.name}'`;
      tmuxOrThrow(runTmux(cmd, ctx.socket));

      // Get the newly created window (last one by index)
      const lines = tmuxOrThrow(runTmux(`list-windows -t '${session}' -F '${WINDOW_FORMAT}'`, ctx.socket));
      const windows = parseWindowListOutput(lines);
      const last = windows[windows.length - 1];
      return last ? { id: last.id, index: last.index, name: last.name } : {};
    }

    case "select": {
      if (!parsed.flags.target) throw new CliError("--target is required");
      tmuxOrThrow(runTmux(`select-window -t '${parsed.flags.target}'`, ctx.socket));
      return { selected: parsed.flags.target };
    }

    case "kill": {
      if (!parsed.flags.target) throw new CliError("--target is required");
      // Self-destruction guard
      if (!parsed.flags.force && ctx.paneId) {
        const currentWindow = runTmux(`display-message -t '${ctx.paneId}' -p '#{window_id}'`, ctx.socket);
        if (currentWindow.ok && currentWindow.lines[0] === parsed.flags.target) {
          throw new CliError("refusing to kill own window — use --force to override");
        }
      }
      tmuxOrThrow(runTmux(`kill-window -t '${parsed.flags.target}'`, ctx.socket));
      return { killed: parsed.flags.target };
    }

    default:
      throw new CliError(`unknown window action: ${parsed.action}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/cli/window.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/window.ts src/__tests__/cli/window.test.ts
git commit -m "feat: implement window subcommands

list, create, select, kill — with session resolution and safety guards."
```

---

### Task 7: Implement pane subcommands

**Files:**
- Modify: `src/cli/pane.ts` (replace stub)
- Test: `src/__tests__/cli/pane.test.ts`

- [ ] **Step 1: Write tests for pane output parsing**

```typescript
// src/__tests__/cli/pane.test.ts
import { describe, test, expect } from "bun:test";
import { parsePaneListOutput } from "../../cli/pane";

describe("parsePaneListOutput", () => {
  test("parses list-panes format string output", () => {
    const lines = [
      "%5:@1:1:120:40:claude:/Users/jarred/Code/project",
      "%6:@1:0:120:40:zsh:/Users/jarred/Code/project",
    ];
    const panes = parsePaneListOutput(lines);
    expect(panes).toEqual([
      { id: "%5", window: "@1", active: true, width: 120, height: 40, command: "claude", path: "/Users/jarred/Code/project" },
      { id: "%6", window: "@1", active: false, width: 120, height: 40, command: "zsh", path: "/Users/jarred/Code/project" },
    ]);
  });

  test("handles empty output", () => {
    expect(parsePaneListOutput([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/cli/pane.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement src/cli/pane.ts**

```typescript
// src/cli/pane.ts
import { readFileSync } from "fs";
import { runTmux, type TmuxResult } from "./tmux";
import { resolveCurrentSession, requireSession, CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

const PANE_FORMAT = "#{pane_id}:#{window_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_current_command}:#{pane_current_path}";

interface PaneEntry {
  id: string;
  window: string;
  active: boolean;
  width: number;
  height: number;
  command: string;
  path: string;
}

export function parsePaneListOutput(lines: string[]): PaneEntry[] {
  return lines.filter(l => l.length > 0).map(line => {
    const parts = line.split(":");
    const [id, window, active, width, height, command, ...pathParts] = parts;
    return {
      id,
      window,
      active: active === "1",
      width: parseInt(width, 10),
      height: parseInt(height, 10),
      command,
      path: pathParts.join(":") || "",
    };
  });
}

function tmuxOrThrow(result: TmuxResult): string[] {
  if (!result.ok) throw new CliError(result.error);
  return result.lines;
}

export function handlePane(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  switch (parsed.action) {
    case "list": {
      const session = (parsed.flags.session as string) || requireSession(ctx);
      let target = session;
      if (parsed.flags.window && typeof parsed.flags.window === "string") {
        target = `${parsed.flags.window}`;
      }
      const lines = tmuxOrThrow(runTmux(`list-panes -t '${target}' -F '${PANE_FORMAT}'`, ctx.socket));
      return { panes: parsePaneListOutput(lines) };
    }

    case "split": {
      const session = (parsed.flags.session as string) || requireSession(ctx);
      const dir = parsed.flags.direction === "h" ? "-h" : "-v";
      let cmd = `split-window ${dir} -t '${session}'`;
      if (parsed.flags.dir && typeof parsed.flags.dir === "string") cmd += ` -c '${parsed.flags.dir}'`;
      if (parsed.flags.command && typeof parsed.flags.command === "string") cmd += ` '${parsed.flags.command}'`;
      tmuxOrThrow(runTmux(cmd, ctx.socket));

      // Get the newly created pane (the active one after split)
      const paneLines = tmuxOrThrow(runTmux(`display-message -t '${session}' -p '#{pane_id}:#{window_id}'`, ctx.socket));
      const [paneId, windowId] = (paneLines[0] || "").split(":");
      return { pane: paneId, session, window: windowId };
    }

    case "send-keys": {
      if (!parsed.flags.target) throw new CliError("--target is required");
      const target = parsed.flags.target as string;

      // Resolve text from positional args, --file, or --stdin
      let text: string;
      if (parsed.flags.stdin) {
        text = readFileSync("/dev/stdin", "utf-8");
      } else if (parsed.flags.file && typeof parsed.flags.file === "string") {
        text = readFileSync(parsed.flags.file, "utf-8");
      } else if (parsed.positional.length > 0) {
        text = parsed.positional.join(" ");
      } else {
        throw new CliError("no text provided — use positional args, --file, or --stdin");
      }

      // send-keys needs text to be properly escaped for tmux
      // Use -l flag to send literal text (disables key name lookup)
      tmuxOrThrow(runTmux(`send-keys -t '${target}' -l ${JSON.stringify(text)}`, ctx.socket));

      // Send Enter unless --no-enter
      if (!parsed.flags["no-enter"]) {
        tmuxOrThrow(runTmux(`send-keys -t '${target}' Enter`, ctx.socket));
      }

      return { sent: true, target };
    }

    case "capture": {
      if (!parsed.flags.target) throw new CliError("--target is required");
      const target = parsed.flags.target as string;

      let cmd = `capture-pane -t '${target}' -p`;
      if (parsed.flags.raw) cmd += " -e"; // preserve escape sequences
      if (parsed.flags.lines && typeof parsed.flags.lines === "string") {
        const n = parseInt(parsed.flags.lines, 10);
        if (n > 0 && n <= 1000) {
          cmd += ` -S -${n}`; // scrollback lines above visible
        }
      }

      const result = runTmux(cmd, ctx.socket);
      if (!result.ok) throw new CliError(result.error);
      return { target, content: result.lines.join("\n") };
    }

    case "kill": {
      if (!parsed.flags.target) throw new CliError("--target is required");
      const target = parsed.flags.target as string;

      // Self-destruction guard
      if (!parsed.flags.force && ctx.paneId === target) {
        throw new CliError("refusing to kill own pane — use --force to override");
      }

      tmuxOrThrow(runTmux(`kill-pane -t '${target}'`, ctx.socket));
      return { killed: target };
    }

    default:
      throw new CliError(`unknown pane action: ${parsed.action}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/cli/pane.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/pane.ts src/__tests__/cli/pane.test.ts
git commit -m "feat: implement pane subcommands

list, split, send-keys, capture, kill — with --file/--stdin for
multiline input, ANSI stripping by default, safety guards."
```

---

### Task 8: Implement run-claude command

**Files:**
- Modify: `src/cli/run-claude.ts` (replace stub)
- Test: `src/__tests__/cli/run-claude.test.ts`

- [ ] **Step 1: Write tests for run-claude argument validation and command construction**

```typescript
// src/__tests__/cli/run-claude.test.ts
import { describe, test, expect } from "bun:test";
import { buildClaudeLaunchCommand, validateRunClaude } from "../../cli/run-claude";

describe("validateRunClaude", () => {
  test("requires --name", () => {
    expect(() => validateRunClaude({ dir: "/tmp" })).toThrow("--name is required");
  });

  test("requires --dir", () => {
    expect(() => validateRunClaude({ name: "foo" })).toThrow("--dir is required");
  });

  test("sanitizes name", () => {
    const result = validateRunClaude({ name: "foo.bar", dir: "/tmp" });
    expect(result.name).toBe("foo_bar");
  });
});

describe("buildClaudeLaunchCommand", () => {
  test("without message", () => {
    const cmd = buildClaudeLaunchCommand("claude", null, "/bin/zsh");
    expect(cmd).toBe("/bin/zsh -c 'claude; exec /bin/zsh'");
  });

  test("with temp file path", () => {
    const cmd = buildClaudeLaunchCommand("claude", "/tmp/jmux-prompt-abc123", "/bin/zsh");
    expect(cmd).toContain("cat /tmp/jmux-prompt-abc123");
    expect(cmd).toContain("rm -f /tmp/jmux-prompt-abc123");
    expect(cmd).toContain("exec /bin/zsh");
  });

  test("uses custom claude command", () => {
    const cmd = buildClaudeLaunchCommand("claude --model opus", null, "/bin/bash");
    expect(cmd).toBe("/bin/bash -c 'claude --model opus; exec /bin/bash'");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/cli/run-claude.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement src/cli/run-claude.ts**

```typescript
// src/cli/run-claude.ts
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { sanitizeTmuxSessionName, buildOtelResourceAttrs, loadUserConfig } from "../config";
import { runTmux, type TmuxResult } from "./tmux";
import { CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

export function validateRunClaude(flags: Record<string, string | boolean>): { name: string; dir: string } {
  if (!flags.name || typeof flags.name !== "string") throw new CliError("--name is required");
  if (!flags.dir || typeof flags.dir !== "string") throw new CliError("--dir is required");
  return {
    name: sanitizeTmuxSessionName(flags.name),
    dir: flags.dir,
  };
}

export function buildClaudeLaunchCommand(
  claudeCmd: string,
  promptTempFile: string | null,
  shell: string,
): string {
  if (promptTempFile) {
    // Read prompt from temp file, clean up, then exec shell on exit
    return `${shell} -c '${claudeCmd} -p "$(cat ${promptTempFile})"; rm -f ${promptTempFile}; exec ${shell}'`;
  }
  return `${shell} -c '${claudeCmd}; exec ${shell}'`;
}

function tmuxOrThrow(result: TmuxResult): string[] {
  if (!result.ok) throw new CliError(result.error);
  return result.lines;
}

export function handleRunClaude(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const { name, dir } = validateRunClaude(parsed.flags);
  const config = loadUserConfig();
  const claudeCmd = config.claudeCommand || "claude";
  const shell = process.env.SHELL || "/bin/sh";
  const otel = buildOtelResourceAttrs(name);

  // Handle --message / --message-file → temp file
  let promptTempFile: string | null = null;

  if (parsed.flags.message && typeof parsed.flags.message === "string") {
    promptTempFile = resolve(tmpdir(), `jmux-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    writeFileSync(promptTempFile, parsed.flags.message);
  } else if (parsed.flags["message-file"] && typeof parsed.flags["message-file"] === "string") {
    // Use the file directly — no need to copy
    promptTempFile = parsed.flags["message-file"] as string;
  }

  const launchCmd = buildClaudeLaunchCommand(claudeCmd, promptTempFile, shell);
  const tmuxCmd = `new-session -d -e 'OTEL_RESOURCE_ATTRIBUTES=${otel}' -s '${name}' -c '${dir}' '${launchCmd}'`;
  tmuxOrThrow(runTmux(tmuxCmd, ctx.socket));

  // Get pane ID of the new session
  const paneResult = runTmux(`display-message -t '${name}' -p '#{pane_id}'`, ctx.socket);
  const paneId = paneResult.ok && paneResult.lines[0] ? paneResult.lines[0] : "";

  return {
    session: name,
    pane: paneId,
    claude_command: claudeCmd,
    command_dispatched: true,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/cli/run-claude.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/run-claude.ts src/__tests__/cli/run-claude.test.ts
git commit -m "feat: implement run-claude command

Creates session with Claude Code, shell-wrapped so exiting drops to
a live shell. Prompts go through temp files to avoid shell escaping."
```

---

### Task 9: Integration test and typecheck

Verify everything compiles, all tests pass, and the `jmux ctl` routing works end-to-end.

**Files:**
- All `src/cli/*.ts` and `src/__tests__/cli/*.test.ts`

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No type errors

- [ ] **Step 3: Verify CLI routing works (smoke test)**

Run: `bun run src/main.ts ctl session list 2>&1 || true`

This will fail (no tmux server running in test context) but should fail with a JSON error from the CLI, not a crash or TUI startup. Expected output:
```json
{"error": "...tmux error message..."}
```

If it starts the TUI instead, the routing is broken.

- [ ] **Step 4: Verify help still works**

Run: `bun run src/main.ts --help`
Expected: Prints the help text, not a crash

- [ ] **Step 5: Fix any issues found**

Address any type errors, test failures, or routing issues.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve integration issues from CLI implementation"
```

---

### Task 10: Update CLAUDE.md and help text

Document the new `ctl` subcommand in the project's existing documentation.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/main.ts:33-70` (HELP string)

- [ ] **Step 1: Add ctl to HELP text**

Add a `jmux ctl` section to the HELP string in `src/main.ts`. After the existing Examples section:

```
Agent Control:
  jmux ctl session list          List sessions (JSON)
  jmux ctl session create        Create a session
  jmux ctl run-claude            Launch Claude Code in a new session
  jmux ctl pane capture          Read pane contents
  jmux ctl --help                Show all ctl subcommands
```

- [ ] **Step 2: Add ctl help subcommand**

In `src/cli.ts`, when `argv` is empty or `argv[0]` is `--help` or `-h`, print a ctl-specific help message instead of erroring:

```typescript
const CTL_HELP = `jmux ctl — programmatic control for agents

Usage: jmux ctl <group> <action> [flags]

Groups:
  session   list | create | info | switch | kill | rename | set-attention
  window    list | create | select | kill
  pane      list | split | send-keys | capture | kill
  run-claude  Launch Claude Code in a new session

Global flags:
  --session <name>    Target session (default: current)
  --socket <name>     tmux server socket (default: from $TMUX)
  -L <name>           Alias for --socket

All output is JSON. Errors go to stderr as {"error": "..."}.
`;
```

- [ ] **Step 3: Update CLAUDE.md Commands section**

Add the ctl commands to the Commands section:

```markdown
bun run src/main.ts ctl session list   # List sessions (JSON, for agent use)
bun run src/main.ts ctl --help         # Show all ctl subcommands
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/cli.ts CLAUDE.md
git commit -m "docs: add jmux ctl to help text and CLAUDE.md"
```

---

### Task 11: Write the agent skill document

The skill file that ships with jmux and teaches agents how to use the CLI.

**Files:**
- Create: `skills/jmux-control.md`

- [ ] **Step 1: Write the skill document**

```markdown
---
name: jmux-control
description: Control jmux sessions, windows, and panes programmatically. Dispatch Claude Code instances, monitor their progress, and interact with them. Use when inside a jmux-managed tmux session ($JMUX=1).
---

# jmux Agent Control

You are inside a jmux-managed tmux session. You can create sibling sessions,
dispatch other Claude Code instances, monitor their progress, and interact
with them using the `jmux ctl` CLI.

## Detection

Check: `echo $JMUX` — if it prints `1`, you're inside jmux and these commands
are available. If not, these commands will not work.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `jmux ctl session list` | List all sessions |
| `jmux ctl session create --name N --dir PATH` | Create new session |
| `jmux ctl session info --target NAME` | Session details + attention flag |
| `jmux ctl session kill --target NAME` | Kill a session |
| `jmux ctl run-claude --name N --dir PATH --message "..."` | Launch Claude Code |
| `jmux ctl window list` | List windows in current session |
| `jmux ctl window create` | Create new window |
| `jmux ctl pane list` | List panes in current window |
| `jmux ctl pane split --direction h` | Split pane horizontally |
| `jmux ctl pane send-keys --target %ID text` | Type into a pane |
| `jmux ctl pane capture --target %ID` | Read pane contents |
| `jmux ctl session set-attention --target NAME` | Flag for human review |

All commands output JSON. Parse it — don't regex it.

## Conventions

1. **Use returned names.** Session names are sanitized (`.` and `:` become `_`).
   Always use the `name` field from the response, not your original input.

2. **Use IDs from responses.** Capture `id`, `pane`, `window` fields from
   create/list responses and pass them to `--target` in later commands.

3. **Don't kill what you didn't create.** Only kill sessions/panes you spawned.

4. **Check attention, don't poll capture.** Use `jmux ctl session info --target NAME`
   and check the `attention` field to know when a Claude instance finished.
   Only use `pane capture` when you need the actual content.

## Patterns

### Fan-Out: Dispatch N agents for independent tasks

```bash
# Spawn agents
result1=$(jmux ctl run-claude --name task-auth --dir /repo --message "Fix auth bug in src/auth.ts")
result2=$(jmux ctl run-claude --name task-tests --dir /repo --message "Add tests for src/utils.ts")

# Monitor — poll attention flags
while true; do
  info1=$(jmux ctl session info --target task-auth)
  info2=$(jmux ctl session info --target task-tests)
  # Check attention field in JSON...
  sleep 10
done
```

### Pipeline: Chain agents sequentially

```bash
# Step 1: dispatch first agent
jmux ctl run-claude --name step1 --dir /repo --message "Analyze the auth module"

# Step 2: wait for completion
while true; do
  info=$(jmux ctl session info --target step1)
  # parse attention from JSON — if true, agent finished
  sleep 10
done

# Step 3: capture output, feed to next agent
output=$(jmux ctl pane capture --target %ID --lines 100)
jmux ctl run-claude --name step2 --dir /repo --message "Based on this analysis: $output ..."
```

### Interact: Send follow-up to a running agent

```bash
# Send a follow-up prompt
jmux ctl pane send-keys --target %12 "Now refactor the auth middleware"
```

## Limitations

- No real-time streaming — use polling with `session info` and `pane capture`
- `session switch` only works from inside tmux (not from external processes)
- `pane capture` returns a point-in-time snapshot, not live output
- The CLI does not manage tmux config, keybindings, or display settings
- Worktree creation is not supported — use `session create` with plain directories
```

- [ ] **Step 2: Commit**

```bash
git add skills/jmux-control.md
git commit -m "feat: add jmux-control agent skill document

Teaches agents how to use jmux ctl for session orchestration,
agent dispatch, monitoring, and interaction."
```

---

### Task 12: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No type errors

- [ ] **Step 3: Verify skill file is well-formed**

Read `skills/jmux-control.md` and verify the frontmatter is valid YAML and the content matches the spec.

- [ ] **Step 4: Verify `package.json` files field includes skills dir if we want it shipped with npm**

Check if `skills/` needs to be added to the `files` array in `package.json`. If the skill should ship with the npm package, add `"skills"` to the array.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "chore: final verification and cleanup for agent control CLI"
```
