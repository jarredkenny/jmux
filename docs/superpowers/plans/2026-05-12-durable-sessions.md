# Durable Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make jmux sessions survive system crashes by snapshotting structural state + scrollback to disk and silently restoring on next launch, with Claude panes resumed via `--continue`.

**Architecture:** New `src/snapshot/` module with three injection seams (`FileSystem`, `TmuxRunner`, `Clock`) so 95%+ of behavior is testable without spawning tmux. `Snapshotter` writes atomic `state.json` (event-driven, debounced) + per-pane scrollback files (5 s timer). `Restorer` runs once at boot via direct `TmuxRunner` calls (because `tmux -C attach` exits on an empty server) and rebuilds the session tree before `TmuxControl` connects. Existing `TmuxPty`, `TmuxControl`, `SessionState`, `OtelReceiver` get small surgical changes to support strict attach, reconnect, and change events.

**Tech Stack:** TypeScript (strict), Bun 1.3.8+, `bun-pty`, `bun:test`, real tmux 3.2+ for one integration test.

**Spec:** `docs/superpowers/specs/2026-05-12-durable-sessions-design.md` (commits `35c71f0`, `9d85a2c`, `6143377`).

---

## File Structure

**New files (snapshot module):**
- `src/snapshot/schema.ts` — types + validator (pure)
- `src/snapshot/deps.ts` — `FileSystem`, `TmuxRunner`, `Clock` interfaces
- `src/snapshot/fs.ts` — production `FileSystem` impl with atomic write + flock
- `src/snapshot/runner.ts` — production `TmuxRunner` impl wrapping `Bun.spawn`
- `src/snapshot/clock.ts` — production `Clock` impl
- `src/snapshot/model.ts` — `SnapshotModel` (in-memory builder, pure)
- `src/snapshot/painter.ts` — `buildPainterArgv` pure function
- `src/snapshot/migrations.ts` — migration registry (v1 has none, pipeline tested)
- `src/snapshot/log.ts` — `restore.log` JSONL writer
- `src/snapshot/capture.ts` — `Snapshotter` class
- `src/snapshot/restore.ts` — `Restorer` class
- `src/snapshot/index.ts` — public re-exports

**New tests:**
- `src/__tests__/snapshot/schema.test.ts`
- `src/__tests__/snapshot/fs.test.ts`
- `src/__tests__/snapshot/painter-argv.test.ts`
- `src/__tests__/snapshot/migrations.test.ts`
- `src/__tests__/snapshot/capture-events.test.ts`
- `src/__tests__/snapshot/capture-debounce.test.ts`
- `src/__tests__/snapshot/capture-scrollback.test.ts`
- `src/__tests__/snapshot/capture-lock.test.ts`
- `src/__tests__/snapshot/capture-atomic.test.ts`
- `src/__tests__/snapshot/restore-eligibility.test.ts`
- `src/__tests__/snapshot/restore-sequence.test.ts`
- `src/__tests__/snapshot/restore-partial.test.ts`
- `src/__tests__/snapshot/restore-missing-cwd.test.ts`
- `src/__tests__/snapshot/restore-links-upsert.test.ts`
- `src/__tests__/snapshot/restore-attach-target.test.ts`
- `src/__tests__/snapshot/multi-socket.test.ts`
- `src/__tests__/snapshot/tmux-pty-strict-attach.test.ts`
- `src/__tests__/snapshot/tmux-control-reconnect.test.ts`
- `src/__tests__/snapshot/integration-tmux.test.ts`

**Modified files:**
- `src/tmux-pty.ts` — add `attachMode` option
- `src/tmux-control.ts` — spawn injection seam + EOF reconnect with backoff
- `src/session-state.ts` — change events + `upsertLinksForSession`
- `src/otel-receiver.ts` — per-session change event
- `src/config.ts` — `snapshot` namespace
- `src/main.ts` — boot reordering + wire `Snapshotter`/`Restorer`
- `src/types.ts` — re-export PermissionMode if needed by schema

---

## Conventions

- **Commits per task:** every task ends with one commit. Conventional commits style (`feat(snapshot): ...`, `test(snapshot): ...`, `refactor(tmux-control): ...`). No `Co-Authored-By` footer (per CLAUDE.md).
- **Test runner:** `bun test <path>` for one file; `bun test` for the whole suite. Tests import from `bun:test`.
- **Type checking:** `bun run typecheck` after each task before commit. Failure blocks the commit.
- **Test isolation:** tasks 1–22 use injected dependencies — no filesystem, no subprocess, no real timers. Task 23 is the deliberate real-tmux exception.

---

## Task 1: Snapshot schema types and validator

**Files:**
- Create: `src/snapshot/schema.ts`
- Test: `src/__tests__/snapshot/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/snapshot/schema.test.ts
import { describe, test, expect } from "bun:test";
import {
  SNAPSHOT_FORMAT_VERSION,
  validateSnapshot,
  type SnapshotFile,
} from "../../snapshot/schema";

const good: SnapshotFile = {
  formatVersion: 1,
  jmuxVersion: "0.16.0",
  capturedAt: "2026-05-12T18:00:00.000Z",
  tmuxSocket: "",
  lastFocusedSession: "feature-x",
  sessions: [
    {
      name: "feature-x",
      cwd: "/repos/foo",
      worktreePath: null,
      projectGroup: null,
      pinned: false,
      attention: false,
      permissionMode: "default",
      otel: null,
      links: [],
      windows: [
        {
          index: 0,
          name: "main",
          layout: "b46c,200x50,0,0,0",
          active: true,
          panes: [
            {
              index: 0,
              cwd: "/repos/foo",
              command: "zsh",
              kind: "shell",
              scrollbackFile: null,
            },
          ],
        },
      ],
    },
  ],
};

describe("snapshot schema", () => {
  test("format version is 1", () => {
    expect(SNAPSHOT_FORMAT_VERSION).toBe(1);
  });

  test("validateSnapshot accepts a well-formed object", () => {
    const result = validateSnapshot(good);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot rejects unknown formatVersion", () => {
    const bad = { ...good, formatVersion: 999 } as unknown;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("formatVersion");
  });

  test("validateSnapshot rejects malformed pane.kind", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.sessions[0].windows[0].panes[0].kind = "wrong";
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
  });

  test("validateSnapshot rejects non-ISO capturedAt", () => {
    const bad = { ...good, capturedAt: "yesterday" };
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
  });

  test("validateSnapshot rejects missing sessions array", () => {
    const bad = { ...good, sessions: undefined } as unknown;
    const result = validateSnapshot(bad);
    expect(result.ok).toBe(false);
  });

  test("validateSnapshot round-trips via JSON", () => {
    const json = JSON.stringify(good);
    const parsed = JSON.parse(json);
    const result = validateSnapshot(parsed);
    expect(result.ok).toBe(true);
  });

  test("validateSnapshot accepts permissionMode 'accept-edits'", () => {
    const variant = JSON.parse(JSON.stringify(good));
    variant.sessions[0].permissionMode = "accept-edits";
    const result = validateSnapshot(variant);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/__tests__/snapshot/schema.test.ts`
Expected: FAIL — module `../../snapshot/schema` not found.

- [ ] **Step 3: Implement schema**

```ts
// src/snapshot/schema.ts
export const SNAPSHOT_FORMAT_VERSION = 1 as const;

export type PaneKind = "claude" | "shell" | "other";
export type SnapshotPermissionMode = "default" | "plan" | "accept-edits" | null;

export interface SessionLink {
  type: "issue" | "mr";
  id: string;
}

export interface SnapshotOtel {
  costUsd: number;
  cacheWasHit: boolean | null;
  lastRequestTime: string | null;
  lastCompactionTime: string | null;
  lastTool: string | null;
  lastUserPromptTime: string | null;
  lastError: string | null;
  failedMcpServers: string[];
}

export interface SnapshotPane {
  index: number;
  cwd: string;
  command: string;
  kind: PaneKind;
  scrollbackFile: string | null;
}

export interface SnapshotWindow {
  index: number;
  name: string;
  layout: string;
  active: boolean;
  panes: SnapshotPane[];
}

export interface SnapshotSession {
  name: string;
  cwd: string;
  worktreePath: string | null;
  projectGroup: string | null;
  pinned: boolean;
  attention: boolean;
  permissionMode: SnapshotPermissionMode;
  otel: SnapshotOtel | null;
  links: SessionLink[];
  windows: SnapshotWindow[];
}

export interface SnapshotFile {
  formatVersion: 1;
  jmuxVersion: string;
  capturedAt: string;
  tmuxSocket: string;
  lastFocusedSession: string | null;
  sessions: SnapshotSession[];
}

export type ValidationResult =
  | { ok: true; value: SnapshotFile }
  | { ok: false; error: string };

const ISO_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validatePane(v: unknown, path: string): string | null {
  if (!isRecord(v)) return `${path}: not an object`;
  if (!isFiniteNumber(v.index)) return `${path}.index: not a number`;
  if (!isString(v.cwd)) return `${path}.cwd: not a string`;
  if (!isString(v.command)) return `${path}.command: not a string`;
  if (v.kind !== "claude" && v.kind !== "shell" && v.kind !== "other") {
    return `${path}.kind: invalid value`;
  }
  if (v.scrollbackFile !== null && !isString(v.scrollbackFile)) {
    return `${path}.scrollbackFile: not string or null`;
  }
  return null;
}

function validateWindow(v: unknown, path: string): string | null {
  if (!isRecord(v)) return `${path}: not an object`;
  if (!isFiniteNumber(v.index)) return `${path}.index: not a number`;
  if (!isString(v.name)) return `${path}.name: not a string`;
  if (!isString(v.layout)) return `${path}.layout: not a string`;
  if (!isBoolean(v.active)) return `${path}.active: not a boolean`;
  if (!Array.isArray(v.panes)) return `${path}.panes: not an array`;
  for (let i = 0; i < v.panes.length; i++) {
    const err = validatePane(v.panes[i], `${path}.panes[${i}]`);
    if (err) return err;
  }
  return null;
}

function validateLink(v: unknown, path: string): string | null {
  if (!isRecord(v)) return `${path}: not an object`;
  if (v.type !== "issue" && v.type !== "mr") return `${path}.type: invalid`;
  if (!isString(v.id)) return `${path}.id: not a string`;
  return null;
}

function validateOtel(v: unknown, path: string): string | null {
  if (v === null) return null;
  if (!isRecord(v)) return `${path}: not an object or null`;
  if (!isFiniteNumber(v.costUsd)) return `${path}.costUsd: not a number`;
  if (v.cacheWasHit !== null && !isBoolean(v.cacheWasHit)) {
    return `${path}.cacheWasHit: not boolean or null`;
  }
  const nullableStrings = [
    "lastRequestTime",
    "lastCompactionTime",
    "lastTool",
    "lastUserPromptTime",
    "lastError",
  ] as const;
  for (const k of nullableStrings) {
    if (v[k] !== null && !isString(v[k])) {
      return `${path}.${k}: not string or null`;
    }
  }
  if (!Array.isArray(v.failedMcpServers)) {
    return `${path}.failedMcpServers: not an array`;
  }
  for (let i = 0; i < v.failedMcpServers.length; i++) {
    if (!isString(v.failedMcpServers[i])) {
      return `${path}.failedMcpServers[${i}]: not a string`;
    }
  }
  return null;
}

function validateSession(v: unknown, path: string): string | null {
  if (!isRecord(v)) return `${path}: not an object`;
  if (!isString(v.name)) return `${path}.name: not a string`;
  if (!isString(v.cwd)) return `${path}.cwd: not a string`;
  if (v.worktreePath !== null && !isString(v.worktreePath)) {
    return `${path}.worktreePath: not string or null`;
  }
  if (v.projectGroup !== null && !isString(v.projectGroup)) {
    return `${path}.projectGroup: not string or null`;
  }
  if (!isBoolean(v.pinned)) return `${path}.pinned: not a boolean`;
  if (!isBoolean(v.attention)) return `${path}.attention: not a boolean`;
  if (
    v.permissionMode !== null &&
    v.permissionMode !== "default" &&
    v.permissionMode !== "plan" &&
    v.permissionMode !== "accept-edits"
  ) {
    return `${path}.permissionMode: invalid value`;
  }
  const otelErr = validateOtel(v.otel, `${path}.otel`);
  if (otelErr) return otelErr;
  if (!Array.isArray(v.links)) return `${path}.links: not an array`;
  for (let i = 0; i < v.links.length; i++) {
    const err = validateLink(v.links[i], `${path}.links[${i}]`);
    if (err) return err;
  }
  if (!Array.isArray(v.windows)) return `${path}.windows: not an array`;
  for (let i = 0; i < v.windows.length; i++) {
    const err = validateWindow(v.windows[i], `${path}.windows[${i}]`);
    if (err) return err;
  }
  return null;
}

export function validateSnapshot(input: unknown): ValidationResult {
  if (!isRecord(input)) return { ok: false, error: "root: not an object" };
  if (input.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    return {
      ok: false,
      error: `root.formatVersion: expected ${SNAPSHOT_FORMAT_VERSION}, got ${String(input.formatVersion)}`,
    };
  }
  if (!isString(input.jmuxVersion)) {
    return { ok: false, error: "root.jmuxVersion: not a string" };
  }
  if (!isString(input.capturedAt) || !ISO_RX.test(input.capturedAt)) {
    return { ok: false, error: "root.capturedAt: not an ISO timestamp" };
  }
  if (!isString(input.tmuxSocket)) {
    return { ok: false, error: "root.tmuxSocket: not a string" };
  }
  if (
    input.lastFocusedSession !== null &&
    !isString(input.lastFocusedSession)
  ) {
    return { ok: false, error: "root.lastFocusedSession: not string or null" };
  }
  if (!Array.isArray(input.sessions)) {
    return { ok: false, error: "root.sessions: not an array" };
  }
  for (let i = 0; i < input.sessions.length; i++) {
    const err = validateSession(input.sessions[i], `root.sessions[${i}]`);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, value: input as unknown as SnapshotFile };
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `bun test src/__tests__/snapshot/schema.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/snapshot/schema.ts src/__tests__/snapshot/schema.test.ts
git commit -m "feat(snapshot): add SnapshotFile schema and validator"
```

---

## Task 2: Injection seam interfaces + production FileSystem

**Files:**
- Create: `src/snapshot/deps.ts`
- Create: `src/snapshot/fs.ts`
- Test: `src/__tests__/snapshot/fs.test.ts`

- [ ] **Step 1: Write the failing test for atomic write**

```ts
// src/__tests__/snapshot/fs.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProductionFileSystem } from "../../snapshot/fs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jmux-fs-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ProductionFileSystem.writeAtomic", () => {
  test("writes file and contents are readable", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "out.json");
    await fs.writeAtomic(path, new TextEncoder().encode("hello"));
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  test("no .tmp file remains after success", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "out.json");
    await fs.writeAtomic(path, new TextEncoder().encode("hello"));
    expect(existsSync(path + ".tmp")).toBe(false);
  });

  test("overwrites existing file", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "out.json");
    writeFileSync(path, "old");
    await fs.writeAtomic(path, new TextEncoder().encode("new"));
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  test("creates parent directories on demand", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "a", "b", "c", "out.json");
    await fs.writeAtomic(path, new TextEncoder().encode("ok"));
    expect(readFileSync(path, "utf8")).toBe("ok");
  });
});

describe("ProductionFileSystem.readFile", () => {
  test("returns null for missing file", async () => {
    const fs = new ProductionFileSystem();
    const result = await fs.readFile(join(dir, "missing"));
    expect(result).toBeNull();
  });

  test("returns bytes for existing file", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "f");
    writeFileSync(path, "abc");
    const result = await fs.readFile(path);
    expect(result).not.toBeNull();
    expect(new TextDecoder().decode(result!)).toBe("abc");
  });
});

describe("ProductionFileSystem.lock", () => {
  test("acquires lock on a fresh path", async () => {
    const fs = new ProductionFileSystem();
    const lock = await fs.lock(join(dir, ".lock"));
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  test("second acquisition returns null while first is held", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, ".lock");
    const first = await fs.lock(path);
    expect(first).not.toBeNull();
    const second = await fs.lock(path);
    expect(second).toBeNull();
    await first!.release();
  });

  test("after release, lock can be re-acquired", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, ".lock");
    const first = await fs.lock(path);
    await first!.release();
    const second = await fs.lock(path);
    expect(second).not.toBeNull();
    await second!.release();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/snapshot/fs.test.ts`
Expected: FAIL — `../../snapshot/fs` not found.

- [ ] **Step 3: Implement deps interfaces**

```ts
// src/snapshot/deps.ts
export interface Lock {
  release(): Promise<void>;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
}

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array | null>;
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readDir(path: string): Promise<string[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  stat(path: string): Promise<FileStat | null>;
  lock(path: string): Promise<Lock | null>;
}

export interface TmuxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TmuxRunner {
  run(args: string[], opts?: { timeoutMs?: number }): Promise<TmuxRunResult>;
}

export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): () => void;
  setTimeout(fn: () => void, ms: number): () => void;
}
```

- [ ] **Step 4: Implement ProductionFileSystem**

```ts
// src/snapshot/fs.ts
import { promises as fsp, constants as fsConstants } from "fs";
import { dirname } from "path";
import type { FileSystem, FileStat, Lock } from "./deps";

export class ProductionFileSystem implements FileSystem {
  async readFile(path: string): Promise<Uint8Array | null> {
    try {
      const buf = await fsp.readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const fh = await fsp.open(tmp, "w");
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, path);
  }

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to);
  }

  async unlink(path: string): Promise<void> {
    try {
      await fsp.unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async readDir(path: string): Promise<string[]> {
    try {
      return await fsp.readdir(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await fsp.mkdir(path, { recursive });
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await fsp.stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async lock(path: string): Promise<Lock | null> {
    await fsp.mkdir(dirname(path), { recursive: true });
    let handle: Awaited<ReturnType<typeof fsp.open>>;
    try {
      handle = await fsp.open(
        path,
        fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_EXCL,
        0o600,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
    return {
      release: async () => {
        await handle.close();
        await fsp.unlink(path).catch(() => undefined);
      },
    };
  }
}
```

> Note: real `flock(2)` is preferable to lockfile-by-creation, but the latter is portable across macOS/Linux without native bindings. The release path unlinks, so a crashed jmux orphans a `.lock` file; the production FS startup sweep (Task 8) removes stale lockfiles older than 60 s before attempting acquisition.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/__tests__/snapshot/fs.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/snapshot/deps.ts src/snapshot/fs.ts src/__tests__/snapshot/fs.test.ts
git commit -m "feat(snapshot): add injection seams and production FileSystem"
```

---

## Task 3: Production TmuxRunner and Clock

**Files:**
- Create: `src/snapshot/runner.ts`
- Create: `src/snapshot/clock.ts`

> No new tests — `runner.ts` is exercised end-to-end by the integration test in Task 23, and `clock.ts` is a trivial pass-through to global `setInterval`/`setTimeout` which `bun:test` already simulates. Keeping these production-only files small avoids redundant coverage churn.

- [ ] **Step 1: Implement TmuxRunner**

```ts
// src/snapshot/runner.ts
import type { TmuxRunner, TmuxRunResult } from "./deps";

export class ProductionTmuxRunner implements TmuxRunner {
  constructor(private readonly socketName: string | null = null) {}

  async run(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<TmuxRunResult> {
    const full = this.socketName ? ["-L", this.socketName, ...args] : args;
    const proc = Bun.spawn(["tmux", ...full], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const killer = setTimeout(() => {
      proc.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(killer);
    }
  }
}
```

- [ ] **Step 2: Implement Clock**

```ts
// src/snapshot/clock.ts
import type { Clock } from "./deps";

export class ProductionClock implements Clock {
  now(): number {
    return Date.now();
  }

  setInterval(fn: () => void, ms: number): () => void {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/snapshot/runner.ts src/snapshot/clock.ts
git commit -m "feat(snapshot): add production TmuxRunner and Clock"
```

---

## Task 4: Painter argv builder

**Files:**
- Create: `src/snapshot/painter.ts`
- Test: `src/__tests__/snapshot/painter-argv.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/snapshot/painter-argv.test.ts
import { describe, test, expect } from "bun:test";
import { buildPainterArgv, detectPaneKind } from "../../snapshot/painter";

describe("buildPainterArgv", () => {
  test("emits sh -c wrapper for claude pane", () => {
    const argv = buildPainterArgv({
      scrollbackPath: "/snap/scrollback/a/0-0.ansi",
      capturedAt: "2026-05-12T18:00:00.000Z",
      kind: "claude",
      claudeCommand: "claude",
      userShell: "/bin/zsh",
    });
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    expect(argv[3]).toBe("jmux-restore");
    expect(argv[4]).toBe("/snap/scrollback/a/0-0.ansi");
    expect(argv[5]).toBe("2026-05-12T18:00:00.000Z");
    // tail
    expect(argv.slice(6)).toEqual(["claude", "--continue"]);
  });

  test("splits multi-word claudeCommand correctly", () => {
    const argv = buildPainterArgv({
      scrollbackPath: "/x",
      capturedAt: "2026-05-12T00:00:00Z",
      kind: "claude",
      claudeCommand: "bun run claude",
      userShell: "/bin/zsh",
    });
    expect(argv.slice(6)).toEqual(["bun", "run", "claude", "--continue"]);
  });

  test("shell pane tail uses userShell -i", () => {
    const argv = buildPainterArgv({
      scrollbackPath: "/x",
      capturedAt: "2026-05-12T00:00:00Z",
      kind: "shell",
      claudeCommand: "claude",
      userShell: "/bin/bash",
    });
    expect(argv.slice(6)).toEqual(["/bin/bash", "-i"]);
  });

  test("other pane tail is same as shell", () => {
    const argv = buildPainterArgv({
      scrollbackPath: "/x",
      capturedAt: "2026-05-12T00:00:00Z",
      kind: "other",
      claudeCommand: "claude",
      userShell: "/bin/zsh",
    });
    expect(argv.slice(6)).toEqual(["/bin/zsh", "-i"]);
  });

  test("script body uses positional args, never interpolates user data", () => {
    const argv = buildPainterArgv({
      scrollbackPath: "/path with spaces; rm -rf /",
      capturedAt: "2026-05-12T00:00:00Z",
      kind: "shell",
      claudeCommand: "claude",
      userShell: "/bin/zsh",
    });
    const body = argv[2];
    expect(body).not.toContain("/path with spaces");
    expect(body).not.toContain("rm -rf");
    expect(body).toContain('"$F"');
  });
});

describe("detectPaneKind", () => {
  test("recognizes plain claude", () => {
    expect(detectPaneKind("claude")).toBe("claude");
  });
  test("recognizes claude with args", () => {
    expect(detectPaneKind("claude --resume foo")).toBe("claude");
  });
  test("recognizes bun run claude", () => {
    expect(detectPaneKind("bun run claude --print")).toBe("claude");
  });
  test("treats shell as shell", () => {
    expect(detectPaneKind("zsh")).toBe("shell");
    expect(detectPaneKind("/bin/bash -i")).toBe("shell");
    expect(detectPaneKind("fish")).toBe("shell");
  });
  test("everything else is other", () => {
    expect(detectPaneKind("bun run dev")).toBe("other");
    expect(detectPaneKind("vim README.md")).toBe("other");
    expect(detectPaneKind("")).toBe("other");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/snapshot/painter-argv.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement painter**

```ts
// src/snapshot/painter.ts
import type { PaneKind } from "./schema";

export interface PainterInput {
  scrollbackPath: string;
  capturedAt: string;
  kind: PaneKind;
  claudeCommand: string;
  userShell: string;
}

const PAINTER_BODY =
  'F=$1; [ -s "$F" ] && cat "$F"; ' +
  'printf "\\n\\033[2m--- restored @ %s ---\\033[0m\\n" "$2"; ' +
  'shift 2; exec "$@"';

function tokenize(cmd: string): string[] {
  return cmd
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildPainterArgv(input: PainterInput): string[] {
  const tail =
    input.kind === "claude"
      ? [...tokenize(input.claudeCommand), "--continue"]
      : [input.userShell, "-i"];

  return [
    "sh",
    "-c",
    PAINTER_BODY,
    "jmux-restore",
    input.scrollbackPath,
    input.capturedAt,
    ...tail,
  ];
}

const SHELL_NAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
]);

export function detectPaneKind(command: string): PaneKind {
  const tokens = tokenize(command);
  if (tokens.length === 0) return "other";

  // Walk past "bun run", "npm run", "pnpm run", "yarn run" prefixes.
  let i = 0;
  while (
    i + 1 < tokens.length &&
    (tokens[i] === "bun" ||
      tokens[i] === "npm" ||
      tokens[i] === "pnpm" ||
      tokens[i] === "yarn") &&
    tokens[i + 1] === "run"
  ) {
    i += 2;
  }
  if (i < tokens.length) {
    const head = tokens[i];
    if (head === "claude" || head.endsWith("/claude")) return "claude";
  }

  const head = tokens[0];
  const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
  if (SHELL_NAMES.has(base)) return "shell";

  return "other";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/snapshot/painter-argv.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/snapshot/painter.ts src/__tests__/snapshot/painter-argv.test.ts
git commit -m "feat(snapshot): add painter argv builder and pane-kind detection"
```

---

## Task 5: Migrations registry

**Files:**
- Create: `src/snapshot/migrations.ts`
- Test: `src/__tests__/snapshot/migrations.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/snapshot/migrations.test.ts
import { describe, test, expect } from "bun:test";
import { MigrationRegistry } from "../../snapshot/migrations";

describe("MigrationRegistry", () => {
  test("returns input unchanged when version matches target", () => {
    const reg = new MigrationRegistry(1);
    const input = { formatVersion: 1, foo: "bar" };
    const result = reg.migrate(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(input);
  });

  test("applies registered migrator to step up versions", () => {
    const reg = new MigrationRegistry(1);
    reg.register(0, 1, (v) => ({ ...v, formatVersion: 1, migrated: true }));
    const result = reg.migrate({ formatVersion: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveProperty("migrated", true);
      expect((result.value as { formatVersion: number }).formatVersion).toBe(1);
    }
  });

  test("chains migrators across multiple versions", () => {
    const reg = new MigrationRegistry(2);
    reg.register(0, 1, (v) => ({ ...v, formatVersion: 1, a: true }));
    reg.register(1, 2, (v) => ({ ...v, formatVersion: 2, b: true }));
    const result = reg.migrate({ formatVersion: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveProperty("a", true);
      expect(result.value).toHaveProperty("b", true);
    }
  });

  test("fails when no path from source to target", () => {
    const reg = new MigrationRegistry(2);
    reg.register(0, 1, (v) => ({ ...v, formatVersion: 1 }));
    const result = reg.migrate({ formatVersion: 0 });
    expect(result.ok).toBe(false);
  });

  test("fails when input has unknown future formatVersion", () => {
    const reg = new MigrationRegistry(1);
    const result = reg.migrate({ formatVersion: 999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("999");
  });

  test("fails when input is not an object", () => {
    const reg = new MigrationRegistry(1);
    const result = reg.migrate("not an object");
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/snapshot/migrations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement migrations registry**

```ts
// src/snapshot/migrations.ts
type Migrator = (input: Record<string, unknown>) => Record<string, unknown>;

export type MigrationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export class MigrationRegistry {
  private migrators = new Map<number, { to: number; fn: Migrator }>();

  constructor(private readonly targetVersion: number) {}

  register(from: number, to: number, fn: Migrator): void {
    if (this.migrators.has(from)) {
      throw new Error(`migrator already registered for from=${from}`);
    }
    this.migrators.set(from, { to, fn });
  }

  migrate(input: unknown): MigrationResult {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, error: "input not an object" };
    }
    let current = input as Record<string, unknown>;
    let version = current.formatVersion;

    if (typeof version !== "number") {
      return { ok: false, error: "missing formatVersion" };
    }

    if (version > this.targetVersion) {
      return {
        ok: false,
        error: `formatVersion ${version} is newer than supported (${this.targetVersion})`,
      };
    }

    while (version !== this.targetVersion) {
      const step = this.migrators.get(version);
      if (!step) {
        return {
          ok: false,
          error: `no migrator from version ${version}`,
        };
      }
      current = step.fn(current);
      version = step.to;
      current.formatVersion = version;
    }

    return { ok: true, value: current };
  }
}
```

- [ ] **Step 4: Run tests and commit**

```bash
bun test src/__tests__/snapshot/migrations.test.ts
bun run typecheck
git add src/snapshot/migrations.ts src/__tests__/snapshot/migrations.test.ts
git commit -m "feat(snapshot): add migration registry (v1 has none, pipeline tested)"
```

---

## Task 6: SnapshotModel — pure in-memory builder

**Files:**
- Create: `src/snapshot/model.ts`
- Test: covered by capture-events.test.ts in Task 7

- [ ] **Step 1: Implement the model**

```ts
// src/snapshot/model.ts
import type {
  SnapshotFile,
  SnapshotSession,
  SnapshotWindow,
  SnapshotPane,
  SnapshotOtel,
  SessionLink,
  SnapshotPermissionMode,
} from "./schema";
import { SNAPSHOT_FORMAT_VERSION } from "./schema";

export class SnapshotModel {
  private sessions = new Map<string, SnapshotSession>();
  private lastFocused: string | null = null;
  private socket = "";
  constructor(private readonly jmuxVersion: string) {}

  setSocket(socket: string): void {
    this.socket = socket;
  }

  setLastFocused(name: string | null): void {
    this.lastFocused = name;
  }

  upsertSession(session: SnapshotSession): void {
    this.sessions.set(session.name, session);
  }

  removeSession(name: string): void {
    this.sessions.delete(name);
    if (this.lastFocused === name) this.lastFocused = null;
  }

  hasSession(name: string): boolean {
    return this.sessions.has(name);
  }

  renameSession(oldName: string, newName: string): void {
    const s = this.sessions.get(oldName);
    if (!s) return;
    this.sessions.delete(oldName);
    s.name = newName;
    this.sessions.set(newName, s);
    if (this.lastFocused === oldName) this.lastFocused = newName;
  }

  updateWindows(sessionName: string, windows: SnapshotWindow[]): void {
    const s = this.sessions.get(sessionName);
    if (!s) return;
    s.windows = windows;
  }

  setLayoutForWindow(
    sessionName: string,
    windowIndex: number,
    layout: string,
  ): void {
    const s = this.sessions.get(sessionName);
    if (!s) return;
    const w = s.windows.find((w) => w.index === windowIndex);
    if (w) w.layout = layout;
  }

  setOtel(sessionName: string, otel: SnapshotOtel | null): void {
    const s = this.sessions.get(sessionName);
    if (s) s.otel = otel;
  }

  setPermissionMode(
    sessionName: string,
    mode: SnapshotPermissionMode,
  ): void {
    const s = this.sessions.get(sessionName);
    if (s) s.permissionMode = mode;
  }

  setPinned(sessionName: string, pinned: boolean): void {
    const s = this.sessions.get(sessionName);
    if (s) s.pinned = pinned;
  }

  setAttention(sessionName: string, attention: boolean): void {
    const s = this.sessions.get(sessionName);
    if (s) s.attention = attention;
  }

  setLinks(sessionName: string, links: SessionLink[]): void {
    const s = this.sessions.get(sessionName);
    if (s) s.links = [...links];
  }

  setScrollbackFile(
    sessionName: string,
    windowIndex: number,
    paneIndex: number,
    file: string | null,
  ): void {
    const s = this.sessions.get(sessionName);
    if (!s) return;
    const w = s.windows.find((w) => w.index === windowIndex);
    if (!w) return;
    const p = w.panes.find((p) => p.index === paneIndex);
    if (p) p.scrollbackFile = file;
  }

  toFile(capturedAt: string): SnapshotFile {
    return {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      jmuxVersion: this.jmuxVersion,
      capturedAt,
      tmuxSocket: this.socket,
      lastFocusedSession: this.lastFocused,
      sessions: Array.from(this.sessions.values()).map((s) => ({
        ...s,
        windows: s.windows.map((w) => ({
          ...w,
          panes: w.panes.map((p) => ({ ...p })),
        })),
        links: [...s.links],
      })),
    };
  }

  static makeEmptyPane(index: number, cwd: string, command: string): SnapshotPane {
    return {
      index,
      cwd,
      command,
      kind: "other",
      scrollbackFile: null,
    };
  }

  static makeEmptyWindow(
    index: number,
    name: string,
    layout: string,
    active: boolean,
    panes: SnapshotPane[],
  ): SnapshotWindow {
    return { index, name, layout, active, panes };
  }

  static makeEmptySession(name: string, cwd: string): SnapshotSession {
    return {
      name,
      cwd,
      worktreePath: null,
      projectGroup: null,
      pinned: false,
      attention: false,
      permissionMode: null,
      otel: null,
      links: [],
      windows: [],
    };
  }
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
bun run typecheck
git add src/snapshot/model.ts
git commit -m "feat(snapshot): add SnapshotModel — in-memory state builder"
```

---

## Task 7: Snapshotter — debounced atomic flush + structural events

**Files:**
- Create: `src/snapshot/capture.ts` (partial — debounce + structural events; scrollback in Task 8)
- Test: `src/__tests__/snapshot/capture-debounce.test.ts`
- Test: `src/__tests__/snapshot/capture-events.test.ts`

- [ ] **Step 1: Write failing debounce test**

```ts
// src/__tests__/snapshot/capture-debounce.test.ts
import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

describe("Snapshotter debounce", () => {
  test("50 rapid markDirty calls produce one flush at trailing edge", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const model = new SnapshotModel("test");
    const snap = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await snap.start();

    for (let i = 0; i < 50; i++) snap.markDirty();
    expect(fs.writes("/snap/state.json")).toBe(0);

    clock.advance(199);
    expect(fs.writes("/snap/state.json")).toBe(0);

    clock.advance(1);
    await clock.flushMicrotasks();
    expect(fs.writes("/snap/state.json")).toBe(1);

    await snap.stop();
  });

  test("markDirty after flush schedules a new flush", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const snap = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await snap.start();

    snap.markDirty();
    clock.advance(200);
    await clock.flushMicrotasks();
    expect(fs.writes("/snap/state.json")).toBe(1);

    snap.markDirty();
    clock.advance(200);
    await clock.flushMicrotasks();
    expect(fs.writes("/snap/state.json")).toBe(2);

    await snap.stop();
  });

  test("flushNow bypasses debounce", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const snap = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await snap.start();

    snap.markDirty();
    await snap.flushNow();
    expect(fs.writes("/snap/state.json")).toBe(1);

    await snap.stop();
  });
});
```

- [ ] **Step 2: Write test helpers**

```ts
// src/__tests__/snapshot/helpers.ts
import type {
  Clock,
  FileStat,
  FileSystem,
  Lock,
  TmuxRunResult,
  TmuxRunner,
} from "../../snapshot/deps";

export class FakeClock implements Clock {
  private current = 0;
  private intervals: { fn: () => void; ms: number; nextAt: number; id: number }[] = [];
  private timeouts: { fn: () => void; at: number; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.current;
  }

  setInterval(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.intervals.push({ fn, ms, nextAt: this.current + ms, id });
    return () => {
      this.intervals = this.intervals.filter((i) => i.id !== id);
    };
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timeouts.push({ fn, at: this.current + ms, id });
    return () => {
      this.timeouts = this.timeouts.filter((t) => t.id !== id);
    };
  }

  advance(ms: number): void {
    const target = this.current + ms;
    while (true) {
      const nextTimeout = this.timeouts
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      const nextInterval = this.intervals
        .filter((i) => i.nextAt <= target)
        .sort((a, b) => a.nextAt - b.nextAt)[0];
      const pickTimeout =
        nextTimeout &&
        (!nextInterval || nextTimeout.at <= nextInterval.nextAt);
      if (pickTimeout) {
        this.current = nextTimeout.at;
        this.timeouts = this.timeouts.filter((t) => t.id !== nextTimeout.id);
        nextTimeout.fn();
        continue;
      }
      if (nextInterval) {
        this.current = nextInterval.nextAt;
        nextInterval.nextAt += nextInterval.ms;
        nextInterval.fn();
        continue;
      }
      break;
    }
    this.current = target;
  }

  async flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}

export class FakeFs implements FileSystem {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  locks = new Set<string>();
  writeCount = new Map<string, number>();

  async readFile(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
    this.writeCount.set(path, (this.writeCount.get(path) ?? 0) + 1);
  }

  writes(path: string): number {
    return this.writeCount.get(path) ?? 0;
  }

  async rename(from: string, to: string): Promise<void> {
    const b = this.files.get(from);
    if (b !== undefined) {
      this.files.set(to, b);
      this.files.delete(from);
    }
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }

  async readDir(path: string): Promise<string[]> {
    const prefix = path.endsWith("/") ? path : path + "/";
    const set = new Set<string>();
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) {
        const rest = k.slice(prefix.length);
        const seg = rest.split("/")[0];
        if (seg) set.add(seg);
      }
    }
    return Array.from(set);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async stat(path: string): Promise<FileStat | null> {
    const b = this.files.get(path);
    return b ? { size: b.byteLength, mtimeMs: 0 } : null;
  }

  async lock(path: string): Promise<Lock | null> {
    if (this.locks.has(path)) return null;
    this.locks.add(path);
    return {
      release: async () => {
        this.locks.delete(path);
      },
    };
  }
}

export class FakeRunner implements TmuxRunner {
  invocations: string[][] = [];
  responses = new Map<string, TmuxRunResult>();
  defaultResponse: TmuxRunResult = { stdout: "", stderr: "", exitCode: 0 };

  setResponse(argsKey: string, result: TmuxRunResult): void {
    this.responses.set(argsKey, result);
  }

  async run(args: string[]): Promise<TmuxRunResult> {
    this.invocations.push([...args]);
    const key = args.join(" ");
    return this.responses.get(key) ?? this.defaultResponse;
  }
}
```

- [ ] **Step 3: Run test to confirm failure**

Run: `bun test src/__tests__/snapshot/capture-debounce.test.ts`
Expected: FAIL — `Snapshotter` not exported from `../../snapshot/capture`.

- [ ] **Step 4: Implement Snapshotter (debounce + flush only)**

```ts
// src/snapshot/capture.ts
import type { Clock, FileSystem, Lock, TmuxRunner } from "./deps";
import { SnapshotModel } from "./model";

export interface SnapshotterOptions {
  dir: string;
  model: SnapshotModel;
  fs: FileSystem;
  runner: TmuxRunner;
  clock: Clock;
  debounceMs: number;
  scrollbackIntervalMs: number;
  scrollbackMaxBytes?: number;
}

export class Snapshotter {
  private dirty = false;
  private debounceCancel: (() => void) | null = null;
  private scrollbackCancel: (() => void) | null = null;
  private lock: Lock | null = null;
  private stopped = false;
  private degraded = false;

  constructor(private readonly opts: SnapshotterOptions) {}

  isDegraded(): boolean {
    return this.degraded;
  }

  async start(): Promise<void> {
    // Lock acquisition is in Task 9; for now assume ownership.
  }

  markDirty(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.debounceCancel) return;
    this.debounceCancel = this.opts.clock.setTimeout(() => {
      this.debounceCancel = null;
      void this.flushNow();
    }, this.opts.debounceMs);
  }

  async flushNow(): Promise<void> {
    if (this.stopped) return;
    if (!this.dirty) return;
    const capturedAt = new Date(this.opts.clock.now()).toISOString();
    const file = this.opts.model.toFile(capturedAt);
    const json = JSON.stringify(file, null, 2);
    try {
      await this.opts.fs.writeAtomic(
        `${this.opts.dir}/state.json`,
        new TextEncoder().encode(json),
      );
      // Only clear dirty after a successful write so a failed flush
      // (ENOSPC, EIO, etc.) is retried on the next debounce or tick.
      this.dirty = false;
    } catch {
      // Stay dirty. Next markDirty will reschedule the debounce.
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceCancel) {
      this.debounceCancel();
      this.debounceCancel = null;
    }
    if (this.scrollbackCancel) {
      this.scrollbackCancel();
      this.scrollbackCancel = null;
    }
    if (this.lock) {
      await this.lock.release();
      this.lock = null;
    }
  }
}
```

- [ ] **Step 5: Run debounce tests**

Run: `bun test src/__tests__/snapshot/capture-debounce.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write failing structural-events test**

```ts
// src/__tests__/snapshot/capture-events.test.ts
import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function snap() {
  const model = new SnapshotModel("test");
  return {
    model,
    clock: new FakeClock(),
    fs: new FakeFs(),
    runner: new FakeRunner(),
  };
}

describe("Snapshotter structural events", () => {
  test("session created via tmux events triggers a session in the model", async () => {
    const { model, clock, fs, runner } = snap();
    runner.setResponse(
      "list-windows -t alpha -F #{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
      { stdout: "0|main|b46c,80x24,0,0,0|1\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse("list-panes -t alpha:0 -F #{pane_index}|#{pane_current_path}|#{pane_start_command}", {
      stdout: "0|/repos/foo|zsh\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse(
      "list-sessions -F #{session_name}|#{session_path}",
      { stdout: "alpha|/repos/foo\n", stderr: "", exitCode: 0 },
    );

    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    await s.onSessionsChanged();
    expect(model.hasSession("alpha")).toBe(true);
    await s.stop();
  });

  test("layout-change updates the window layout in the model", async () => {
    const { model, clock, fs, runner } = snap();
    runner.setResponse(
      "list-windows -t alpha -F #{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
      { stdout: "0|main|NEW-LAYOUT|1\n", stderr: "", exitCode: 0 },
    );
    runner.setResponse(
      "list-panes -t alpha:0 -F #{pane_index}|#{pane_current_path}|#{pane_start_command}",
      { stdout: "0|/repos/foo|zsh\n", stderr: "", exitCode: 0 },
    );
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/repos/foo"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "OLD", true, [
          SnapshotModel.makeEmptyPane(0, "/repos/foo", "zsh"),
        ]),
      ],
    });

    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    await s.onLayoutChanged("alpha", 0);
    const file = model.toFile("2026-05-12T00:00:00.000Z");
    expect(file.sessions[0].windows[0].layout).toBe("NEW-LAYOUT");
    await s.stop();
  });

  test("session-renamed mutates the model name and lastFocused", async () => {
    const { model, clock, fs, runner } = snap();
    model.upsertSession(SnapshotModel.makeEmptySession("old", "/x"));
    model.setLastFocused("old");
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    await s.onSessionRenamed("old", "new");
    expect(model.hasSession("new")).toBe(true);
    expect(model.hasSession("old")).toBe(false);
    expect(model.toFile("2026-05-12T00:00:00.000Z").lastFocusedSession).toBe("new");
    await s.stop();
  });
});
```

- [ ] **Step 7: Run test to confirm failure**

Run: `bun test src/__tests__/snapshot/capture-events.test.ts`
Expected: FAIL — `onSessionsChanged`/`onLayoutChanged`/`onSessionRenamed` not defined.

- [ ] **Step 8: Implement structural-event handlers**

Add to `src/snapshot/capture.ts` (after `flushNow`):

```ts
  async onSessionsChanged(): Promise<void> {
    if (this.stopped) return;
    const sessionsRes = await this.opts.runner.run([
      "list-sessions",
      "-F",
      "#{session_name}|#{session_path}",
    ]);
    if (sessionsRes.exitCode !== 0) {
      // Server gone — clear model so a re-derive happens on reconnect.
      return;
    }
    const live = new Set<string>();
    for (const line of sessionsRes.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, cwd] = line.split("|");
      live.add(name);
      const existing = this.opts.model.hasSession(name);
      if (!existing) {
        this.opts.model.upsertSession(
          SnapshotModel.makeEmptySession(name, cwd),
        );
      }
      await this.rederiveSessionWindows(name);
    }
    // Remove sessions no longer present.
    const file = this.opts.model.toFile(
      new Date(this.opts.clock.now()).toISOString(),
    );
    for (const s of file.sessions) {
      if (!live.has(s.name)) this.opts.model.removeSession(s.name);
    }
    this.markDirty();
  }

  async onWindowAdded(sessionName: string): Promise<void> {
    await this.rederiveSessionWindows(sessionName);
    this.markDirty();
  }

  async onWindowClosed(sessionName: string): Promise<void> {
    await this.rederiveSessionWindows(sessionName);
    this.markDirty();
  }

  async onWindowRenamed(sessionName: string): Promise<void> {
    await this.rederiveSessionWindows(sessionName);
    this.markDirty();
  }

  async onLayoutChanged(
    sessionName: string,
    _windowIndex: number,
  ): Promise<void> {
    // Re-derive the whole session — simpler than partial layout patching,
    // and tmux only gives us the affected session, not the index reliably.
    await this.rederiveSessionWindows(sessionName);
    this.markDirty();
  }

  async onSessionRenamed(oldName: string, newName: string): Promise<void> {
    this.opts.model.renameSession(oldName, newName);
    this.markDirty();
  }

  onPermissionMode(name: string, mode: "default" | "plan" | "accept-edits" | null): void {
    this.opts.model.setPermissionMode(name, mode);
    this.markDirty();
  }

  onPinned(name: string, pinned: boolean): void {
    this.opts.model.setPinned(name, pinned);
    this.markDirty();
  }

  onAttention(name: string, attention: boolean): void {
    this.opts.model.setAttention(name, attention);
    this.markDirty();
  }

  onLinks(name: string, links: { type: "issue" | "mr"; id: string }[]): void {
    this.opts.model.setLinks(name, links);
    this.markDirty();
  }

  onOtel(name: string, otel: import("./schema").SnapshotOtel | null): void {
    this.opts.model.setOtel(name, otel);
    this.markDirty();
  }

  onFocused(name: string | null): void {
    this.opts.model.setLastFocused(name);
    this.markDirty();
  }

  private async rederiveSessionWindows(name: string): Promise<void> {
    const winRes = await this.opts.runner.run([
      "list-windows",
      "-t",
      name,
      "-F",
      "#{window_index}|#{window_name}|#{window_layout}|#{?window_active,1,0}",
    ]);
    if (winRes.exitCode !== 0) {
      this.opts.model.removeSession(name);
      return;
    }
    const windows: import("./schema").SnapshotWindow[] = [];
    for (const line of winRes.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [idxStr, wname, layout, activeStr] = line.split("|");
      const idx = Number(idxStr);
      const paneRes = await this.opts.runner.run([
        "list-panes",
        "-t",
        `${name}:${idx}`,
        "-F",
        "#{pane_index}|#{pane_current_path}|#{pane_start_command}",
      ]);
      const panes: import("./schema").SnapshotPane[] = [];
      for (const pline of paneRes.stdout.split("\n")) {
        if (!pline.trim()) continue;
        const [piStr, cwd, cmd] = pline.split("|");
        const { detectPaneKind } = await import("./painter");
        panes.push({
          index: Number(piStr),
          cwd,
          command: cmd,
          kind: detectPaneKind(cmd),
          scrollbackFile: null,
        });
      }
      windows.push({
        index: idx,
        name: wname,
        layout,
        active: activeStr === "1",
        panes,
      });
    }
    this.opts.model.updateWindows(name, windows);
  }
```

- [ ] **Step 9: Run all capture tests**

Run: `bun test src/__tests__/snapshot/capture-debounce.test.ts src/__tests__/snapshot/capture-events.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 10: Typecheck and commit**

```bash
bun run typecheck
git add src/snapshot/capture.ts src/__tests__/snapshot/helpers.ts \
        src/__tests__/snapshot/capture-debounce.test.ts \
        src/__tests__/snapshot/capture-events.test.ts
git commit -m "feat(snapshot): add Snapshotter with debounced flush and event handlers"
```

---

## Task 8: Snapshotter — scrollback loop

**Files:**
- Modify: `src/snapshot/capture.ts`
- Test: `src/__tests__/snapshot/capture-scrollback.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/snapshot/capture-scrollback.test.ts
import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function setupSession(runner: FakeRunner) {
  runner.setResponse("list-sessions -F #{session_name}", {
    stdout: "alpha\n",
    stderr: "",
    exitCode: 0,
  });
  runner.setResponse("list-windows -t alpha -F #{window_index}", {
    stdout: "0\n",
    stderr: "",
    exitCode: 0,
  });
  runner.setResponse("list-panes -t alpha:0 -F #{pane_index}", {
    stdout: "0\n",
    stderr: "",
    exitCode: 0,
  });
}

describe("Snapshotter scrollback loop", () => {
  test("captures pane output to scrollback file on tick", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    setupSession(runner);
    runner.setResponse(
      "capture-pane -p -e -J -S - -t alpha:0.0",
      { stdout: "scrollback bytes here", stderr: "", exitCode: 0 },
    );
    const model = new SnapshotModel("test");
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, [
          SnapshotModel.makeEmptyPane(0, "/x", "zsh"),
        ]),
      ],
    });
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 1000,
    });
    await s.start();
    clock.advance(1000);
    await clock.flushMicrotasks();

    const written = fs.files.get("/snap/scrollback/alpha/0-0.ansi");
    expect(written).not.toBeUndefined();
    expect(new TextDecoder().decode(written!)).toBe("scrollback bytes here");
    await s.stop();
  });

  test("empty pane writes null to model and removes scrollback file", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    setupSession(runner);
    runner.setResponse(
      "capture-pane -p -e -J -S - -t alpha:0.0",
      { stdout: "", stderr: "", exitCode: 0 },
    );
    fs.files.set("/snap/scrollback/alpha/0-0.ansi", new Uint8Array([1, 2]));
    const model = new SnapshotModel("test");
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, [
          SnapshotModel.makeEmptyPane(0, "/x", "zsh"),
        ]),
      ],
    });
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 1000,
    });
    await s.start();
    clock.advance(1000);
    await clock.flushMicrotasks();
    expect(fs.files.has("/snap/scrollback/alpha/0-0.ansi")).toBe(false);
    await s.stop();
  });

  test("failing capture-pane skips pane without aborting tick", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "alpha\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("list-windows -t alpha -F #{window_index}", {
      stdout: "0\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("list-panes -t alpha:0 -F #{pane_index}", {
      stdout: "0\n1\n",
      stderr: "",
      exitCode: 0,
    });
    runner.setResponse("capture-pane -p -e -J -S - -t alpha:0.0", {
      stdout: "",
      stderr: "pane closed",
      exitCode: 1,
    });
    runner.setResponse("capture-pane -p -e -J -S - -t alpha:0.1", {
      stdout: "second pane scrollback",
      stderr: "",
      exitCode: 0,
    });
    const model = new SnapshotModel("test");
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, [
          SnapshotModel.makeEmptyPane(0, "/x", "zsh"),
          SnapshotModel.makeEmptyPane(1, "/x", "zsh"),
        ]),
      ],
    });
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 1000,
    });
    await s.start();
    clock.advance(1000);
    await clock.flushMicrotasks();
    expect(fs.files.has("/snap/scrollback/alpha/0-1.ansi")).toBe(true);
    await s.stop();
  });

  test("size cap truncates oldest bytes with marker", async () => {
    const clock = new FakeClock();
    const fs = new FakeFs();
    const runner = new FakeRunner();
    setupSession(runner);
    const big = "x".repeat(10_000);
    runner.setResponse("capture-pane -p -e -J -S - -t alpha:0.0", {
      stdout: big,
      stderr: "",
      exitCode: 0,
    });
    const model = new SnapshotModel("test");
    model.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, [
          SnapshotModel.makeEmptyPane(0, "/x", "zsh"),
        ]),
      ],
    });
    const s = new Snapshotter({
      dir: "/snap",
      model,
      fs,
      runner,
      clock,
      debounceMs: 200,
      scrollbackIntervalMs: 1000,
      scrollbackMaxBytes: 1000,
    });
    await s.start();
    clock.advance(1000);
    await clock.flushMicrotasks();
    const written = fs.files.get("/snap/scrollback/alpha/0-0.ansi")!;
    const text = new TextDecoder().decode(written);
    // Allow ±5 bytes slack: the "dropped" digit-count affects marker size.
    expect(written.byteLength).toBeLessThanOrEqual(1005);
    expect(text).toContain("--- truncated: oldest");
    // Original was 10000 bytes; result must be much smaller.
    expect(written.byteLength).toBeLessThan(10000);
    await s.stop();
  });
});
```

- [ ] **Step 2: Add scrollback loop to Snapshotter**

Append to `src/snapshot/capture.ts` (inside the class):

```ts
  // Inside start(): also kick off scrollback loop
  // Replace the existing start() body with:
  //   this.scrollbackCancel = this.opts.clock.setInterval(
  //     () => void this.scrollbackTick(),
  //     this.opts.scrollbackIntervalMs,
  //   );

  private scrollbackBusy = false;

  async scrollbackTick(): Promise<void> {
    if (this.stopped || this.degraded || this.scrollbackBusy) return;
    this.scrollbackBusy = true;
    try {
      const sessRes = await this.opts.runner.run([
        "list-sessions",
        "-F",
        "#{session_name}",
      ]);
      if (sessRes.exitCode !== 0) return;
      const liveSessions = sessRes.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      for (const session of liveSessions) {
        const winRes = await this.opts.runner.run([
          "list-windows",
          "-t",
          session,
          "-F",
          "#{window_index}",
        ]);
        if (winRes.exitCode !== 0) continue;
        const windows = winRes.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .map((s) => Number(s));

        for (const w of windows) {
          const paneRes = await this.opts.runner.run([
            "list-panes",
            "-t",
            `${session}:${w}`,
            "-F",
            "#{pane_index}",
          ]);
          if (paneRes.exitCode !== 0) continue;
          const panes = paneRes.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .map((s) => Number(s));

          for (const p of panes) {
            await this.captureOnePane(session, w, p);
          }
        }
      }

      await this.gcScrollback(liveSessions);
    } finally {
      this.scrollbackBusy = false;
    }
  }

  private async captureOnePane(
    session: string,
    w: number,
    p: number,
  ): Promise<void> {
    const cap = await this.opts.runner.run([
      "capture-pane",
      "-p",
      "-e",
      "-J",
      "-S",
      "-",
      "-t",
      `${session}:${w}.${p}`,
    ]);
    const path = `${this.opts.dir}/scrollback/${session}/${w}-${p}.ansi`;
    if (cap.exitCode !== 0) return;
    if (cap.stdout.length === 0) {
      await this.opts.fs.unlink(path);
      this.opts.model.setScrollbackFile(session, w, p, null);
      this.markDirty();
      return;
    }
    let bytes = new TextEncoder().encode(cap.stdout);
    const cap2 = this.opts.scrollbackMaxBytes ?? 2 * 1024 * 1024;
    if (bytes.byteLength > cap2) {
      // Reserve space for the marker so the final byte count is <= cap2 AND
      // the marker survives. Compute the marker first with an exact "dropped"
      // count, then carve a tail that fits in the remaining budget.
      const enc = new TextEncoder();
      // Two-pass: build the marker, then size the tail so total <= cap2.
      // The marker length depends on the digit count of `dropped`, which
      // depends on tail length. We compute it pessimistically (assume tail=0)
      // then re-check; the digit count almost never changes.
      let droppedGuess = bytes.byteLength;
      let marker = enc.encode(
        `\n--- truncated: oldest ${droppedGuess} bytes dropped ---\n`,
      );
      let tailBudget = Math.max(0, cap2 - marker.byteLength);
      let droppedActual = bytes.byteLength - tailBudget;
      // Re-encode marker if the dropped digit-count differs (rare).
      if (droppedActual !== droppedGuess) {
        marker = enc.encode(
          `\n--- truncated: oldest ${droppedActual} bytes dropped ---\n`,
        );
        tailBudget = Math.max(0, cap2 - marker.byteLength);
      }
      // Align tail start to a UTF-8 leading byte to avoid splitting a codepoint.
      let cut = bytes.byteLength - tailBudget;
      while (cut < bytes.byteLength && (bytes[cut] & 0xc0) === 0x80) cut++;
      const tail = bytes.subarray(cut);
      const combined = new Uint8Array(marker.byteLength + tail.byteLength);
      combined.set(marker, 0);
      combined.set(tail, marker.byteLength);
      bytes = combined;
    }
    await this.opts.fs.writeAtomic(path, bytes);
    this.opts.model.setScrollbackFile(
      session,
      w,
      p,
      `scrollback/${session}/${w}-${p}.ansi`,
    );
    this.markDirty();
  }

  private async gcScrollback(liveSessions: string[]): Promise<void> {
    const live = new Set(liveSessions);
    const root = `${this.opts.dir}/scrollback`;
    const entries = await this.opts.fs.readDir(root);
    for (const dir of entries) {
      if (live.has(dir)) continue;
      const dead = `${root}/${dir}`;
      const files = await this.opts.fs.readDir(dead);
      for (const f of files) await this.opts.fs.unlink(`${dead}/${f}`);
    }
  }
```

Then update `start()` to register the interval:

```ts
  async start(): Promise<void> {
    this.scrollbackCancel = this.opts.clock.setInterval(
      () => void this.scrollbackTick(),
      this.opts.scrollbackIntervalMs,
    );
  }
```

- [ ] **Step 3: Run tests**

Run: `bun test src/__tests__/snapshot/capture-scrollback.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Typecheck and commit**

```bash
bun run typecheck
git add src/snapshot/capture.ts src/__tests__/snapshot/capture-scrollback.test.ts
git commit -m "feat(snapshot): add scrollback capture tick with per-pane error isolation"
```

---

## Task 9: Snapshotter — lock acquisition + atomic write resilience

**Files:**
- Modify: `src/snapshot/capture.ts`
- Test: `src/__tests__/snapshot/capture-lock.test.ts`
- Test: `src/__tests__/snapshot/capture-atomic.test.ts`

- [ ] **Step 1: Write lock tests**

```ts
// src/__tests__/snapshot/capture-lock.test.ts
import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

describe("Snapshotter lock", () => {
  test("acquires lock on start and releases on stop", async () => {
    const fs = new FakeFs();
    const s = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    expect(fs.locks.has("/snap/.lock")).toBe(true);
    await s.stop();
    expect(fs.locks.has("/snap/.lock")).toBe(false);
  });

  test("second Snapshotter on same dir runs in degraded mode", async () => {
    const fs = new FakeFs();
    const s1 = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s1.start();
    const s2 = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s2.start();
    expect(s2.isDegraded()).toBe(true);
    s2.markDirty();
    await s2.flushNow();
    // No write should have occurred in degraded mode
    expect(fs.writes("/snap/state.json")).toBe(0);
    await s1.stop();
    await s2.stop();
  });

  test("degraded reason is exposed", async () => {
    const fs = new FakeFs();
    fs.locks.add("/snap/.lock");
    const s = new Snapshotter({
      dir: "/snap",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 200,
      scrollbackIntervalMs: 5000,
    });
    await s.start();
    expect(s.degradedReason()).toBe("lock_held");
    await s.stop();
  });
});
```

- [ ] **Step 2: Update Snapshotter for lock and degraded mode**

In `src/snapshot/capture.ts`, change:

```ts
  private degradedReason_: string | null = null;
  // ...

  degradedReason(): string | null {
    return this.degradedReason_;
  }

  async start(): Promise<void> {
    this.lock = await this.opts.fs.lock(`${this.opts.dir}/.lock`);
    if (!this.lock) {
      this.degraded = true;
      this.degradedReason_ = "lock_held";
      return;
    }
    this.scrollbackCancel = this.opts.clock.setInterval(
      () => void this.scrollbackTick(),
      this.opts.scrollbackIntervalMs,
    );
  }
```

Also guard `markDirty`, `flushNow`, `scrollbackTick`, and event handlers so they early-return when `this.degraded === true`. Update `flushNow`:

```ts
  async flushNow(): Promise<void> {
    if (this.stopped || this.degraded) return;
    if (!this.dirty) return;
    // ... rest unchanged
  }
```

And `markDirty`:

```ts
  markDirty(): void {
    if (this.stopped || this.degraded) return;
    // ... rest unchanged
  }
```

- [ ] **Step 3: Write atomic-write stress test**

```ts
// src/__tests__/snapshot/capture-atomic.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProductionFileSystem } from "../../snapshot/fs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jmux-atomic-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ProductionFileSystem atomic-write stress", () => {
  test("concurrent writers never produce a partial file", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "state.json");
    const writers = Array.from({ length: 20 }).map((_, i) =>
      (async () => {
        for (let j = 0; j < 50; j++) {
          const payload = JSON.stringify({ writer: i, n: j, pad: "x".repeat(200) });
          await fs.writeAtomic(path, new TextEncoder().encode(payload));
          const content = readFileSync(path, "utf8");
          // Parse must always succeed — never see a partial write
          JSON.parse(content);
        }
      })(),
    );
    await Promise.all(writers);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(path + ".tmp")).toBe(false);
  });
});
```

> Note: rename is atomic on the same filesystem for a single rename call, but concurrent writers race on the .tmp filename. The test verifies the rename target is always a complete file even under contention. The writer-i collision is acceptable because the test only asserts integrity, not last-write-wins ordering.

> If this test reveals .tmp collision (two writers using the same tmp path), update `writeAtomic` to use a unique tmp suffix per call (`${path}.tmp.${process.pid}.${counter++}`). Make this change inside `ProductionFileSystem` if the stress test fails. The Snapshotter is single-writer (locked), so production never hits this path — but the safety net belongs in the helper.

- [ ] **Step 4: Run all capture tests**

```bash
bun test src/__tests__/snapshot/capture-lock.test.ts
bun test src/__tests__/snapshot/capture-atomic.test.ts
```

Expected: PASS. If atomic stress fails, apply the tmp-suffix fix above to `src/snapshot/fs.ts`.

- [ ] **Step 5: Add graceful shutdown flush**

In `src/snapshot/capture.ts`, change `stop`:

```ts
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.debounceCancel) {
      this.debounceCancel();
      this.debounceCancel = null;
    }
    if (this.scrollbackCancel) {
      this.scrollbackCancel();
      this.scrollbackCancel = null;
    }
    if (this.dirty && !this.degraded) {
      // Synchronous final flush — bypass debounce
      try {
        const capturedAt = new Date(this.opts.clock.now()).toISOString();
        const file = this.opts.model.toFile(capturedAt);
        const json = JSON.stringify(file, null, 2);
        await this.opts.fs.writeAtomic(
          `${this.opts.dir}/state.json`,
          new TextEncoder().encode(json),
        );
      } catch {
        // best-effort during shutdown
      }
    }
    if (this.lock) {
      await this.lock.release();
      this.lock = null;
    }
  }
```

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
bun test src/__tests__/snapshot/
git add src/snapshot/capture.ts src/snapshot/fs.ts \
        src/__tests__/snapshot/capture-lock.test.ts \
        src/__tests__/snapshot/capture-atomic.test.ts
git commit -m "feat(snapshot): add Snapshotter lock, degraded mode, and shutdown flush"
```

---

## Task 10: Restorer — eligibility check

**Files:**
- Create: `src/snapshot/restore.ts` (eligibility only; sequence in Task 11)
- Create: `src/snapshot/log.ts`
- Test: `src/__tests__/snapshot/restore-eligibility.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/snapshot/restore-eligibility.test.ts
import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function snapshotJson(): string {
  return JSON.stringify({
    formatVersion: 1,
    jmuxVersion: "test",
    capturedAt: "2026-05-12T00:00:00.000Z",
    tmuxSocket: "",
    lastFocusedSession: null,
    sessions: [],
  });
}

describe("Restorer eligibility", () => {
  test("eligible when state.json valid + server empty + lock free", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode(snapshotJson()));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(true);
  });

  test("ineligible when state.json missing", async () => {
    const fs = new FakeFs();
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_snapshot");
  });

  test("eligible when list-sessions exits non-zero with no-server stderr", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode(snapshotJson()));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "",
      stderr: "no server running on /tmp/tmux-501/default",
      exitCode: 1,
    });
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(true);
  });

  test("ineligible when server has sessions", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode(snapshotJson()));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "existing
",
      stderr: "",
      exitCode: 0,
    });
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("server_busy");
  });

  test("ineligible when list-sessions errors unrecognisably", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode(snapshotJson()));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "",
      stderr: "permission denied: socket /tmp/...",
      exitCode: 1,
    });
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("tmux_error");
  });

  test("invalid snapshot is backed up and ineligible", async () => {
    const fs = new FakeFs();
    fs.files.set("/snap/state.json", new TextEncoder().encode("{not json"));
    const runner = new FakeRunner();
    runner.setResponse("list-sessions -F #{session_name}", {
      stdout: "",
      stderr: "no server running",
      exitCode: 1,
    });
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
    });
    const result = await r.checkEligibility();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_snapshot");
    // Backup file should have been written
    const backupKey = Array.from(fs.files.keys()).find((k) =>
      k.startsWith("/snap/state.json.broken-"),
    );
    expect(backupKey).toBeDefined();
  });
});
```

- [ ] **Step 2: Implement restore.log writer**

```ts
// src/snapshot/log.ts
import type { FileSystem } from "./deps";

export type RestoreOutcome = "restored" | "skipped" | "failed";

export interface RestoreLogEntry {
  ts: string;
  session: string;
  outcome: RestoreOutcome;
  reason?: string;
  windowCount?: number;
  paneCount?: number;
  stderr?: string;
}

export class RestoreLog {
  constructor(
    private readonly fs: FileSystem,
    private readonly path: string,
  ) {}

  async append(entry: RestoreLogEntry): Promise<void> {
    const line = JSON.stringify(entry) + "
";
    const existing = await this.fs.readFile(this.path);
    const prev = existing ? new TextDecoder().decode(existing) : "";
    await this.fs.writeAtomic(
      this.path,
      new TextEncoder().encode(prev + line),
    );
  }
}
```

- [ ] **Step 3: Implement Restorer (eligibility only)**

```ts
// src/snapshot/restore.ts
import type { Clock, FileSystem, TmuxRunner } from "./deps";
import { validateSnapshot, type SnapshotFile } from "./schema";
import { RestoreLog, type RestoreOutcome } from "./log";

export interface RestorerOptions {
  dir: string;
  fs: FileSystem;
  runner: TmuxRunner;
  clock: Clock;
  jmuxVersion: string;
  userShell: string;
  claudeCommand: string;
}

export type EligibilityResult =
  | { ok: true; snapshot: SnapshotFile }
  | { ok: false; reason: "no_snapshot" | "invalid_snapshot" | "server_busy" | "tmux_error" };

const NO_SERVER_RX = /no server running|error connecting to|no sessions/i;

export class Restorer {
  private readonly log: RestoreLog;
  private outcomes = new Map<string, RestoreOutcome>();

  constructor(private readonly opts: RestorerOptions) {
    this.log = new RestoreLog(opts.fs, `${opts.dir}/restore.log`);
  }

  outcomeFor(session: string): RestoreOutcome | undefined {
    return this.outcomes.get(session);
  }

  async checkEligibility(): Promise<EligibilityResult> {
    const raw = await this.opts.fs.readFile(`${this.opts.dir}/state.json`);
    if (!raw) return { ok: false, reason: "no_snapshot" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      await this.backupCorrupt(raw);
      return { ok: false, reason: "invalid_snapshot" };
    }

    const v = validateSnapshot(parsed);
    if (!v.ok) {
      await this.backupCorrupt(raw);
      return { ok: false, reason: "invalid_snapshot" };
    }

    const sess = await this.opts.runner.run([
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    if (sess.exitCode === 0) {
      if (sess.stdout.trim().length === 0) return { ok: true, snapshot: v.value };
      return { ok: false, reason: "server_busy" };
    }
    if (NO_SERVER_RX.test(sess.stderr)) {
      return { ok: true, snapshot: v.value };
    }
    return { ok: false, reason: "tmux_error" };
  }

  private async backupCorrupt(raw: Uint8Array): Promise<void> {
    const ts = new Date(this.opts.clock.now()).toISOString();
    await this.opts.fs.writeAtomic(
      `${this.opts.dir}/state.json.broken-${ts}`,
      raw,
    );
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/snapshot/restore-eligibility.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/snapshot/restore.ts src/snapshot/log.ts \
        src/__tests__/snapshot/restore-eligibility.test.ts
git commit -m "feat(snapshot): add Restorer eligibility check and restore.log"
```

---

## Task 11: Restorer — per-session sequence with painter

**Files:**
- Modify: `src/snapshot/restore.ts`
- Test: `src/__tests__/snapshot/restore-sequence.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/snapshot/restore-sequence.test.ts
import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import type { SnapshotFile } from "../../snapshot/schema";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function snapshot(): SnapshotFile {
  return {
    formatVersion: 1,
    jmuxVersion: "test",
    capturedAt: "2026-05-12T18:00:00.000Z",
    tmuxSocket: "",
    lastFocusedSession: "alpha",
    sessions: [
      {
        name: "alpha",
        cwd: "/repos/foo",
        worktreePath: null,
        projectGroup: null,
        pinned: false,
        attention: false,
        permissionMode: "default",
        otel: null,
        links: [],
        windows: [
          {
            index: 0,
            name: "main",
            layout: "LAYOUT-W0",
            active: true,
            panes: [
              { index: 0, cwd: "/repos/foo", command: "claude", kind: "claude", scrollbackFile: "scrollback/alpha/0-0.ansi" },
              { index: 1, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
            ],
          },
          {
            index: 1,
            name: "logs",
            layout: "LAYOUT-W1",
            active: false,
            panes: [
              { index: 0, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
            ],
          },
        ],
      },
    ],
  };
}

function setupFs(fs: FakeFs): void {
  // cwd exists
  fs.files.set("/repos/foo/.exists", new Uint8Array());
}

describe("Restorer.run sequence", () => {
  test("emits new-session, new-window, split-window, select-layout, rename-window in order", async () => {
    const fs = new FakeFs();
    setupFs(fs);
    const runner = new FakeRunner();
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async (p: string) => p === "/repos/foo",
    });
    await r.run(snapshot());

    const cmds = runner.invocations.map((a) => a.join(" "));
    const firstNewSession = cmds.findIndex((c) => c.startsWith("new-session -d -s alpha"));
    const newWindowW1 = cmds.findIndex((c) => c.startsWith("new-window -t alpha:1"));
    const splitW0 = cmds.findIndex((c) => c.startsWith("split-window -t alpha:0"));
    const selectLayoutW0 = cmds.findIndex((c) => c.startsWith("select-layout -t alpha:0"));
    const selectLayoutW1 = cmds.findIndex((c) => c.startsWith("select-layout -t alpha:1"));
    const renameW0 = cmds.findIndex((c) => c.startsWith("rename-window -t alpha:0 main"));
    const renameW1 = cmds.findIndex((c) => c.startsWith("rename-window -t alpha:1 logs"));

    expect(firstNewSession).toBeGreaterThanOrEqual(0);
    expect(splitW0).toBeGreaterThan(firstNewSession);
    expect(selectLayoutW0).toBeGreaterThan(splitW0);
    expect(newWindowW1).toBeGreaterThan(selectLayoutW0);
    expect(selectLayoutW1).toBeGreaterThan(newWindowW1);
    expect(renameW0).toBeGreaterThan(selectLayoutW0);
    expect(renameW1).toBeGreaterThan(selectLayoutW1);
  });

  test("painter argv is passed as the pane command", async () => {
    const fs = new FakeFs();
    setupFs(fs);
    const runner = new FakeRunner();
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async (p: string) => p === "/repos/foo",
    });
    await r.run(snapshot());

    const newSession = runner.invocations.find((a) => a[0] === "new-session");
    expect(newSession).toBeDefined();
    // tail is sh -c '...' jmux-restore <path> <ts> claude --continue
    const shIdx = newSession!.indexOf("sh");
    expect(shIdx).toBeGreaterThanOrEqual(0);
    expect(newSession![shIdx + 3]).toBe("jmux-restore");
    expect(newSession![newSession!.length - 2]).toBe("claude");
    expect(newSession![newSession!.length - 1]).toBe("--continue");
  });

  test("records 'restored' outcome for fully-restored session", async () => {
    const fs = new FakeFs();
    setupFs(fs);
    const runner = new FakeRunner();
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async (p: string) => p === "/repos/foo",
    });
    await r.run(snapshot());
    expect(r.outcomeFor("alpha")).toBe("restored");
  });
});
```

- [ ] **Step 2: Add cwdExists to RestorerOptions and implement run()**

In `src/snapshot/restore.ts`, extend the options:

```ts
export interface RestorerOptions {
  dir: string;
  fs: FileSystem;
  runner: TmuxRunner;
  clock: Clock;
  jmuxVersion: string;
  userShell: string;
  claudeCommand: string;
  cwdExists?: (path: string) => Promise<boolean>;
}
```

Add the `run` method and helpers:

```ts
  async run(snapshot: SnapshotFile): Promise<void> {
    for (const session of snapshot.sessions) {
      await this.restoreSession(session, snapshot.capturedAt);
    }
  }

  private async restoreSession(
    session: import("./schema").SnapshotSession,
    capturedAt: string,
  ): Promise<void> {
    const exists = this.opts.cwdExists ?? this.defaultCwdExists.bind(this);
    if (!(await exists(session.cwd))) {
      this.outcomes.set(session.name, "skipped");
      await this.log.append({
        ts: new Date(this.opts.clock.now()).toISOString(),
        session: session.name,
        outcome: "skipped",
        reason: "cwd_missing",
      });
      return;
    }
    let layoutDegraded = false;
    let totalPanes = 0;

    for (let wi = 0; wi < session.windows.length; wi++) {
      const w = session.windows[wi];
      // First pane of window: new-session for the first window of the session, new-window otherwise.
      const firstPane = w.panes[0];
      const painter = (await import("./painter")).buildPainterArgv({
        scrollbackPath: firstPane.scrollbackFile
          ? `${this.opts.dir}/${firstPane.scrollbackFile}`
          : "",
        capturedAt,
        kind: firstPane.kind,
        claudeCommand: this.opts.claudeCommand,
        userShell: this.opts.userShell,
      });

      const baseArgs =
        wi === 0
          ? ["new-session", "-d", "-s", session.name, "-c", firstPane.cwd]
          : ["new-window", "-t", `${session.name}:${w.index}`, "-c", firstPane.cwd];

      const r1 = await this.opts.runner.run([...baseArgs, ...painter]);
      if (r1.exitCode !== 0) {
        await this.failSession(session.name, wi === 0 ? "new_session_failed" : "new_window_failed", r1.stderr);
        return;
      }
      totalPanes++;

      // Remaining panes: split-window
      for (let pi = 1; pi < w.panes.length; pi++) {
        const p = w.panes[pi];
        const painterP = (await import("./painter")).buildPainterArgv({
          scrollbackPath: p.scrollbackFile ? `${this.opts.dir}/${p.scrollbackFile}` : "",
          capturedAt,
          kind: p.kind,
          claudeCommand: this.opts.claudeCommand,
          userShell: this.opts.userShell,
        });
        const r2 = await this.opts.runner.run([
          "split-window",
          "-t",
          `${session.name}:${w.index}`,
          "-c",
          p.cwd,
          ...painterP,
        ]);
        if (r2.exitCode !== 0) {
          await this.failSession(session.name, "split_window_failed", r2.stderr);
          return;
        }
        totalPanes++;
      }

      // Apply layout
      const rL = await this.opts.runner.run([
        "select-layout",
        "-t",
        `${session.name}:${w.index}`,
        w.layout,
      ]);
      if (rL.exitCode !== 0) layoutDegraded = true;

      // Window name
      const rR = await this.opts.runner.run([
        "rename-window",
        "-t",
        `${session.name}:${w.index}`,
        w.name,
      ]);
      if (rR.exitCode !== 0) {
        await this.failSession(session.name, "rename_window_failed", rR.stderr);
        return;
      }
    }

    // Active window
    const activeWindow = session.windows.find((w) => w.active);
    if (activeWindow) {
      await this.opts.runner.run([
        "select-window",
        "-t",
        `${session.name}:${activeWindow.index}`,
      ]);
    }

    this.outcomes.set(session.name, "restored");
    await this.log.append({
      ts: new Date(this.opts.clock.now()).toISOString(),
      session: session.name,
      outcome: "restored",
      windowCount: session.windows.length,
      paneCount: totalPanes,
      reason: layoutDegraded ? "layout_degraded" : undefined,
    });
  }

  private async failSession(
    name: string,
    reason: string,
    stderr: string,
  ): Promise<void> {
    await this.opts.runner.run(["kill-session", "-t", name]);
    this.outcomes.set(name, "failed");
    await this.log.append({
      ts: new Date(this.opts.clock.now()).toISOString(),
      session: name,
      outcome: "failed",
      reason,
      stderr,
    });
  }

  private async defaultCwdExists(p: string): Promise<boolean> {
    return (await this.opts.fs.stat(p)) !== null;
  }
```

- [ ] **Step 3: Run tests**

Run: `bun test src/__tests__/snapshot/restore-sequence.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Typecheck and commit**

```bash
bun run typecheck
git add src/snapshot/restore.ts src/__tests__/snapshot/restore-sequence.test.ts
git commit -m "feat(snapshot): add Restorer.run with per-session sequence + painter"
```

---

## Task 12: Restorer — partial-failure cleanup and missing-cwd

**Files:**
- Test: `src/__tests__/snapshot/restore-partial.test.ts`
- Test: `src/__tests__/snapshot/restore-missing-cwd.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/snapshot/restore-partial.test.ts
import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import type { SnapshotFile } from "../../snapshot/schema";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function twoSessions(): SnapshotFile {
  return {
    formatVersion: 1,
    jmuxVersion: "test",
    capturedAt: "2026-05-12T00:00:00.000Z",
    tmuxSocket: "",
    lastFocusedSession: null,
    sessions: [
      {
        name: "broken",
        cwd: "/repos/foo",
        worktreePath: null,
        projectGroup: null,
        pinned: false,
        attention: false,
        permissionMode: null,
        otel: null,
        links: [],
        windows: [
          {
            index: 0,
            name: "main",
            layout: "L",
            active: true,
            panes: [
              { index: 0, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
              { index: 1, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
            ],
          },
        ],
      },
      {
        name: "fine",
        cwd: "/repos/foo",
        worktreePath: null,
        projectGroup: null,
        pinned: false,
        attention: false,
        permissionMode: null,
        otel: null,
        links: [],
        windows: [
          {
            index: 0,
            name: "main",
            layout: "L",
            active: true,
            panes: [
              { index: 0, cwd: "/repos/foo", command: "zsh", kind: "shell", scrollbackFile: null },
            ],
          },
        ],
      },
    ],
  };
}

describe("Restorer partial failure", () => {
  test("topology failure kills the session and proceeds to next", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    runner.defaultResponse = { stdout: "", stderr: "", exitCode: 0 };
    runner.setResponse = ((orig) => orig)(runner.setResponse.bind(runner));
    // Make split-window fail for "broken" session
    const origRun = runner.run.bind(runner);
    runner.run = async (args) => {
      if (args[0] === "split-window" && args.includes("broken:0")) {
        return { stdout: "", stderr: "tmux: bad pane", exitCode: 1 };
      }
      return origRun(args);
    };

    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => true,
    });
    await r.run(twoSessions());
    expect(r.outcomeFor("broken")).toBe("failed");
    expect(r.outcomeFor("fine")).toBe("restored");
    expect(
      runner.invocations.some(
        (a) => a[0] === "kill-session" && a.includes("broken"),
      ),
    ).toBe(true);
  });

  test("select-layout failure keeps session and marks layout_degraded", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const origRun = runner.run.bind(runner);
    runner.run = async (args) => {
      if (args[0] === "select-layout") {
        return { stdout: "", stderr: "tmux: bad layout", exitCode: 1 };
      }
      return origRun(args);
    };
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => true,
    });
    await r.run(twoSessions());
    expect(r.outcomeFor("broken")).toBe("restored");
    expect(r.outcomeFor("fine")).toBe("restored");
    expect(
      runner.invocations.some((a) => a[0] === "kill-session"),
    ).toBe(false);
  });
});
```

```ts
// src/__tests__/snapshot/restore-missing-cwd.test.ts
import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import type { SnapshotFile } from "../../snapshot/schema";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

const snap: SnapshotFile = {
  formatVersion: 1,
  jmuxVersion: "test",
  capturedAt: "2026-05-12T00:00:00.000Z",
  tmuxSocket: "",
  lastFocusedSession: null,
  sessions: [
    {
      name: "gone",
      cwd: "/no/such/path",
      worktreePath: null,
      projectGroup: null,
      pinned: false,
      attention: false,
      permissionMode: null,
      otel: null,
      links: [{ type: "issue", id: "ENG-1" }],
      windows: [
        {
          index: 0,
          name: "main",
          layout: "L",
          active: true,
          panes: [
            { index: 0, cwd: "/no/such/path", command: "zsh", kind: "shell", scrollbackFile: null },
          ],
        },
      ],
    },
  ],
};

describe("Restorer missing cwd", () => {
  test("skipped session lands in restore.log with cwd_missing reason", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => false,
    });
    await r.run(snap);
    expect(r.outcomeFor("gone")).toBe("skipped");
    const log = new TextDecoder().decode(fs.files.get("/snap/restore.log")!);
    expect(log).toContain('"reason":"cwd_missing"');
    expect(log).toContain('"session":"gone"');
  });

  test("skipped session does not invoke tmux commands", async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner();
    const r = new Restorer({
      dir: "/snap",
      fs,
      runner,
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => false,
    });
    await r.run(snap);
    expect(runner.invocations.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/__tests__/snapshot/restore-partial.test.ts src/__tests__/snapshot/restore-missing-cwd.test.ts`
Expected: PASS (4 tests). No code changes needed — Task 11's implementation already covers these paths.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/snapshot/restore-partial.test.ts \
        src/__tests__/snapshot/restore-missing-cwd.test.ts
git commit -m "test(snapshot): cover Restorer partial failure and missing-cwd paths"
```

---

## Task 13: Restorer — attach-target selection and links upsert

**Files:**
- Modify: `src/snapshot/restore.ts`
- Test: `src/__tests__/snapshot/restore-attach-target.test.ts`
- Test: `src/__tests__/snapshot/restore-links-upsert.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/snapshot/restore-attach-target.test.ts
import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import type { SnapshotFile } from "../../snapshot/schema";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

function makeSnap(lastFocused: string | null, present: Record<string, boolean>): SnapshotFile {
  return {
    formatVersion: 1,
    jmuxVersion: "test",
    capturedAt: "2026-05-12T00:00:00.000Z",
    tmuxSocket: "",
    lastFocusedSession: lastFocused,
    sessions: Object.entries(present).map(([name, cwdOk]) => ({
      name,
      cwd: cwdOk ? "/ok" : "/nope",
      worktreePath: null,
      projectGroup: null,
      pinned: false,
      attention: false,
      permissionMode: null,
      otel: null,
      links: [],
      windows: [
        {
          index: 0,
          name: "main",
          layout: "L",
          active: true,
          panes: [
            { index: 0, cwd: "/ok", command: "zsh", kind: "shell", scrollbackFile: null },
          ],
        },
      ],
    })),
  };
}

describe("Restorer attach target selection", () => {
  test("returns lastFocused if it was restored", async () => {
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async (p) => p === "/ok",
    });
    await r.run(makeSnap("beta", { alpha: true, beta: true }));
    expect(r.attachTarget()).toBe("beta");
  });

  test("falls back to first restored when lastFocused was skipped", async () => {
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async (p) => p === "/ok",
    });
    await r.run(makeSnap("beta", { alpha: true, beta: false }));
    expect(r.attachTarget()).toBe("alpha");
  });

  test("returns null when no session restored at all", async () => {
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => false,
    });
    await r.run(makeSnap("alpha", { alpha: false, beta: false }));
    expect(r.attachTarget()).toBeNull();
  });
});
```

```ts
// src/__tests__/snapshot/restore-links-upsert.test.ts
import { describe, test, expect } from "bun:test";
import { Restorer } from "../../snapshot/restore";
import type { SnapshotFile } from "../../snapshot/schema";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

const snap: SnapshotFile = {
  formatVersion: 1,
  jmuxVersion: "test",
  capturedAt: "2026-05-12T00:00:00.000Z",
  tmuxSocket: "",
  lastFocusedSession: "alpha",
  sessions: [
    {
      name: "alpha",
      cwd: "/ok",
      worktreePath: null,
      projectGroup: null,
      pinned: false,
      attention: false,
      permissionMode: null,
      otel: null,
      links: [
        { type: "issue", id: "ENG-1" },
        { type: "mr", id: "42" },
      ],
      windows: [
        {
          index: 0,
          name: "main",
          layout: "L",
          active: true,
          panes: [
            { index: 0, cwd: "/ok", command: "zsh", kind: "shell", scrollbackFile: null },
          ],
        },
      ],
    },
  ],
};

describe("Restorer links upsert", () => {
  test("invokes sessionLinksSink for each restored session", async () => {
    const calls: Array<{ name: string; links: { type: string; id: string }[] }> = [];
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => true,
      sessionLinksSink: (name, links) => calls.push({ name, links }),
    });
    await r.run(snap);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("alpha");
    expect(calls[0].links).toEqual([
      { type: "issue", id: "ENG-1" },
      { type: "mr", id: "42" },
    ]);
  });

  test("does not invoke sink for skipped session", async () => {
    const calls: Array<{ name: string }> = [];
    const r = new Restorer({
      dir: "/snap",
      fs: new FakeFs(),
      runner: new FakeRunner(),
      clock: new FakeClock(),
      jmuxVersion: "test",
      userShell: "/bin/zsh",
      claudeCommand: "claude",
      cwdExists: async () => false,
      sessionLinksSink: (name) => calls.push({ name }),
    });
    await r.run(snap);
    expect(calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Extend RestorerOptions and implement attachTarget + links upsert**

In `src/snapshot/restore.ts`:

```ts
export interface RestorerOptions {
  // ... existing fields
  sessionLinksSink?: (
    name: string,
    links: import("./schema").SessionLink[],
  ) => void;
  permissionModeSink?: (
    name: string,
    mode: import("./schema").SnapshotPermissionMode,
  ) => void;
  otelSink?: (
    name: string,
    otel: import("./schema").SnapshotOtel | null,
  ) => void;
  pinnedSink?: (name: string, pinned: boolean) => void;
  attentionSink?: (name: string, attention: boolean) => void;
}
```

Add `attachTarget()` and track the snapshot for selection:

```ts
  private lastSnapshot: SnapshotFile | null = null;

  attachTarget(): string | null {
    if (!this.lastSnapshot) return null;
    const lf = this.lastSnapshot.lastFocusedSession;
    if (lf && this.outcomes.get(lf) === "restored") return lf;
    for (const s of this.lastSnapshot.sessions) {
      if (this.outcomes.get(s.name) === "restored") return s.name;
    }
    return null;
  }

  async run(snapshot: SnapshotFile): Promise<void> {
    this.lastSnapshot = snapshot;
    for (const session of snapshot.sessions) {
      await this.restoreSession(session, snapshot.capturedAt);
    }
  }
```

At the end of a successful `restoreSession` (just before setting outcomes to "restored"), call the sinks:

```ts
    // After successful topology build, before outcomes.set(name, "restored")
    this.opts.sessionLinksSink?.(session.name, session.links);
    this.opts.permissionModeSink?.(session.name, session.permissionMode);
    this.opts.otelSink?.(session.name, session.otel);
    this.opts.pinnedSink?.(session.name, session.pinned);
    this.opts.attentionSink?.(session.name, session.attention);
```

- [ ] **Step 3: Run tests**

Run: `bun test src/__tests__/snapshot/restore-attach-target.test.ts src/__tests__/snapshot/restore-links-upsert.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4: Typecheck and commit**

```bash
bun run typecheck
git add src/snapshot/restore.ts \
        src/__tests__/snapshot/restore-attach-target.test.ts \
        src/__tests__/snapshot/restore-links-upsert.test.ts
git commit -m "feat(snapshot): add Restorer attach target + state sinks (links/otel/etc)"
```

---

## Task 14: TmuxPty — attachMode option

**Files:**
- Modify: `src/tmux-pty.ts`
- Test: `src/__tests__/snapshot/tmux-pty-strict-attach.test.ts`

> The current `TmuxPty` uses `bun-pty` and spawns a real tmux process. To test argv construction without spawning, we extract the argv builder into a pure function and unit-test that.

- [ ] **Step 1: Write failing test**

```ts
// src/__tests__/snapshot/tmux-pty-strict-attach.test.ts
import { describe, test, expect } from "bun:test";
import { buildTmuxPtyArgs } from "../../tmux-pty";

describe("buildTmuxPtyArgs", () => {
  test("createOrAttach emits new-session -A with name", () => {
    const args = buildTmuxPtyArgs({
      attachMode: "createOrAttach",
      sessionName: "alpha",
      socketName: "default",
      configFile: "/cfg",
    });
    expect(args).toEqual([
      "-f",
      "/cfg",
      "-L",
      "default",
      "new-session",
      "-A",
      "-s",
      "alpha",
    ]);
  });

  test("createOrAttach without sessionName omits -s", () => {
    const args = buildTmuxPtyArgs({
      attachMode: "createOrAttach",
      sessionName: undefined,
    });
    expect(args).toContain("new-session");
    expect(args).toContain("-A");
    expect(args).not.toContain("-s");
  });

  test("strictAttach emits attach-session -t name", () => {
    const args = buildTmuxPtyArgs({
      attachMode: "strictAttach",
      sessionName: "alpha",
      socketName: "default",
      configFile: "/cfg",
    });
    expect(args).toEqual([
      "-f",
      "/cfg",
      "-L",
      "default",
      "attach-session",
      "-t",
      "alpha",
    ]);
  });

  test("strictAttach without sessionName throws", () => {
    expect(() =>
      buildTmuxPtyArgs({ attachMode: "strictAttach", sessionName: undefined }),
    ).toThrow("strictAttach requires sessionName");
  });
});
```

- [ ] **Step 2: Extract argv builder and add attachMode**

In `src/tmux-pty.ts`, replace the constructor's argv inlining with a pure helper:

```ts
// At top of file, before the class:

export type AttachMode = "createOrAttach" | "strictAttach";

export interface TmuxPtyOptions {
  sessionName?: string;
  socketName?: string;
  configFile?: string;
  jmuxDir?: string;
  cols: number;
  rows: number;
  attachMode?: AttachMode;
}

export function buildTmuxPtyArgs(opts: {
  attachMode: AttachMode;
  sessionName?: string;
  socketName?: string;
  configFile?: string;
}): string[] {
  const args: string[] = [];
  if (opts.configFile) {
    args.push("-f", opts.configFile);
  }
  if (opts.socketName) {
    args.push("-L", opts.socketName);
  }
  if (opts.attachMode === "strictAttach") {
    if (!opts.sessionName) {
      throw new Error("strictAttach requires sessionName");
    }
    args.push("attach-session", "-t", opts.sessionName);
  } else {
    args.push("new-session", "-A");
    if (opts.sessionName) {
      args.push("-s", opts.sessionName);
    }
  }
  return args;
}
```

In the existing constructor, replace lines that build args (`src/tmux-pty.ts:19-29`) with:

```ts
    const args = buildTmuxPtyArgs({
      attachMode: options.attachMode ?? "createOrAttach",
      sessionName: options.sessionName,
      socketName: options.socketName,
      configFile: options.configFile,
    });
```

- [ ] **Step 3: Run tests**

Run: `bun test src/__tests__/snapshot/tmux-pty-strict-attach.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Verify no regressions in existing tests**

Run: `bun test`
Expected: all existing tests still pass.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/tmux-pty.ts src/__tests__/snapshot/tmux-pty-strict-attach.test.ts
git commit -m "feat(tmux-pty): add strictAttach mode and extract argv builder"
```

---

## Task 15: TmuxControl — spawn injection seam + reconnect with backoff

**Files:**
- Modify: `src/tmux-control.ts`
- Test: `src/__tests__/snapshot/tmux-control-reconnect.test.ts`

> The existing `TmuxControl` constructs `Bun.spawn` directly. We extract the spawn behind a `Spawner` interface so the reconnect logic can be unit-tested.

- [ ] **Step 1: Read existing TmuxControl to identify spawn site**

Run: `grep -n "Bun.spawn\|spawn\|stdin\|stdout" src/tmux-control.ts | head -20`

You should see the spawn call near line 185. Note the existing event emitters, the parser, the read loop, and how the process is shut down.

- [ ] **Step 2: Write failing reconnect test**

```ts
// src/__tests__/snapshot/tmux-control-reconnect.test.ts
import { describe, test, expect } from "bun:test";
import { TmuxControl, type ControlSpawner, type ControlProcess } from "../../tmux-control";
import { FakeClock } from "./helpers";

class FakeProcess implements ControlProcess {
  private dataListeners: Array<(s: string) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];
  alive = true;

  onData(fn: (s: string) => void): void {
    this.dataListeners.push(fn);
  }

  onExit(fn: (code: number) => void): void {
    this.exitListeners.push(fn);
  }

  emitData(s: string): void {
    for (const l of this.dataListeners) l(s);
  }

  emitExit(code = 0): void {
    this.alive = false;
    for (const l of this.exitListeners) l(code);
  }

  write(_: string): void {}
  kill(): void {
    this.emitExit(0);
  }
}

class FakeSpawner implements ControlSpawner {
  spawned: FakeProcess[] = [];
  spawn(): ControlProcess {
    const p = new FakeProcess();
    this.spawned.push(p);
    return p;
  }
}

describe("TmuxControl reconnect", () => {
  test("EOF triggers backoff reconnect via Clock", async () => {
    const clock = new FakeClock();
    const spawner = new FakeSpawner();
    const ctrl = new TmuxControl({
      socketName: "",
      spawner,
      clock,
      reconnectInitialMs: 250,
      reconnectMaxMs: 5000,
      reconnectGiveUpMs: 30000,
    });
    let reconnected = 0;
    ctrl.onReconnected(() => reconnected++);
    await ctrl.start();
    expect(spawner.spawned.length).toBe(1);

    spawner.spawned[0].emitExit();
    clock.advance(250);
    await clock.flushMicrotasks();
    expect(spawner.spawned.length).toBe(2);
    expect(reconnected).toBe(1);
  });

  test("backoff doubles up to cap", async () => {
    const clock = new FakeClock();
    const spawner = new FakeSpawner();
    const ctrl = new TmuxControl({
      socketName: "",
      spawner,
      clock,
      reconnectInitialMs: 100,
      reconnectMaxMs: 400,
      reconnectGiveUpMs: 30000,
    });
    await ctrl.start();

    // Each reconnect fails immediately by exiting.
    spawner.spawned[0].emitExit();
    clock.advance(100);
    await clock.flushMicrotasks();
    expect(spawner.spawned.length).toBe(2);
    spawner.spawned[1].emitExit();
    clock.advance(200);
    await clock.flushMicrotasks();
    expect(spawner.spawned.length).toBe(3);
    spawner.spawned[2].emitExit();
    clock.advance(400);
    await clock.flushMicrotasks();
    expect(spawner.spawned.length).toBe(4);
    spawner.spawned[3].emitExit();
    clock.advance(400);
    await clock.flushMicrotasks();
    expect(spawner.spawned.length).toBe(5);
  });

  test("give-up fires lost event after total elapsed > giveUpMs", async () => {
    const clock = new FakeClock();
    const spawner = new FakeSpawner();
    const ctrl = new TmuxControl({
      socketName: "",
      spawner,
      clock,
      reconnectInitialMs: 100,
      reconnectMaxMs: 100,
      reconnectGiveUpMs: 500,
    });
    let lost = false;
    ctrl.onLost(() => {
      lost = true;
    });
    await ctrl.start();

    for (let i = 0; i < 10; i++) {
      spawner.spawned[i].emitExit();
      clock.advance(100);
      await clock.flushMicrotasks();
    }
    expect(lost).toBe(true);
  });
});
```

- [ ] **Step 3: Refactor TmuxControl with Spawner + reconnect**

In `src/tmux-control.ts`, add the new interfaces near the top and a new constructor variant. Preserve the existing public API for backwards compatibility (the rest of jmux still uses `new TmuxControl(socketName)`).

```ts
import type { Clock } from "./snapshot/deps";

export interface ControlProcess {
  onData(fn: (data: string) => void): void;
  onExit(fn: (code: number) => void): void;
  write(data: string): void;
  kill(): void;
}

export interface ControlSpawner {
  spawn(): ControlProcess;
}

export interface TmuxControlOptions {
  socketName: string;
  spawner?: ControlSpawner;
  clock?: Clock;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  reconnectGiveUpMs?: number;
}
```

Update `TmuxControl` to accept either a legacy `socketName: string` or the options object:

```ts
export class TmuxControl {
  private readonly spawner: ControlSpawner;
  private readonly clock: Clock;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly reconnectGiveUpMs: number;
  private currentProcess: ControlProcess | null = null;
  private reconnectedListeners: Array<() => void> = [];
  private lostListeners: Array<() => void> = [];
  private currentBackoff = 0;
  private firstFailureAt: number | null = null;
  private cancelTimer: (() => void) | null = null;
  // ... existing fields

  constructor(arg: string | TmuxControlOptions) {
    if (typeof arg === "string") {
      arg = { socketName: arg };
    }
    this.socketName = arg.socketName;
    this.spawner = arg.spawner ?? this.defaultSpawner();
    // ProductionClock is fine here because legacy callers don't pass a clock
    const { ProductionClock } = require("./snapshot/clock") as typeof import("./snapshot/clock");
    this.clock = arg.clock ?? new ProductionClock();
    this.reconnectInitialMs = arg.reconnectInitialMs ?? 250;
    this.reconnectMaxMs = arg.reconnectMaxMs ?? 5000;
    this.reconnectGiveUpMs = arg.reconnectGiveUpMs ?? 30000;
  }

  onReconnected(fn: () => void): void {
    this.reconnectedListeners.push(fn);
  }

  onLost(fn: () => void): void {
    this.lostListeners.push(fn);
  }

  async start(): Promise<void> {
    this.attach();
  }

  private attach(): void {
    const proc = this.spawner.spawn();
    this.currentProcess = proc;
    proc.onData((s) => this.parser.feed(s));
    proc.onExit(() => this.handleExit());
    // Existing setup: refresh-client -f no-output, subscriptions, etc.
  }

  private handleExit(): void {
    this.currentProcess = null;
    const now = this.clock.now();
    if (this.firstFailureAt === null) this.firstFailureAt = now;
    if (now - this.firstFailureAt > this.reconnectGiveUpMs) {
      for (const fn of this.lostListeners) fn();
      return;
    }
    const wait =
      this.currentBackoff === 0
        ? this.reconnectInitialMs
        : Math.min(this.currentBackoff * 2, this.reconnectMaxMs);
    this.currentBackoff = wait;
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = null;
      this.attach();
      for (const fn of this.reconnectedListeners) fn();
    }, wait);
  }

  private defaultSpawner(): ControlSpawner {
    return {
      spawn: () => {
        // Existing Bun.spawn wiring lifted here from the old constructor
        // ... uses this.socketName
        throw new Error("production spawn not yet implemented in this stub");
      },
    };
  }
}
```

> Hand-port the existing production spawn logic (the code that was at `src/tmux-control.ts:185` and below) into `defaultSpawner()`. Keep parser feeding, write methods, and subscriptions intact. The behavior change is *only* that EOF now triggers reconnect instead of leaving the class inert.

- [ ] **Step 4: Run all tmux-control tests**

```bash
bun test src/__tests__/snapshot/tmux-control-reconnect.test.ts
bun test src/__tests__/tmux-control.test.ts
```

Expected: both PASS. Reconnect tests verify backoff progression; existing ControlParser tests are unaffected.

- [ ] **Step 5: Reset backoff on successful steady state**

Add a hook to reset `currentBackoff` and `firstFailureAt` once the channel has been alive for at least 1 reconnect interval. Wire it via `setTimeout` after each successful `attach()`:

```ts
  private attach(): void {
    const proc = this.spawner.spawn();
    this.currentProcess = proc;
    proc.onData((s) => this.parser.feed(s));
    proc.onExit(() => this.handleExit());
    // Reset backoff if the connection survives the cooling-off period
    this.clock.setTimeout(() => {
      if (this.currentProcess === proc) {
        this.currentBackoff = 0;
        this.firstFailureAt = null;
      }
    }, this.reconnectMaxMs);
  }
```

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/tmux-control.ts src/__tests__/snapshot/tmux-control-reconnect.test.ts
git commit -m "feat(tmux-control): add spawn injection seam and reconnect with backoff"
```

---

## Task 16: SessionState — change event + upsertLinksForSession

**Files:**
- Modify: `src/session-state.ts`
- Test: extend `src/__tests__/session-state.test.ts`

- [ ] **Step 1: Write failing test additions**

Append to `src/__tests__/session-state.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionState } from "../session-state";

describe("SessionState change events", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jmux-sstate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("addLink fires onChange with affected session name", () => {
    const s = new SessionState(join(dir, "state.json"));
    const changes: string[] = [];
    s.onChange((name) => changes.push(name));
    s.addLink("alpha", { type: "issue", id: "ENG-1" });
    expect(changes).toEqual(["alpha"]);
  });

  test("removeLink fires onChange", () => {
    const s = new SessionState(join(dir, "state.json"));
    s.addLink("alpha", { type: "issue", id: "ENG-1" });
    const changes: string[] = [];
    s.onChange((name) => changes.push(name));
    s.removeLink("alpha", { type: "issue", id: "ENG-1" });
    expect(changes).toEqual(["alpha"]);
  });

  test("upsertLinksForSession replaces existing links", () => {
    const s = new SessionState(join(dir, "state.json"));
    s.addLink("alpha", { type: "issue", id: "OLD-1" });
    s.upsertLinksForSession("alpha", [
      { type: "issue", id: "NEW-1" },
      { type: "mr", id: "42" },
    ]);
    expect(s.getLinks("alpha")).toEqual([
      { type: "issue", id: "NEW-1" },
      { type: "mr", id: "42" },
    ]);
  });

  test("upsertLinksForSession fires onChange exactly once", () => {
    const s = new SessionState(join(dir, "state.json"));
    const changes: string[] = [];
    s.onChange((name) => changes.push(name));
    s.upsertLinksForSession("alpha", [{ type: "issue", id: "X" }]);
    expect(changes).toEqual(["alpha"]);
  });
});
```

- [ ] **Step 2: Implement change event + upsert**

In `src/session-state.ts`, add inside the class:

```ts
  private changeListeners: Array<(sessionName: string) => void> = [];

  onChange(fn: (sessionName: string) => void): void {
    this.changeListeners.push(fn);
  }

  private emitChange(name: string): void {
    for (const fn of this.changeListeners) fn(name);
  }

  upsertLinksForSession(sessionName: string, links: SessionLink[]): void {
    this.data.sessionLinks[sessionName] = links.map((l) => ({
      type: l.type,
      id: l.id,
    }));
    if (links.length === 0) delete this.data.sessionLinks[sessionName];
    this.save();
    this.emitChange(sessionName);
  }
```

Then add `this.emitChange(sessionName);` after each `this.save();` call in `addLink`, `removeLink`, and `renameSession` (call with both old and new for rename). Update `pruneSessions` to emit for each pruned name.

- [ ] **Step 3: Run tests**

```bash
bun test src/__tests__/session-state.test.ts
```

Expected: existing tests pass, 4 new tests pass.

- [ ] **Step 4: Typecheck and commit**

```bash
bun run typecheck
git add src/session-state.ts src/__tests__/session-state.test.ts
git commit -m "feat(session-state): add onChange event and upsertLinksForSession"
```

---

## Task 17: OtelReceiver — per-session change event

**Files:**
- Modify: `src/otel-receiver.ts`
- Test: extend `src/__tests__/otel-receiver.test.ts`

- [ ] **Step 1: Read existing OtelReceiver**

Run: `grep -n "class OtelReceiver\|updateSession\|emit\|onUpdate" src/otel-receiver.ts | head -20`

Identify the method(s) that mutate per-session state (e.g. on receiving an OTEL trace).

- [ ] **Step 2: Write failing test**

Append to `src/__tests__/otel-receiver.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { OtelReceiver } from "../otel-receiver";

describe("OtelReceiver change events", () => {
  test("onSessionUpdate fires with session name when state changes", () => {
    const r = new OtelReceiver({ port: 0 });
    const changes: string[] = [];
    r.onSessionUpdate((name) => changes.push(name));
    r.updateCostUsd("alpha", 0.123);
    expect(changes).toContain("alpha");
  });

  test("onSessionUpdate fires once per change", () => {
    const r = new OtelReceiver({ port: 0 });
    const changes: string[] = [];
    r.onSessionUpdate((name) => changes.push(name));
    r.updateCostUsd("alpha", 0.1);
    r.updateCostUsd("alpha", 0.2);
    expect(changes.filter((n) => n === "alpha").length).toBe(2);
  });
});
```

> Adjust the test method names (`updateCostUsd`, etc.) to whatever the actual OtelReceiver exposes. The exact method depends on the existing implementation — read the file first and match its API.

- [ ] **Step 3: Add the change event**

In `src/otel-receiver.ts`:

```ts
  private sessionUpdateListeners: Array<(name: string) => void> = [];

  onSessionUpdate(fn: (name: string) => void): void {
    this.sessionUpdateListeners.push(fn);
  }

  private emitSessionUpdate(name: string): void {
    for (const fn of this.sessionUpdateListeners) fn(name);
  }
```

Then call `this.emitSessionUpdate(sessionName);` at the end of every method that mutates per-session OTEL state (cost, cache hit, last request, last tool, last error, etc.). Look for `this.sessions.set(...)` or similar mutation sites.

- [ ] **Step 4: Add a snapshot accessor for the Snapshotter**

```ts
  getSessionSnapshot(name: string): import("./snapshot/schema").SnapshotOtel | null {
    const s = this.sessions.get(name);
    if (!s) return null;
    return {
      costUsd: s.costUsd ?? 0,
      cacheWasHit: s.cacheWasHit ?? null,
      lastRequestTime: s.lastRequestTime ? new Date(s.lastRequestTime).toISOString() : null,
      lastCompactionTime: s.lastCompactionTime ? new Date(s.lastCompactionTime).toISOString() : null,
      lastTool: s.lastTool ?? null,
      lastUserPromptTime: s.lastUserPromptTime ? new Date(s.lastUserPromptTime).toISOString() : null,
      lastError: s.lastError ?? null,
      failedMcpServers: Array.from(s.failedMcpServers ?? []),
    };
  }
```

> Adapt field names to match the existing `SessionOtelState` shape in `src/types.ts`. If the existing type uses numeric epoch timestamps, convert to ISO strings here; the snapshot schema declares them as ISO strings.

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/otel-receiver.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/otel-receiver.ts src/__tests__/otel-receiver.test.ts
git commit -m "feat(otel-receiver): add onSessionUpdate event and snapshot accessor"
```

---

## Task 18: Config — snapshot namespace

**Files:**
- Modify: `src/config.ts`
- Test: extend `src/__tests__/config.test.ts`

- [ ] **Step 1: Read existing config shape**

Run: `grep -n "interface JmuxConfig\|type JmuxConfig\|defaultConfig" src/config.ts | head -10`

Identify where the config type is defined and where defaults live.

- [ ] **Step 2: Write failing test**

Append to `src/__tests__/config.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { defaultConfig } from "../config";

describe("snapshot config defaults", () => {
  test("snapshot.enabled defaults to true", () => {
    expect(defaultConfig.snapshot.enabled).toBe(true);
  });
  test("snapshot.scrollbackIntervalMs defaults to 5000", () => {
    expect(defaultConfig.snapshot.scrollbackIntervalMs).toBe(5000);
  });
  test("snapshot.scrollbackMaxBytes defaults to 2 MiB", () => {
    expect(defaultConfig.snapshot.scrollbackMaxBytes).toBe(2 * 1024 * 1024);
  });
  test("snapshot.dir defaults to null (XDG path)", () => {
    expect(defaultConfig.snapshot.dir).toBeNull();
  });
});
```

- [ ] **Step 3: Add snapshot to JmuxConfig**

In `src/config.ts`:

```ts
export interface SnapshotConfig {
  enabled: boolean;
  scrollbackIntervalMs: number;
  scrollbackMaxBytes: number;
  dir: string | null;
}

// In the JmuxConfig interface, add:
//   snapshot: SnapshotConfig;

// In defaultConfig, add:
//   snapshot: {
//     enabled: true,
//     scrollbackIntervalMs: 5000,
//     scrollbackMaxBytes: 2 * 1024 * 1024,
//     dir: null,
//   },
```

If the existing config uses `Partial` merging on load, ensure the snapshot section is merged with defaults so missing keys in `~/.config/jmux/config.json` still get sensible values.

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat(config): add snapshot namespace with defaults"
```

---

## Task 19: Snapshot module — index + multi-socket test

**Files:**
- Create: `src/snapshot/index.ts`
- Test: `src/__tests__/snapshot/multi-socket.test.ts`

- [ ] **Step 1: Write multi-socket test**

```ts
// src/__tests__/snapshot/multi-socket.test.ts
import { describe, test, expect } from "bun:test";
import { Snapshotter } from "../../snapshot/capture";
import { SnapshotModel } from "../../snapshot/model";
import { FakeClock, FakeFs, FakeRunner } from "./helpers";

describe("snapshot multi-socket isolation", () => {
  test("two Snapshotters with different dirs operate independently", async () => {
    const fs = new FakeFs();
    const s1 = new Snapshotter({
      dir: "/snap/work",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 100,
      scrollbackIntervalMs: 5000,
    });
    const s2 = new Snapshotter({
      dir: "/snap/play",
      model: new SnapshotModel("test"),
      fs,
      runner: new FakeRunner(),
      clock: new FakeClock(),
      debounceMs: 100,
      scrollbackIntervalMs: 5000,
    });
    await s1.start();
    await s2.start();
    expect(s1.isDegraded()).toBe(false);
    expect(s2.isDegraded()).toBe(false);
    expect(fs.locks.has("/snap/work/.lock")).toBe(true);
    expect(fs.locks.has("/snap/play/.lock")).toBe(true);
    await s1.stop();
    await s2.stop();
  });
});
```

- [ ] **Step 2: Implement index re-exports**

```ts
// src/snapshot/index.ts
export {
  Snapshotter,
  type SnapshotterOptions,
} from "./capture";
export { Restorer, type RestorerOptions, type EligibilityResult } from "./restore";
export { SnapshotModel } from "./model";
export {
  validateSnapshot,
  SNAPSHOT_FORMAT_VERSION,
  type SnapshotFile,
  type SnapshotSession,
  type SnapshotWindow,
  type SnapshotPane,
  type SnapshotOtel,
  type SessionLink,
  type SnapshotPermissionMode,
  type PaneKind,
} from "./schema";
export { buildPainterArgv, detectPaneKind } from "./painter";
export { ProductionFileSystem } from "./fs";
export { ProductionTmuxRunner } from "./runner";
export { ProductionClock } from "./clock";
export { MigrationRegistry, type MigrationResult } from "./migrations";
export { RestoreLog, type RestoreOutcome, type RestoreLogEntry } from "./log";
export type {
  FileSystem,
  TmuxRunner,
  Clock,
  Lock,
  FileStat,
  TmuxRunResult,
} from "./deps";

export function resolveSnapshotDir(opts: {
  override: string | null;
  socketName: string | null;
  xdgDataHome: string | null;
  home: string;
}): string {
  if (opts.override) return opts.override;
  const root =
    opts.xdgDataHome ?? `${opts.home}/.local/share`;
  const socket = opts.socketName && opts.socketName.length > 0 ? opts.socketName : "default";
  return `${root}/jmux/snapshot/${socket}`;
}
```

- [ ] **Step 3: Test resolveSnapshotDir**

Append to `src/__tests__/snapshot/multi-socket.test.ts`:

```ts
import { resolveSnapshotDir } from "../../snapshot";

describe("resolveSnapshotDir", () => {
  test("uses override when provided", () => {
    expect(
      resolveSnapshotDir({
        override: "/custom",
        socketName: null,
        xdgDataHome: null,
        home: "/home/u",
      }),
    ).toBe("/custom");
  });

  test("uses XDG_DATA_HOME with socket name", () => {
    expect(
      resolveSnapshotDir({
        override: null,
        socketName: "work",
        xdgDataHome: "/home/u/.local/share",
        home: "/home/u",
      }),
    ).toBe("/home/u/.local/share/jmux/snapshot/work");
  });

  test("default socket gets 'default' subdir", () => {
    expect(
      resolveSnapshotDir({
        override: null,
        socketName: null,
        xdgDataHome: null,
        home: "/home/u",
      }),
    ).toBe("/home/u/.local/share/jmux/snapshot/default");
  });
});
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/snapshot/multi-socket.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/snapshot/index.ts src/__tests__/snapshot/multi-socket.test.ts
git commit -m "feat(snapshot): add module index and resolveSnapshotDir helper"
```

---

## Task 20: main.ts — boot reordering and wiring

**Files:**
- Modify: `src/main.ts`
- Modify: `src/sidebar.ts` (or wherever toolbar lives) for the `snapshot off` chip

> This task has no new unit tests — main.ts is the integration surface and is covered by the real-tmux test in Task 22. Manual smoke testing is required after this commit.

- [ ] **Step 1: Read existing boot sequence**

Run: `grep -n "new TmuxControl\|new TmuxPty\|tmux-control\|tmux-pty" src/main.ts | head -20`

Identify the order in which `TmuxControl` and `TmuxPty` are currently constructed. Note any code that depends on either being already started.

- [ ] **Step 2: Build a SnapshotBoot helper to keep main.ts readable**

Create a new function inside `src/main.ts` (or extract to `src/snapshot/boot.ts` if preferred):

```ts
// At the top of src/main.ts, add imports:
import {
  Snapshotter,
  Restorer,
  SnapshotModel,
  ProductionFileSystem,
  ProductionTmuxRunner,
  ProductionClock,
  resolveSnapshotDir,
} from "./snapshot";

// New helper to run before TmuxControl starts:
async function performBoot(opts: {
  socketName: string;
  configFile: string;
  config: import("./config").JmuxConfig;
  sessionState: import("./session-state").SessionState;
}): Promise<{
  attachSessionName: string | null;
  snapshotDir: string;
  degradedReason: string | null;
}> {
  const fs = new ProductionFileSystem();
  const runner = new ProductionTmuxRunner(opts.socketName || null);
  const clock = new ProductionClock();
  const dir = resolveSnapshotDir({
    override: opts.config.snapshot.dir,
    socketName: opts.socketName || null,
    xdgDataHome: process.env.XDG_DATA_HOME ?? null,
    home: process.env.HOME ?? "/tmp",
  });

  if (!opts.config.snapshot.enabled) {
    return { attachSessionName: null, snapshotDir: dir, degradedReason: null };
  }

  // Sweep orphaned .tmp files from a prior crash
  const entries = await fs.readDir(dir).catch(() => []);
  for (const e of entries) {
    if (e.endsWith(".tmp")) await fs.unlink(`${dir}/${e}`).catch(() => undefined);
  }
  const scrollbackDir = `${dir}/scrollback`;
  const sessionDirs = await fs.readDir(scrollbackDir).catch(() => []);
  for (const sd of sessionDirs) {
    const files = await fs.readDir(`${scrollbackDir}/${sd}`).catch(() => []);
    for (const f of files) {
      if (f.endsWith(".tmp")) await fs.unlink(`${scrollbackDir}/${sd}/${f}`).catch(() => undefined);
    }
  }

  const restorer = new Restorer({
    dir,
    fs,
    runner,
    clock,
    jmuxVersion: process.env.JMUX_VERSION ?? "dev",
    userShell: process.env.SHELL ?? "/bin/sh",
    claudeCommand: opts.config.claudeCommand,
    sessionLinksSink: (name, links) =>
      opts.sessionState.upsertLinksForSession(name, links),
    // permissionModeSink/otelSink/pinnedSink/attentionSink wire to their respective caches;
    // pass through the existing setters that main.ts already constructs.
  });

  const eligibility = await restorer.checkEligibility();
  if (eligibility.ok) {
    process.stdout.write(`restoring ${eligibility.snapshot.sessions.length} sessions from ${eligibility.snapshot.capturedAt}...\n`);
    await restorer.run(eligibility.snapshot);
    return {
      attachSessionName: restorer.attachTarget(),
      snapshotDir: dir,
      degradedReason: null,
    };
  }

  return { attachSessionName: null, snapshotDir: dir, degradedReason: null };
}
```

- [ ] **Step 3: Wire performBoot into the existing main flow**

Find the block where `TmuxControl` is constructed and started. Replace it with this ordering:

```ts
// 1. Run restore via TmuxRunner (no TmuxControl yet)
const boot = await performBoot({
  socketName: socketName,
  configFile: configFile,
  config: config,
  sessionState: sessionState,
});

// 2. Spawn TmuxPty, attaching to the restored session if available
const tmuxPty = new TmuxPty({
  cols: process.stdout.columns,
  rows: process.stdout.rows,
  configFile,
  socketName,
  jmuxDir,
  sessionName: boot.attachSessionName ?? undefined,
  attachMode: boot.attachSessionName ? "strictAttach" : "createOrAttach",
});

// 3. Now start TmuxControl (a session exists)
const tmuxControl = new TmuxControl({
  socketName,
  // Use defaults for clock/spawner — production wiring
});
await tmuxControl.start();
```

- [ ] **Step 4: Wire Snapshotter after TmuxControl connects**

After `tmuxControl.start()`:

```ts
// 4. Instantiate Snapshotter and subscribe to events
const model = new SnapshotModel(process.env.JMUX_VERSION ?? "dev");
model.setSocket(socketName);
const snapshotter = new Snapshotter({
  dir: boot.snapshotDir,
  model,
  fs: new ProductionFileSystem(),
  runner: new ProductionTmuxRunner(socketName || null),
  clock: new ProductionClock(),
  debounceMs: 200,
  scrollbackIntervalMs: config.snapshot.scrollbackIntervalMs,
  scrollbackMaxBytes: config.snapshot.scrollbackMaxBytes,
});
await snapshotter.start();

// Subscribe to TmuxControl events
tmuxControl.onEvent((e) => {
  switch (e.type) {
    case "sessions-changed":
      void snapshotter.onSessionsChanged();
      break;
    case "session-renamed": {
      // e.args is the new name; tmux doesn't tell us the old name — track via parsing
      // Existing code in main.ts already correlates this; reuse that logic
      break;
    }
    case "window-add":
      void snapshotter.onWindowAdded(e.args);
      break;
    case "window-close":
      void snapshotter.onWindowClosed(e.args);
      break;
    case "window-renamed":
      void snapshotter.onWindowRenamed(e.args);
      break;
  }
});

// On control reconnect, do a full re-derivation
tmuxControl.onReconnected(() => {
  void snapshotter.onSessionsChanged();
});

// SessionState changes
sessionState.onChange((name) => {
  snapshotter.onLinks(name, sessionState.getLinks(name));
});

// OtelReceiver updates (assumes otel is already constructed in main.ts)
otelReceiver.onSessionUpdate((name) => {
  snapshotter.onOtel(name, otelReceiver.getSessionSnapshot(name));
});

// Focus tracker — main.ts already knows when the user switches sessions.
// Wire that callback to: snapshotter.onFocused(newName);

// Graceful shutdown
process.on("SIGTERM", () => void snapshotter.stop().then(() => process.exit(0)));
process.on("SIGINT", () => void snapshotter.stop().then(() => process.exit(0)));
process.on("SIGHUP", () => void snapshotter.stop().then(() => process.exit(0)));
```

- [ ] **Step 5: Initial model seed**

Right after `tmuxControl.start()` and before subscribing to events, do a full re-derive so the model reflects current state:

```ts
await snapshotter.onSessionsChanged();
```

- [ ] **Step 6: Boot smoke test**

Manually run `bun run dev` in a scratch directory:

1. Create a session via the UI, split a pane, run `claude` in one pane.
2. Kill the tmux server: `tmux kill-server` (or close all panes).
3. Restart `bun run dev` and verify the session is restored with the right layout and scrollback.
4. Inspect `~/.local/share/jmux/snapshot/default/state.json` to verify the structural snapshot was written.
5. Inspect `~/.local/share/jmux/snapshot/default/scrollback/<session>/0-0.ansi` for scrollback bytes.

- [ ] **Step 7: Typecheck and commit**

```bash
bun run typecheck
bun test
git add src/main.ts
git commit -m "feat(main): boot reordering, restore-before-attach, and Snapshotter wiring"
```

---

## Task 21: Toolbar — "snapshot off" chip

**Files:**
- Modify: wherever the toolbar is built (likely `src/main.ts` `makeToolbar()` per CLAUDE.md)
- Test: extend the existing toolbar/renderer tests

- [ ] **Step 1: Locate makeToolbar**

Run: `grep -n "makeToolbar\|toolbar" src/main.ts src/renderer.ts | head -10`

- [ ] **Step 2: Add a degradedReason getter to Snapshotter**

(Already added in Task 9, but verify `snapshotter.degradedReason()` returns `null | string`.)

- [ ] **Step 3: Add toolbar chip rendering**

In `makeToolbar()` (or equivalent), after the existing action buttons, append a conditional chip:

```ts
const degraded = snapshotter.degradedReason();
if (degraded) {
  // Render chip "snapshot off" with dim styling; clicking surfaces a modal with the reason.
  toolbarCells.push(...renderChip("snapshot off", { dim: true, onClick: () => showModal("Snapshot disabled", reasonText(degraded)) }));
}

function reasonText(r: string): string {
  switch (r) {
    case "lock_held": return "Another jmux process is using the snapshot directory.";
    case "control_channel_lost": return "Lost connection to the tmux control channel; reconnect failed.";
    case "dir_unwritable": return "Snapshot directory is not writable.";
    default: return r;
  }
}
```

> The exact API surface depends on how `renderChip` / `showModal` are built in jmux's existing toolbar. Match the style of adjacent buttons.

- [ ] **Step 4: Wire control_channel_lost reason**

In main.ts, when `tmuxControl.onLost(...)` fires:

```ts
tmuxControl.onLost(() => {
  // Re-create snapshotter in degraded mode by stopping it
  void snapshotter.stop();
  // Set a global flag the toolbar reads
  globalSnapshotDegradedReason = "control_channel_lost";
});
```

- [ ] **Step 5: Visual verification**

Run `bun run dev`. Confirm chip absent in normal operation. Force lock contention by starting a second jmux process in another terminal (same `$JMUX_SNAPSHOT_DIR`); confirm the chip appears in the second instance.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(toolbar): show 'snapshot off' chip when capture is degraded"
```

---

## Task 22: Real-tmux integration test

**Files:**
- Create: `src/__tests__/snapshot/integration-tmux.test.ts`

> Deliberate exception to "no tmux in tests" per spec. Gated to its own file.

- [ ] **Step 1: Detect tmux availability**

```ts
// src/__tests__/snapshot/integration-tmux.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProductionFileSystem } from "../../snapshot/fs";
import { ProductionTmuxRunner } from "../../snapshot/runner";
import { ProductionClock } from "../../snapshot/clock";
import { Snapshotter } from "../../snapshot/capture";
import { Restorer } from "../../snapshot/restore";
import { SnapshotModel } from "../../snapshot/model";

function hasTmux(): boolean {
  try {
    const p = Bun.spawnSync(["tmux", "-V"]);
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

const SOCKET = `jmux-test-${process.pid}-${Date.now()}`;
let tmpDir: string;
let runner: ProductionTmuxRunner;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "jmux-integration-"));
  runner = new ProductionTmuxRunner(SOCKET);
});

afterAll(async () => {
  await runner.run(["kill-server"]).catch(() => undefined);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!hasTmux())("snapshot/restore against real tmux", () => {
  test("captures topology and restores it after kill-server", async () => {
    const cwd = tmpDir;
    writeFileSync(join(cwd, ".cwd-marker"), "ok");

    // Build a topology: 2 sessions, alpha has 2 windows with 2 + 1 panes; beta has 1 window with 1 pane
    await runner.run(["-f", "/dev/null", "new-session", "-d", "-s", "alpha", "-c", cwd, "zsh"]);
    await runner.run(["split-window", "-t", "alpha:0", "-c", cwd, "zsh"]);
    await runner.run(["new-window", "-t", "alpha", "-c", cwd, "zsh"]);
    await runner.run(["new-session", "-d", "-s", "beta", "-c", cwd, "zsh"]);

    // Take a snapshot
    const snapshotDir = join(tmpDir, "snap");
    const model = new SnapshotModel("test");
    model.setSocket(SOCKET);
    const fs = new ProductionFileSystem();
    const snap = new Snapshotter({
      dir: snapshotDir,
      model,
      fs,
      runner,
      clock: new ProductionClock(),
      debounceMs: 50,
      scrollbackIntervalMs: 500,
    });
    await snap.start();
    await snap.onSessionsChanged();
    await snap.flushNow();
    // Wait for one scrollback tick
    await new Promise((r) => setTimeout(r, 700));
    await snap.stop();

    // Verify state.json exists
    const bytes = await fs.readFile(join(snapshotDir, "state.json"));
    expect(bytes).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(bytes!));
    expect(parsed.sessions.map((s: any) => s.name).sort()).toEqual(["alpha", "beta"]);

    // Kill the server
    await runner.run(["kill-server"]);
    // The server is gone — Restorer should be eligible
    const restorer = new Restorer({
      dir: snapshotDir,
      fs,
      runner,
      clock: new ProductionClock(),
      jmuxVersion: "test",
      userShell: process.env.SHELL ?? "/bin/sh",
      claudeCommand: "claude",
    });
    const eligibility = await restorer.checkEligibility();
    expect(eligibility.ok).toBe(true);
    if (!eligibility.ok) throw new Error("not eligible");
    await restorer.run(eligibility.snapshot);

    // Verify topology
    const ls = await runner.run(["list-sessions", "-F", "#{session_name}"]);
    expect(ls.exitCode).toBe(0);
    const names = ls.stdout.trim().split("\n").sort();
    expect(names).toEqual(["alpha", "beta"]);

    const wins = await runner.run(["list-windows", "-t", "alpha", "-F", "#{window_index}"]);
    const winIdxs = wins.stdout.trim().split("\n").map(Number).sort();
    expect(winIdxs).toEqual([0, 1]);

    const panes0 = await runner.run(["list-panes", "-t", "alpha:0", "-F", "#{pane_index}"]);
    expect(panes0.stdout.trim().split("\n").length).toBe(2);

    expect(restorer.attachTarget()).not.toBeNull();
  }, 30000);
});
```

- [ ] **Step 2: Run integration test**

Run: `bun test src/__tests__/snapshot/integration-tmux.test.ts`
Expected: PASS if tmux is installed; SKIP otherwise.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/snapshot/integration-tmux.test.ts
git commit -m "test(snapshot): real-tmux integration test for capture and restore"
```

---

## Task 23: Coverage gate on src/snapshot/**

**Files:**
- Create: `scripts/check-snapshot-coverage.ts`
- Modify: `package.json` to add `test:coverage` script

- [ ] **Step 1: Run baseline coverage**

```bash
bun test --coverage src/__tests__/snapshot/ 2>&1 | tee /tmp/coverage.txt
```

Inspect the output. Look for branch coverage on `src/snapshot/capture.ts`, `src/snapshot/restore.ts`, `src/snapshot/schema.ts`. If any are under 95% branch coverage, add focused tests in the corresponding `*.test.ts` until they cross the threshold.

- [ ] **Step 2: Write the gate script**

```ts
// scripts/check-snapshot-coverage.ts
// Parses `bun test --coverage` text output and fails if any src/snapshot/** file
// drops below 95% branch coverage.
const { spawnSync } = await import("child_process");
const res = spawnSync(
  "bun",
  ["test", "--coverage", "src/__tests__/snapshot/"],
  { encoding: "utf8" },
);
const out = res.stdout + res.stderr;
console.log(out);
const lines = out.split("\n");
let failed = false;
for (const line of lines) {
  const m = line.match(/^\s*(src\/snapshot\/[^\s|]+)\s*\|\s*[\d.]+\s*\|\s*([\d.]+)/);
  if (m) {
    const file = m[1];
    const branchPct = Number(m[2]);
    if (branchPct < 95) {
      console.error(`COVERAGE GATE: ${file} branch coverage ${branchPct}% < 95%`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
```

> The regex assumes Bun's coverage output format. If Bun outputs a different format, adjust the parser. The intent is: fail the script if any `src/snapshot/**` file's branch column is under 95%.

- [ ] **Step 3: Add npm script**

In `package.json`, under `scripts`:

```json
"test:snapshot-coverage": "bun run scripts/check-snapshot-coverage.ts"
```

- [ ] **Step 4: Run the gate**

```bash
bun run test:snapshot-coverage
```

Expected: exit 0. If exit 1, look at the failing files and add tests until branch coverage on each crosses 95%.

- [ ] **Step 5: Update CI config (if applicable)**

If `.github/workflows/` exists, add `bun run test:snapshot-coverage` to the test job. If a `Dockerfile.test` or `bun run docker` exists, add the same to that script so contributors can validate locally.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-snapshot-coverage.ts package.json
git commit -m "ci(snapshot): enforce 95% branch coverage on src/snapshot/**"
```

---

## Task 24: Final sweep — full suite, typecheck, manual smoke

**Files:** none modified

- [ ] **Step 1: Full test suite**

```bash
bun test
```

Expected: all tests pass on the current platform (macOS/Linux).

- [ ] **Step 2: Type check**

```bash
bun run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Coverage gate**

```bash
bun run test:snapshot-coverage
```

Expected: exit 0.

- [ ] **Step 4: Manual end-to-end smoke**

1. `bun run dev` in a fresh terminal.
2. Create 2 sessions, each with multiple windows and panes. Start `claude` in at least one pane.
3. Resize panes so the layouts are non-default.
4. Type some content into each pane so scrollback is non-empty.
5. Inspect `~/.local/share/jmux/snapshot/default/state.json` — verify all sessions captured.
6. `kill jmux` and `tmux kill-server`.
7. `bun run dev` again.
8. Verify: all sessions restored with correct layouts, scrollback painted, claude resumed via `--continue`.
9. Verify the `lastFocusedSession` was honored — the PTY attached to the right session.
10. Force a `claudeCommand` change in config and restart — verify Claude is launched with the new command, not the snapshot's old one.
11. Manually remove one of the worktree directories that a session references and restart — verify that session is skipped, `restore.log` records `cwd_missing`, other sessions restore normally.

- [ ] **Step 5: No commit needed — this is verification only**

If everything passes, the feature is complete. Open a PR with a summary linking to the spec.

---

## Self-Review

After implementing, run through the spec's six sections and verify each is reflected in the code:

1. **Module layout** — every file listed in the spec's "Module layout" section exists in `src/snapshot/`.
2. **Schema** — `validateSnapshot` covers every required field; permissionMode enum matches `src/types.ts`.
3. **Capture** — debounce, atomic write, scrollback loop with size cap, lock, graceful shutdown all present.
4. **Restore** — eligibility (including no-server-running stderr), per-session sequence, layout degradation, attach-target outcome map, links upsert all present.
5. **Error handling** — disk-full retry, .tmp sweep, corrupt-snapshot backup, TmuxControl reconnect with backoff/give-up, missing-cwd handling all present.
6. **Testing** — every test file in the spec's task list exists; integration test gated on `hasTmux()`.

If any item is missing, that's a gap; add the corresponding task and re-run.
