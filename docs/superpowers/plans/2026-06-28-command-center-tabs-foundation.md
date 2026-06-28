# Command Center Tabs — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure-logic and CLI foundation for named Command Center tabs — the tab registry, raw pin-value propagation, per-tab state summary, a disabled palette-row primitive, and the `ctl` surface — all unit-tested, with zero glass-runtime wiring.

**Architecture:** A pane is pinned to exactly one tab; membership rides on the per-pane tmux option `@jmux-pinned` holding a stable **tab id** (legacy `"1"` and unknown ids resolve to the first/default tab). The ordered tab list (id + name) lives in `config.json` under `commandCenterTabs`. This plan delivers the pure functions (`src/glass/tabs.ts`), the parser/tracker changes that stop discarding the raw option value, and the `jmux ctl cc` / `--tab` CLI — everything that can be tested without spawning tmux. The glass rendering, strip, input routing, and `main.ts` wiring land in the **Runtime** plan that consumes the interfaces produced here.

**Tech Stack:** TypeScript (strict), Bun 1.3.8+ test runner (`bun:test`), no bundler. Tests are pure unit tests over logic modules (project rule: tests never spawn tmux).

## Global Constraints

- **Runtime is Bun, not Node** — use `Bun.spawn`/`Bun.spawnSync` patterns already in the file you're editing; never add Node-targeted builds. Tests use `import { describe, test, expect } from "bun:test"`.
- **Non-destructive invariant** — nothing in this plan moves, breaks, or joins panes. Pin/unpin/move are *only* `set-option`/`-u` on `@jmux-pinned`. (Hard rule; see `project_pane_of_glass` memory.)
- **tmux user option is the membership source of truth** — `@jmux-pinned`; unset = unpinned; any non-empty value = pinned.
- **Default tab = index 0** of `commandCenterTabs`, protected: non-deletable, never reorderable out of position 0. Seeded id `"default"`, name `"Main"`.
- **Tab name validation** — trim; reject empty/whitespace; soft-cap 24 chars; reject case-insensitive duplicate names.
- **No Claude attribution in git** — commit as the user; no `Co-Authored-By`/Claude trailers.
- **Field/exported-name contracts must match across tasks** — names in the `Interfaces` blocks are binding.
- Run the full suite with `bun test`; typecheck with `bun run typecheck`. The tree must be green at the end of every task.

---

### Task 1: Tab registry — types, normalize, resolution

**Files:**
- Create: `src/glass/tabs.ts`
- Create: `src/__tests__/glass/tabs.test.ts`
- Modify: `src/config.ts:34-57` (add `commandCenterTabs` to `JmuxConfig`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface TabEntry { id: string; name: string }`
  - `const DEFAULT_TAB_SEED_ID = "default"`, `const DEFAULT_TAB_SEED_NAME = "Main"`
  - `function normalizeTabs(raw: unknown): TabEntry[]` — always returns a non-empty array whose index 0 is the protected default; drops malformed entries; dedups ids (first wins); synthesizes the seed default when raw is empty/invalid.
  - `function defaultTabId(tabs: TabEntry[]): string` — `tabs[0].id`.
  - `function resolveTabId(rawPinValue: string | null | undefined, tabs: TabEntry[]): string` — returns the matching tab id when `rawPinValue` is non-empty and present in `tabs`; otherwise `defaultTabId(tabs)`. (Handles legacy `"1"`, unknown ids, and the empty/auto case.)
  - `JmuxConfig.commandCenterTabs?: TabEntry[]` (config.ts).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/glass/tabs.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import {
  normalizeTabs, defaultTabId, resolveTabId,
  DEFAULT_TAB_SEED_ID, DEFAULT_TAB_SEED_NAME,
  type TabEntry,
} from "../../glass/tabs";

describe("normalizeTabs", () => {
  test("empty/undefined synthesizes the seed default at index 0", () => {
    for (const raw of [undefined, null, [], "bad", {}]) {
      const tabs = normalizeTabs(raw);
      expect(tabs).toEqual([{ id: DEFAULT_TAB_SEED_ID, name: DEFAULT_TAB_SEED_NAME }]);
    }
  });

  test("keeps valid entries in order", () => {
    const raw = [
      { id: "default", name: "Main" },
      { id: "backend", name: "Backend" },
    ];
    expect(normalizeTabs(raw)).toEqual(raw);
  });

  test("drops malformed entries (missing id/name, wrong types)", () => {
    const raw = [
      { id: "default", name: "Main" },
      { id: "", name: "Empty" },
      { name: "NoId" },
      { id: "x" },
      "nope",
      { id: "backend", name: "Backend" },
    ];
    expect(normalizeTabs(raw)).toEqual([
      { id: "default", name: "Main" },
      { id: "backend", name: "Backend" },
    ]);
  });

  test("dedups ids, first occurrence wins", () => {
    const raw = [
      { id: "default", name: "Main" },
      { id: "backend", name: "Backend" },
      { id: "backend", name: "Backend Dupe" },
    ];
    expect(normalizeTabs(raw)).toEqual([
      { id: "default", name: "Main" },
      { id: "backend", name: "Backend" },
    ]);
  });

  test("if all entries are dropped, falls back to the seed default", () => {
    expect(normalizeTabs([{ id: "" }, "x"])).toEqual([
      { id: DEFAULT_TAB_SEED_ID, name: DEFAULT_TAB_SEED_NAME },
    ]);
  });
});

describe("defaultTabId", () => {
  test("is the id at index 0", () => {
    expect(defaultTabId([{ id: "home", name: "Home" }, { id: "b", name: "B" }])).toBe("home");
  });
});

describe("resolveTabId", () => {
  const tabs: TabEntry[] = [
    { id: "default", name: "Main" },
    { id: "backend", name: "Backend" },
  ];
  test("known id resolves to itself", () => {
    expect(resolveTabId("backend", tabs)).toBe("backend");
  });
  test("legacy '1' resolves to the default", () => {
    expect(resolveTabId("1", tabs)).toBe("default");
  });
  test("unknown id resolves to the default", () => {
    expect(resolveTabId("ghost", tabs)).toBe("default");
  });
  test("empty / null / undefined resolves to the default", () => {
    expect(resolveTabId("", tabs)).toBe("default");
    expect(resolveTabId(null, tabs)).toBe("default");
    expect(resolveTabId(undefined, tabs)).toBe("default");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/glass/tabs.test.ts`
Expected: FAIL — `Cannot find module "../../glass/tabs"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/glass/tabs.ts`:

```typescript
export interface TabEntry {
  id: string;
  name: string;
}

export const DEFAULT_TAB_SEED_ID = "default";
export const DEFAULT_TAB_SEED_NAME = "Main";

function seedDefault(): TabEntry[] {
  return [{ id: DEFAULT_TAB_SEED_ID, name: DEFAULT_TAB_SEED_NAME }];
}

/**
 * Parse/validate/synthesize the tab registry. Always returns a non-empty array
 * whose index 0 is the protected default tab. Malformed entries are dropped and
 * duplicate ids are collapsed (first occurrence wins). An empty or fully-invalid
 * input synthesizes the seed default.
 */
export function normalizeTabs(raw: unknown): TabEntry[] {
  if (!Array.isArray(raw)) return seedDefault();
  const out: TabEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const name = (entry as { name?: unknown }).name;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string" || name.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out.length > 0 ? out : seedDefault();
}

/** The default tab is whatever sits at index 0. */
export function defaultTabId(tabs: TabEntry[]): string {
  return tabs[0].id;
}

/**
 * Resolve a raw `@jmux-pinned` value to a tab id. A non-empty value that names a
 * known tab resolves to that tab; everything else (legacy "1", unknown ids,
 * empty/auto) folds to the default tab. No pane rewrite — interpretation only.
 */
export function resolveTabId(
  rawPinValue: string | null | undefined,
  tabs: TabEntry[],
): string {
  if (rawPinValue) {
    for (const t of tabs) {
      if (t.id === rawPinValue) return rawPinValue;
    }
  }
  return defaultTabId(tabs);
}
```

Add the config field — modify `src/config.ts`, inside `interface JmuxConfig` (after the `stateColors` field at line 56), and add the import at the top:

```typescript
// at top of src/config.ts, with the other imports
import type { TabEntry } from "./glass/tabs";
```

```typescript
  /** Per-state indicator colors (ANSI color names). */
  stateColors?: StateColorConfig;
  /** Ordered Command Center tab registry; index 0 is the protected default. */
  commandCenterTabs?: TabEntry[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/glass/tabs.test.ts && bun run typecheck`
Expected: PASS (all tabs tests green); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/glass/tabs.ts src/__tests__/glass/tabs.test.ts src/config.ts
git commit -m "feat(command-center): tab registry types, normalize, resolution"
```

---

### Task 2: Tab registry — mutations (add/rename/delete/move) + validation

**Files:**
- Modify: `src/glass/tabs.ts`
- Modify: `src/__tests__/glass/tabs.test.ts`

**Interfaces:**
- Consumes: `TabEntry`, `normalizeTabs` (Task 1).
- Produces:
  - `function slugifyTabName(name: string, existingIds: Iterable<string>): string` — lowercase, non-alphanumerics→`-`, collapse/trim `-`; fall back to `"tab"` when empty; dedup with `-2`, `-3`, … against `existingIds`.
  - `type TabValidation = { ok: true; name: string } | { ok: false; error: string }`
  - `function validateTabName(name: string, tabs: TabEntry[], opts?: { excludeId?: string }): TabValidation` — trim; reject empty (`"Tab name cannot be empty"`); reject >24 chars (`"Tab name too long (max 24)"`); reject case-insensitive duplicate ignoring `excludeId` (`"A tab named \"<name>\" already exists"`).
  - `type TabMutation = { ok: true; tabs: TabEntry[] } | { ok: false; error: string }`
  - `function addTab(tabs: TabEntry[], name: string): TabMutation` — validates, appends `{ id: slug, name: trimmed }`.
  - `function renameTab(tabs: TabEntry[], id: string, newName: string): TabMutation` — validates (excludeId=id); errors `"Unknown tab"` if absent; changes only `name`.
  - `function deleteTab(tabs: TabEntry[], id: string, memberCount: number): TabMutation` — errors `"Cannot delete the default tab"` for index 0, `"Unknown tab"` if absent, `"Tab is not empty"` when `memberCount > 0`; else removes it.
  - `function moveTab(tabs: TabEntry[], id: string, dir: "left" | "right"): TabEntry[]` — swaps the tab with its neighbor, clamped so index 0 never moves and nothing crosses index 0; returns the array unchanged on a no-op or unknown id.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/glass/tabs.test.ts`:

```typescript
import {
  slugifyTabName, validateTabName, addTab, renameTab, deleteTab, moveTab,
} from "../../glass/tabs";

describe("slugifyTabName", () => {
  test("lowercases and dashes non-alphanumerics", () => {
    expect(slugifyTabName("Code Review!", [])).toBe("code-review");
  });
  test("dedups against existing ids", () => {
    expect(slugifyTabName("Backend", ["backend"])).toBe("backend-2");
    expect(slugifyTabName("Backend", ["backend", "backend-2"])).toBe("backend-3");
  });
  test("falls back to 'tab' when empty after slugify", () => {
    expect(slugifyTabName("!!!", [])).toBe("tab");
    expect(slugifyTabName("!!!", ["tab"])).toBe("tab-2");
  });
});

describe("validateTabName", () => {
  const tabs: TabEntry[] = [
    { id: "default", name: "Main" },
    { id: "backend", name: "Backend" },
  ];
  test("trims and accepts a fresh name", () => {
    expect(validateTabName("  Review  ", tabs)).toEqual({ ok: true, name: "Review" });
  });
  test("rejects empty/whitespace", () => {
    expect(validateTabName("   ", tabs)).toEqual({ ok: false, error: "Tab name cannot be empty" });
  });
  test("rejects > 24 chars", () => {
    const long = "x".repeat(25);
    expect(validateTabName(long, tabs)).toEqual({ ok: false, error: "Tab name too long (max 24)" });
  });
  test("rejects case-insensitive duplicates", () => {
    expect(validateTabName("backend", tabs)).toEqual({
      ok: false, error: 'A tab named "backend" already exists',
    });
  });
  test("allows renaming a tab to its own current name (excludeId)", () => {
    expect(validateTabName("Backend", tabs, { excludeId: "backend" })).toEqual({
      ok: true, name: "Backend",
    });
  });
});

describe("addTab", () => {
  test("appends a validated tab with a slug id", () => {
    const tabs: TabEntry[] = [{ id: "default", name: "Main" }];
    const r = addTab(tabs, "Code Review");
    expect(r).toEqual({ ok: true, tabs: [
      { id: "default", name: "Main" },
      { id: "code-review", name: "Code Review" },
    ]});
  });
  test("propagates validation errors", () => {
    expect(addTab([{ id: "default", name: "Main" }], "  ")).toEqual({
      ok: false, error: "Tab name cannot be empty",
    });
  });
});

describe("renameTab", () => {
  const tabs: TabEntry[] = [{ id: "default", name: "Main" }, { id: "backend", name: "Backend" }];
  test("changes only the name, keeps the id", () => {
    expect(renameTab(tabs, "backend", "API")).toEqual({ ok: true, tabs: [
      { id: "default", name: "Main" }, { id: "backend", name: "API" },
    ]});
  });
  test("unknown id errors", () => {
    expect(renameTab(tabs, "ghost", "X")).toEqual({ ok: false, error: "Unknown tab" });
  });
});

describe("deleteTab", () => {
  const tabs: TabEntry[] = [{ id: "default", name: "Main" }, { id: "backend", name: "Backend" }];
  test("removes an empty non-default tab", () => {
    expect(deleteTab(tabs, "backend", 0)).toEqual({ ok: true, tabs: [{ id: "default", name: "Main" }] });
  });
  test("blocks deleting the default tab", () => {
    expect(deleteTab(tabs, "default", 0)).toEqual({ ok: false, error: "Cannot delete the default tab" });
  });
  test("blocks deleting a non-empty tab", () => {
    expect(deleteTab(tabs, "backend", 3)).toEqual({ ok: false, error: "Tab is not empty" });
  });
  test("unknown id errors", () => {
    expect(deleteTab(tabs, "ghost", 0)).toEqual({ ok: false, error: "Unknown tab" });
  });
});

describe("moveTab", () => {
  const tabs: TabEntry[] = [
    { id: "default", name: "Main" },
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  test("right swaps with the next neighbor", () => {
    expect(moveTab(tabs, "a", "right").map(t => t.id)).toEqual(["default", "b", "a"]);
  });
  test("left swaps with the previous neighbor (but never index 0)", () => {
    expect(moveTab(tabs, "b", "left").map(t => t.id)).toEqual(["default", "b", "a"]);
  });
  test("left at index 1 is a no-op (cannot cross the default)", () => {
    expect(moveTab(tabs, "a", "left").map(t => t.id)).toEqual(["default", "a", "b"]);
  });
  test("the default tab never moves", () => {
    expect(moveTab(tabs, "default", "right").map(t => t.id)).toEqual(["default", "a", "b"]);
  });
  test("unknown id is a no-op", () => {
    expect(moveTab(tabs, "ghost", "right").map(t => t.id)).toEqual(["default", "a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/glass/tabs.test.ts`
Expected: FAIL — `slugifyTabName`/`validateTabName`/… are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/glass/tabs.ts`:

```typescript
const MAX_TAB_NAME = 24;

/** Build a stable, unique slug id from a display name. */
export function slugifyTabName(name: string, existingIds: Iterable<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tab";
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export type TabValidation = { ok: true; name: string } | { ok: false; error: string };

export function validateTabName(
  name: string,
  tabs: TabEntry[],
  opts?: { excludeId?: string },
): TabValidation {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, error: "Tab name cannot be empty" };
  if (trimmed.length > MAX_TAB_NAME) return { ok: false, error: "Tab name too long (max 24)" };
  const lower = trimmed.toLowerCase();
  for (const t of tabs) {
    if (opts?.excludeId && t.id === opts.excludeId) continue;
    if (t.name.toLowerCase() === lower) {
      return { ok: false, error: `A tab named "${trimmed}" already exists` };
    }
  }
  return { ok: true, name: trimmed };
}

export type TabMutation = { ok: true; tabs: TabEntry[] } | { ok: false; error: string };

export function addTab(tabs: TabEntry[], name: string): TabMutation {
  const v = validateTabName(name, tabs);
  if (!v.ok) return v;
  const id = slugifyTabName(v.name, tabs.map(t => t.id));
  return { ok: true, tabs: [...tabs, { id, name: v.name }] };
}

export function renameTab(tabs: TabEntry[], id: string, newName: string): TabMutation {
  if (!tabs.some(t => t.id === id)) return { ok: false, error: "Unknown tab" };
  const v = validateTabName(newName, tabs, { excludeId: id });
  if (!v.ok) return v;
  return { ok: true, tabs: tabs.map(t => (t.id === id ? { ...t, name: v.name } : t)) };
}

export function deleteTab(tabs: TabEntry[], id: string, memberCount: number): TabMutation {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return { ok: false, error: "Unknown tab" };
  if (idx === 0) return { ok: false, error: "Cannot delete the default tab" };
  if (memberCount > 0) return { ok: false, error: "Tab is not empty" };
  return { ok: true, tabs: tabs.filter(t => t.id !== id) };
}

export function moveTab(tabs: TabEntry[], id: string, dir: "left" | "right"): TabEntry[] {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx <= 0) return tabs; // unknown, or the protected default
  const target = dir === "left" ? idx - 1 : idx + 1;
  if (target <= 0 || target >= tabs.length) return tabs; // never cross index 0; clamp at edges
  const next = [...tabs];
  [next[idx], next[target]] = [next[target], next[idx]];
  return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/glass/tabs.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/glass/tabs.ts src/__tests__/glass/tabs.test.ts
git commit -m "feat(command-center): tab registry mutations + name validation"
```

---

### Task 3: Per-tab agent-state summary

**Files:**
- Modify: `src/glass/tabs.ts`
- Modify: `src/__tests__/glass/tabs.test.ts`

**Interfaces:**
- Consumes: `AgentState` from `../types`.
- Produces: `function summarizeTabState(states: ReadonlyArray<AgentState | null>): AgentState | null` — the most-attention-needed state with priority **waiting → running → complete**; returns `null` when there are no agent states at all (empty array or all `null`).

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/glass/tabs.test.ts`:

```typescript
import { summarizeTabState } from "../../glass/tabs";

describe("summarizeTabState", () => {
  test("waiting beats running and complete", () => {
    expect(summarizeTabState(["complete", "running", "waiting"])).toBe("waiting");
  });
  test("running beats complete when no waiting", () => {
    expect(summarizeTabState(["complete", "running", "complete"])).toBe("running");
  });
  test("complete when only completes", () => {
    expect(summarizeTabState(["complete", "complete"])).toBe("complete");
  });
  test("null when empty or all null", () => {
    expect(summarizeTabState([])).toBeNull();
    expect(summarizeTabState([null, null])).toBeNull();
  });
  test("ignores nulls amongst real states", () => {
    expect(summarizeTabState([null, "running", null])).toBe("running");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/glass/tabs.test.ts`
Expected: FAIL — `summarizeTabState` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/glass/tabs.ts` (and add the type import at the top of the file):

```typescript
// at the top of src/glass/tabs.ts:
import type { AgentState } from "../types";
```

```typescript
/**
 * Reduce a tab's tile states to one summary state for its strip chip dot:
 * most-attention-needed wins (waiting → running → complete). Null when the tab
 * holds no agents (plain shells / empty).
 */
export function summarizeTabState(
  states: ReadonlyArray<AgentState | null>,
): AgentState | null {
  let hasRunning = false;
  let hasComplete = false;
  for (const s of states) {
    if (s === "waiting") return "waiting";
    if (s === "running") hasRunning = true;
    else if (s === "complete") hasComplete = true;
  }
  if (hasRunning) return "running";
  if (hasComplete) return "complete";
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/glass/tabs.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/glass/tabs.ts src/__tests__/glass/tabs.test.ts
git commit -m "feat(command-center): per-tab agent-state summary reducer"
```

---

### Task 4: Raw pin-value propagation — reflect parser

**Files:**
- Modify: `src/glass/reflect.ts:9-26`
- Modify: `src/__tests__/glass/reflect.test.ts`

**Interfaces:**
- Consumes: `PaneLocation` from `../types`.
- Produces: `PaneState` gains `pins: Map<string, string>` (paneId → raw non-empty `@jmux-pinned` value). `pinned: Set<string>` is retained but its membership rule changes from `value === "1"` to **any non-empty value** (so a tab id like `"backend"` counts as pinned). `live` unchanged.

- [ ] **Step 1: Write the failing test**

Replace the body of `src/__tests__/glass/reflect.test.ts` with:

```typescript
import { describe, test, expect } from "bun:test";
import { parsePaneStateLines, PANE_STATE_FORMAT } from "../../glass/reflect";

describe("parsePaneStateLines", () => {
  test("splits pane id, pin value, session id, window id", () => {
    const { pinned, pins, live } = parsePaneStateLines([
      "%1\x1f1\x1f$2\x1f@5",          // legacy "1"
      "%2\x1f\x1f$2\x1f@6",            // unset
      "%3\x1fbackend\x1f$3\x1f@9",    // tab id
    ]);
    expect([...pinned].sort()).toEqual(["%1", "%3"]);
    expect(pins.get("%1")).toBe("1");
    expect(pins.get("%3")).toBe("backend");
    expect(pins.has("%2")).toBe(false);
    expect(live.get("%1")).toEqual({ sessionId: "$2", windowId: "@5" });
    expect(live.get("%3")).toEqual({ sessionId: "$3", windowId: "@9" });
  });

  test("any non-empty value counts as pinned and is stored verbatim", () => {
    const { pinned, pins } = parsePaneStateLines(["%7\x1freview\x1f$1\x1f@1"]);
    expect(pinned.has("%7")).toBe(true);
    expect(pins.get("%7")).toBe("review");
  });

  test("ignores blank lines", () => {
    const { live } = parsePaneStateLines(["", "%9\x1f1\x1f$1\x1f@1", ""]);
    expect(live.size).toBe(1);
  });

  test("PANE_STATE_FORMAT requests the four fields, US-separated", () => {
    expect(PANE_STATE_FORMAT).toBe("#{pane_id}\x1f#{@jmux-pinned}\x1f#{session_id}\x1f#{window_id}");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/glass/reflect.test.ts`
Expected: FAIL — `pins` is `undefined` on the returned object; `%3` (value `"backend"`) is absent from `pinned`.

- [ ] **Step 3: Write minimal implementation**

Modify `src/glass/reflect.ts` — extend the `PaneState` interface and `parsePaneStateLines`:

```typescript
export interface PaneState {
  /** Pane ids with a non-empty @jmux-pinned value. */
  pinned: Set<string>;
  /** Pane id → raw @jmux-pinned value (only present when non-empty). */
  pins: Map<string, string>;
  live: Map<string, PaneLocation>;
}

/** Parse `list-panes -a -F PANE_STATE_FORMAT` output into pin state + location map. */
export function parsePaneStateLines(lines: string[]): PaneState {
  const pinned = new Set<string>();
  const pins = new Map<string, string>();
  const live = new Map<string, PaneLocation>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const [paneId, pin, sessionId, windowId] = line.split(US);
    if (!paneId) continue;
    live.set(paneId, { sessionId: sessionId ?? "", windowId: windowId ?? "" });
    if (pin) {
      pinned.add(paneId);
      pins.set(paneId, pin);
    }
  }
  return { pinned, pins, live };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/glass/reflect.test.ts && bun run typecheck`
Expected: reflect tests PASS. Typecheck may FLAG `main.ts` for the new required `pins` field only if `main.ts` constructs a `PaneState` literal — it does not (it calls `parsePaneStateLines`), so typecheck stays clean. If typecheck reports an unrelated `pins` usage error, it means a consumer destructures `PaneState`; leave `main.ts` behavior unchanged (it reads `pinned`/`live`, both still present).

- [ ] **Step 5: Commit**

```bash
git add src/glass/reflect.ts src/__tests__/glass/reflect.test.ts
git commit -m "feat(command-center): preserve raw @jmux-pinned value in pane-state parser"
```

---

### Task 5: Raw pin-value propagation — PinnedPaneTracker stores the value

**Files:**
- Modify: `src/glass/pinned-pane-tracker.ts`
- Modify: `src/__tests__/glass/pinned-pane-tracker.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PinnedPaneTracker` now stores `paneId → rawValue` internally.
  - `apply(paneId: string, rawValue: string | null): void` — pinned iff `rawValue` is non-empty; **emits when the value changes** (unpinned→pinned, pinned→unpinned, *and* value→different-value), not only on presence change.
  - `getValue(paneId: string): string | undefined` — the stored raw value, or `undefined` when not pinned.
  - `has`, `all` (pinned pane ids), `size`, `onChange`, `pruneExcept` unchanged in signature.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/glass/pinned-pane-tracker.test.ts`:

```typescript
test("stores the raw value and exposes it via getValue", () => {
  const t = new PinnedPaneTracker();
  t.apply("%1", "backend");
  expect(t.has("%1")).toBe(true);
  expect(t.getValue("%1")).toBe("backend");
});

test("a changed value fires onChange (e.g. moved between tabs)", () => {
  const t = new PinnedPaneTracker();
  t.apply("%1", "backend");
  let fired = 0;
  t.onChange(() => fired++);
  t.apply("%1", "review"); // moved tab
  expect(fired).toBe(1);
  expect(t.getValue("%1")).toBe("review");
});

test("unset clears the value and getValue returns undefined", () => {
  const t = new PinnedPaneTracker();
  t.apply("%1", "backend");
  t.apply("%1", null);
  expect(t.has("%1")).toBe(false);
  expect(t.getValue("%1")).toBeUndefined();
});

test("idempotent same-value re-apply does not fire", () => {
  const t = new PinnedPaneTracker();
  t.apply("%1", "backend");
  let fired = 0;
  t.onChange(() => fired++);
  t.apply("%1", "backend");
  expect(fired).toBe(0);
});
```

The existing tests in this file already exercise `apply("%1", "1")` / `apply("%1", "")` / idempotent re-apply / `all()` / `size` — keep them; they remain valid under the new value-based model (`"1"` is a non-empty value).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/glass/pinned-pane-tracker.test.ts`
Expected: FAIL — `getValue` is not a function; the moved-tab test fails (current `apply` only diffs presence, so `backend`→`review` does not fire).

- [ ] **Step 3: Write minimal implementation**

Replace the body of `src/glass/pinned-pane-tracker.ts`:

```typescript
type ChangeListener = (paneId: string) => void;

/**
 * Tracks each pane's desired Command Center membership via the per-pane tmux
 * option `@jmux-pinned`. The stored value is the raw option string — a tab id
 * (or legacy "1") — not just a boolean. tmux is the source of truth; this mirrors
 * what the control channel reports. It never breaks or joins panes.
 */
export class PinnedPaneTracker {
  private values = new Map<string, string>(); // paneId → raw non-empty value
  private listeners: ChangeListener[] = [];

  get size(): number {
    return this.values.size;
  }

  has(paneId: string): boolean {
    return this.values.has(paneId);
  }

  /** Raw `@jmux-pinned` value (tab id / legacy "1"), or undefined when unpinned. */
  getValue(paneId: string): string | undefined {
    return this.values.get(paneId);
  }

  all(): string[] {
    return [...this.values.keys()];
  }

  onChange(fn: ChangeListener): void {
    this.listeners.push(fn);
  }

  /**
   * Reflect a raw `@jmux-pinned` value. Non-empty → pinned with that value;
   * empty/null → unpinned. Emits only when the effective value changes.
   */
  apply(paneId: string, rawValue: string | null): void {
    const next = rawValue && rawValue.length > 0 ? rawValue : null;
    const prev = this.values.get(paneId) ?? null;
    if (next === prev) return;
    if (next === null) this.values.delete(paneId);
    else this.values.set(paneId, next);
    this.emit(paneId);
  }

  /** Drop any tracked pane not in `activeIds` (e.g. its process exited). */
  pruneExcept(activeIds: string[]): void {
    const active = new Set(activeIds);
    let changed: string | null = null;
    for (const id of [...this.values.keys()]) {
      if (!active.has(id)) {
        this.values.delete(id);
        changed = id;
      }
    }
    if (changed !== null) this.emit(changed);
  }

  private emit(paneId: string): void {
    for (const fn of this.listeners) fn(paneId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/glass/pinned-pane-tracker.test.ts && bun run typecheck`
Expected: PASS (old + new); typecheck clean. (`main.ts` calls `apply(paneId, value)` and `all()`/`has()` — all still valid; the Runtime plan switches it to pass the raw value.)

- [ ] **Step 5: Commit**

```bash
git add src/glass/pinned-pane-tracker.ts src/__tests__/glass/pinned-pane-tracker.test.ts
git commit -m "feat(command-center): tracker stores raw pin value, emits on value change"
```

---

### Task 6: Disabled / hinted palette row primitive

**Files:**
- Modify: `src/types.ts:92-97` (`PaletteCommand`)
- Modify: `src/command-palette.ts:133-166` (Enter handling), `src/command-palette.ts:282-296` (label render)
- Modify: `src/__tests__/command-palette.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PaletteCommand` gains `disabled?: boolean` and `hint?: string`. A disabled command: (a) on Enter returns `{ type: "consumed" }` (no-op, never `result`, never drills into a sublist); (b) renders its label dimmed; (c) when `hint` is set, the hint is appended to the rendered label as ` — <hint>` (subject to truncation). Non-disabled behavior is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/command-palette.test.ts` (match the file's existing import style — it already imports `CommandPalette`):

```typescript
describe("disabled palette rows", () => {
  test("Enter on a disabled command is a no-op (consumed, not result)", () => {
    const p = new CommandPalette();
    p.open([{ id: "noop", label: "Unpin tile", category: "pane", disabled: true }]);
    const action = p.handleInput("\r");
    expect(action.type).toBe("consumed");
  });

  test("Enter on an enabled command still returns a result", () => {
    const p = new CommandPalette();
    p.open([{ id: "go", label: "Do it", category: "pane" }]);
    const action = p.handleInput("\r");
    expect(action).toEqual({ type: "result", value: { commandId: "go" } });
  });

  test("a disabled command renders its hint appended to the label", () => {
    const p = new CommandPalette();
    p.open([{
      id: "noop", label: "Unpin tile", category: "pane",
      disabled: true, hint: "auto-pinned; disable auto-pin",
    }]);
    const grid = p.getGrid(80);
    // Row 1 is the first result row; read its text back.
    const row = grid.cells[1].map((c) => c.char).join("");
    expect(row).toContain("Unpin tile — auto-pinned; disable auto-pin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/command-palette.test.ts`
Expected: FAIL — `disabled`/`hint` are not valid `PaletteCommand` fields (typecheck) and the hint is not rendered / Enter still returns a result.

- [ ] **Step 3: Write minimal implementation**

Modify `src/types.ts`, the `PaletteCommand` interface:

```typescript
export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  sublist?: PaletteSublistOption[];
  /** Non-selectable, dimmed row; Enter is a no-op. */
  disabled?: boolean;
  /** Explanatory suffix rendered after the label (e.g. on a disabled row). */
  hint?: string;
}
```

Modify `src/command-palette.ts` — in `handleInput`, the `if (data === "\r")` block, immediately after `const selected = this.filtered[this.selectedIndex];` (line ~137):

```typescript
      // Disabled rows are inert: never execute, never drill in.
      if (selected.command.disabled) {
        return CONSUMED;
      }
```

Modify `src/command-palette.ts` — the label render in `getGrid`. Replace the `const label = truncateLabel(item.command.label, maxLabelLen);` line (~285) with:

```typescript
        const rawLabel = item.command.hint
          ? `${item.command.label} — ${item.command.hint}`
          : item.command.label;
        const label = truncateLabel(rawLabel, maxLabelLen);
```

(Note: match highlighting uses `item.match.indices`, which index into `command.label`; appending the hint only adds non-highlighted trailing chars, so existing highlight indices stay correct. Disabled rows are filtered/selectable like any row but inert on Enter — dim styling reuses the existing `RESULT_ATTRS`; no separate attr is required for this task's assertions. If you want a visibly dimmer row, add a `DISABLED_RESULT_ATTRS` in `modal.ts` and branch `baseAttrs` on `item.command.disabled` — optional, not asserted here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/command-palette.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/command-palette.ts src/__tests__/command-palette.test.ts
git commit -m "feat(palette): disabled/hinted command rows"
```

---

### Task 7: CLI pin command — tab id value + tab-aware listing

**Files:**
- Modify: `src/cli/pane.ts:9` (`PINNED_LIST_FORMAT`), `:21-48` (`buildPinCommands`, `parsePinnedListOutput`), add `parsePinnedListWithTab`
- Modify: `src/__tests__/cli/pane-pin.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildPinCommands(verb: "pin" | "unpin", target: string, tabId?: string): PaneOptionCommand[]` — pin writes `@jmux-pinned` = `tabId ?? "1"` (default `"1"` keeps the existing 2-arg callers writing the legacy value, which resolves to the default tab); unpin unchanged.
  - `parsePinnedListOutput(lines: string[]): string[]` — pane ids whose value is **non-empty** (was: exactly `"1"`).
  - `parsePinnedListWithTab(lines: string[]): { id: string; tab: string }[]` — pane id + raw tab value, for the tab-aware `pane pinned`.

- [ ] **Step 1: Write the failing test**

Replace the body of `src/__tests__/cli/pane-pin.test.ts` with:

```typescript
import { describe, test, expect } from "bun:test";
import {
  buildPinCommands, parsePinnedListOutput, parsePinnedListWithTab,
} from "../../cli/pane";

describe("buildPinCommands", () => {
  test("pin with no tab writes the legacy default value '1'", () => {
    expect(buildPinCommands("pin", "%7")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "@jmux-pinned", "1"], required: true },
    ]);
  });

  test("pin with a tab id writes that id", () => {
    expect(buildPinCommands("pin", "%7", "backend")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "@jmux-pinned", "backend"], required: true },
    ]);
  });

  test("unpin unsets the per-pane option with -u", () => {
    expect(buildPinCommands("unpin", "%7")).toEqual([
      { args: ["set-option", "-p", "-t", "%7", "-u", "@jmux-pinned"], required: true },
    ]);
  });
});

describe("parsePinnedListOutput", () => {
  test("returns pane ids with any non-empty value", () => {
    const lines = ["%1:1", "%2:", "%3:backend"];
    expect(parsePinnedListOutput(lines)).toEqual(["%1", "%3"]);
  });
  test("ignores blank lines", () => {
    expect(parsePinnedListOutput(["", "%9:1", ""])).toEqual(["%9"]);
  });
});

describe("parsePinnedListWithTab", () => {
  test("returns pane id + raw tab value for non-empty entries", () => {
    const lines = ["%1:1", "%2:", "%3:backend"];
    expect(parsePinnedListWithTab(lines)).toEqual([
      { id: "%1", tab: "1" },
      { id: "%3", tab: "backend" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/cli/pane-pin.test.ts`
Expected: FAIL — `parsePinnedListWithTab` not exported; the 3-arg `buildPinCommands` and the `"%3:backend"` non-empty case fail.

- [ ] **Step 3: Write minimal implementation**

Modify `src/cli/pane.ts`:

```typescript
export function buildPinCommands(
  verb: "pin" | "unpin",
  target: string,
  tabId?: string,
): PaneOptionCommand[] {
  if (verb === "pin") {
    return [
      { args: ["set-option", "-p", "-t", target, "@jmux-pinned", tabId ?? "1"], required: true },
    ];
  }
  return [
    { args: ["set-option", "-p", "-t", target, "-u", "@jmux-pinned"], required: true },
  ];
}

/** Parse `list-panes -a -F '#{pane_id}:#{@jmux-pinned}'` into pinned pane ids (any non-empty value). */
export function parsePinnedListOutput(lines: string[]): string[] {
  return parsePinnedListWithTab(lines).map((e) => e.id);
}

/** Like parsePinnedListOutput but keeps each pane's raw tab value. */
export function parsePinnedListWithTab(lines: string[]): { id: string; tab: string }[] {
  const out: { id: string; tab: string }[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf(":");
    if (idx < 0) continue;
    const id = trimmed.slice(0, idx);
    const val = trimmed.slice(idx + 1);
    if (val !== "") out.push({ id, tab: val });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/cli/pane-pin.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (the existing `handlePane` `pin`/`unpin` call `buildPinCommands(action, target)` 2-arg, still valid).

- [ ] **Step 5: Commit**

```bash
git add src/cli/pane.ts src/__tests__/cli/pane-pin.test.ts
git commit -m "feat(ctl): pin writes tab id value; tab-aware pinned listing"
```

---

### Task 8: CLI `cc` group, `--tab` value flag, tab-aware `pane pin`/`pinned`

**Files:**
- Modify: `src/cli.ts:17-25` (`KNOWN_GROUPS`), `:30-47` (`VALUE_FLAGS`), `:60-103` (help text), `:214-238` (dispatch), add import
- Create: `src/cli/cc.ts`
- Modify: `src/cli/pane.ts:84-218` (`handlePane`: `pin` reads `--tab`, `pinned` returns tab) — and a small registry-read helper
- Create: `src/__tests__/cli/parse-cc.test.ts`
- Create: `src/__tests__/cli/cc.test.ts`

**Interfaces:**
- Consumes: `parseCtlArgs` / `ParsedCtlArgs` (cli.ts); `normalizeTabs`, `resolveTabId`, `defaultTabId`, `slugifyTabName`-free reads from `tabs.ts`; `loadUserConfig` (config.ts); `parsePinnedListWithTab`, `buildPinCommands` (pane.ts).
- Produces:
  - `parseCtlArgs(["cc", "tabs"])` → `{ group: "cc", action: "tabs", flags: {}, positional: [] }`.
  - `parseCtlArgs(["pane", "pin", "--tab", "backend"])` → `flags.tab === "backend"` (a captured **value**, not a boolean; `backend` is **not** a stray positional).
  - `handleCc(ctx: CliContext, parsed: ParsedCtlArgs): unknown` — `tabs` action returns `{ tabs: { id: string; name: string; order: number; count: number }[] }` where `count` is the number of live pinned panes resolving to that tab.
  - `jmux ctl pane pin --tab <id|name>` — resolves a passed name to its id via the registry (id match wins; else case-insensitive name match; else write the raw value verbatim so an unknown value still round-trips and resolves to default at read time); default tab when `--tab` omitted.
  - `jmux ctl pane pinned` → `{ pinned: { id: string; tab: string }[] }` (tab = resolved tab id).

- [ ] **Step 1: Write the failing parser test**

Create `src/__tests__/cli/parse-cc.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { parseCtlArgs } from "../../cli";

describe("parseCtlArgs — cc group and --tab flag", () => {
  test("cc tabs parses as group=cc action=tabs", () => {
    expect(parseCtlArgs(["cc", "tabs"])).toEqual({
      group: "cc", action: "tabs", flags: {}, positional: [],
    });
  });

  test("--tab captures a value (not a boolean, no stray positional)", () => {
    const parsed = parseCtlArgs(["pane", "pin", "--tab", "backend", "--target", "%7"]);
    expect(parsed.group).toBe("pane");
    expect(parsed.action).toBe("pin");
    expect(parsed.flags.tab).toBe("backend");
    expect(parsed.flags.target).toBe("%7");
    expect(parsed.positional).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/cli/parse-cc.test.ts`
Expected: FAIL — `cc` is an unknown group (throws `CliError`); `flags.tab` is `true` (boolean) and `"backend"` lands in `positional`.

- [ ] **Step 3: Make the parser changes**

Modify `src/cli.ts`:

Add `cc` to `KNOWN_GROUPS`:

```typescript
const KNOWN_GROUPS = [
  "session",
  "window",
  "pane",
  "run-claude",
  "agent",
  "issue",
  "status",
  "cc",
] as const;
```

Add `"tab"` to `VALUE_FLAGS` (insert into the existing `new Set([...])`):

```typescript
  "issue",
  "worktree",
  "interval",
  "tab",
]);
```

- [ ] **Step 4: Run the parser test to verify it passes**

Run: `bun test src/__tests__/cli/parse-cc.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing handler test**

Create `src/__tests__/cli/cc.test.ts`. This test drives the **pure registry+count reducer** that `handleCc` delegates to, so it needs no tmux:

```typescript
import { describe, test, expect } from "bun:test";
import { buildTabSummaries } from "../../cli/cc";
import type { TabEntry } from "../../glass/tabs";

describe("buildTabSummaries", () => {
  const tabs: TabEntry[] = [
    { id: "default", name: "Main" },
    { id: "backend", name: "Backend" },
  ];

  test("counts live pinned panes per resolved tab (legacy + unknown fold to default)", () => {
    const pins = [
      { id: "%1", tab: "1" },        // legacy → default
      { id: "%2", tab: "backend" },  // backend
      { id: "%3", tab: "ghost" },    // unknown → default
      { id: "%4", tab: "backend" },  // backend
    ];
    expect(buildTabSummaries(tabs, pins)).toEqual([
      { id: "default", name: "Main", order: 0, count: 2 },
      { id: "backend", name: "Backend", order: 1, count: 2 },
    ]);
  });

  test("empty tabs report count 0", () => {
    expect(buildTabSummaries(tabs, [])).toEqual([
      { id: "default", name: "Main", order: 0, count: 0 },
      { id: "backend", name: "Backend", order: 1, count: 0 },
    ]);
  });
});
```

- [ ] **Step 6: Run the handler test to verify it fails**

Run: `bun test src/__tests__/cli/cc.test.ts`
Expected: FAIL — `Cannot find module "../../cli/cc"`.

- [ ] **Step 7: Implement `cc.ts` and the registry read helper**

Create `src/cli/cc.ts`:

```typescript
import { runTmuxDirect } from "./tmux";
import { tmuxOrThrow, CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";
import { loadUserConfig } from "../config";
import { normalizeTabs, resolveTabId, type TabEntry } from "../glass/tabs";
import { parsePinnedListWithTab } from "./pane";

export interface TabSummary {
  id: string;
  name: string;
  order: number;
  count: number;
}

/** Pure reducer: tab registry + raw pin pairs → per-tab summaries with counts. */
export function buildTabSummaries(
  tabs: TabEntry[],
  pins: ReadonlyArray<{ id: string; tab: string }>,
): TabSummary[] {
  const counts = new Map<string, number>();
  for (const t of tabs) counts.set(t.id, 0);
  for (const p of pins) {
    const resolved = resolveTabId(p.tab, tabs);
    counts.set(resolved, (counts.get(resolved) ?? 0) + 1);
  }
  return tabs.map((t, order) => ({ id: t.id, name: t.name, order, count: counts.get(t.id) ?? 0 }));
}

/** Load the normalized tab registry from the user config on disk. */
export function loadTabRegistry(): TabEntry[] {
  return normalizeTabs(loadUserConfig().commandCenterTabs);
}

const PINNED_LIST_FORMAT = "#{pane_id}:#{@jmux-pinned}";

export function handleCc(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  switch (parsed.action) {
    case "tabs": {
      const tabs = loadTabRegistry();
      const lines = tmuxOrThrow(
        runTmuxDirect(["list-panes", "-a", "-F", PINNED_LIST_FORMAT], ctx.socket),
      );
      const pins = parsePinnedListWithTab(lines);
      return { tabs: buildTabSummaries(tabs, pins) };
    }
    default:
      throw new CliError(
        `Unknown cc action "${parsed.action}". Known actions: tabs`,
      );
  }
}
```

Wire dispatch in `src/cli.ts` — add the import near the other handler imports:

```typescript
import { handleCc } from "./cli/cc";
```

and add the case in the `switch (parsed.group)` block (after `case "status":`):

```typescript
      case "cc":
        result = handleCc(ctx, parsed);
        break;
```

Add `cc` to the help text `GROUPS` block (`CTL_HELP`, after the `status` line) and document `--tab`:

```
  cc         Command Center tabs (cc tabs)
```
```
  --tab <val>          Command Center tab id or name (pane pin)
```

- [ ] **Step 8: Run the handler test to verify it passes**

Run: `bun test src/__tests__/cli/cc.test.ts && bun test src/__tests__/cli/parse-cc.test.ts`
Expected: PASS.

- [ ] **Step 9: Make `pane pin --tab` and `pane pinned` tab-aware**

Modify `src/cli/pane.ts`. Add an import at the top:

```typescript
import { loadTabRegistry } from "./cc";
import { resolveTabId } from "../glass/tabs";
```

Add a helper that resolves a user-supplied `--tab` (id or name) to a tab id:

```typescript
/** Resolve a --tab argument (id or display name) to a tab id. Unknown values
 *  pass through verbatim — they resolve to the default tab at read time. */
function resolveTabFlagToId(tabFlag: string | undefined): string | undefined {
  if (!tabFlag) return undefined;
  const tabs = loadTabRegistry();
  if (tabs.some((t) => t.id === tabFlag)) return tabFlag;
  const lower = tabFlag.toLowerCase();
  const byName = tabs.find((t) => t.name.toLowerCase() === lower);
  return byName ? byName.id : tabFlag;
}
```

Replace the `case "pin": case "unpin":` block:

```typescript
    case "pin":
    case "unpin": {
      const target = resolvePaneTarget(ctx, flags);
      const tabId = action === "pin"
        ? resolveTabFlagToId(typeof flags.tab === "string" ? flags.tab : undefined)
        : undefined;
      for (const cmd of buildPinCommands(action as "pin" | "unpin", target, tabId)) {
        const result = runTmuxDirect(cmd.args, ctx.socket);
        if (cmd.required) tmuxOrThrow(result);
      }
      return { target, pinned: action === "pin", tab: tabId ?? null };
    }
```

Replace the `case "pinned":` block to return resolved tab ids:

```typescript
    case "pinned": {
      const lines = tmuxOrThrow(
        runTmuxDirect(["list-panes", "-a", "-F", PINNED_LIST_FORMAT], ctx.socket),
      );
      const tabs = loadTabRegistry();
      const pinned = parsePinnedListWithTab(lines).map((e) => ({
        id: e.id,
        tab: resolveTabId(e.tab, tabs),
      }));
      return { pinned };
    }
```

(`PINNED_LIST_FORMAT` already exists at the top of `pane.ts`; reuse it.)

- [ ] **Step 10: Run the full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS across the whole suite; typecheck clean.

- [ ] **Step 11: Commit**

```bash
git add src/cli.ts src/cli/cc.ts src/cli/pane.ts \
  src/__tests__/cli/parse-cc.test.ts src/__tests__/cli/cc.test.ts
git commit -m "feat(ctl): cc tabs group, --tab flag, tab-aware pane pin/pinned"
```

---

## Self-Review

**Spec coverage (Foundation scope):**
- Tab registry storage/shape, seeding, default-at-index-0, id/name split → Tasks 1–2.
- Validation (trim/empty/length/dup), slug ids, CRUD + reorder (blocked-delete, protected default) → Task 2.
- Default-tab fallback for legacy `"1"`/unknown/auto → Task 1 (`resolveTabId`), exercised again in Task 8 counts.
- Raw pin propagation (the spec's #1 blocker, three seams) → Task 4 (reflect), Task 5 (tracker); the third seam (`main.ts:3769`) is **Runtime-plan** wiring and is called out there.
- Per-tab summary dot reducer → Task 3.
- Disabled/hinted palette primitive → Task 6.
- ctl `cc` group + `--tab` value flag + tab-aware `pin`/`pinned` → Tasks 7–8.

**Deferred to the Runtime plan (intentionally not here):** `GlassView` lazy keep-warm + `tabId` specs + active-tab filter; tab-strip toolbar render + geometry + mouse hit-test; buffered glass `Ctrl-a <n>`; `refreshPinnedPanes` wiring (raw value through to resolution, `GlassTileSpec.tabId`, summary counts); palette command-set build for pin/move/unpin/tab-CRUD/switch with the context-aware in-glass vs session split; config-watch registry reload + active/last-active clamp; last-active-tab in-memory; the same-window-zoom regression test.

**Placeholder scan:** none — every code step contains complete code and exact commands.

**Type consistency:** `TabEntry`, `normalizeTabs`, `defaultTabId`, `resolveTabId` (Task 1) reused verbatim in Tasks 2/3/8. `parsePinnedListWithTab` (Task 7) consumed by Task 8. `PaneState.pins` (Task 4) and `PinnedPaneTracker.getValue` (Task 5) are the named hooks the Runtime plan consumes. `buildPinCommands(verb, target, tabId?)` (Task 7) — the optional `tabId` defaulting to `"1"` keeps every existing 2-arg caller compiling and green through this entire plan.

## Execution Handoff

The Runtime plan (`2026-06-28-command-center-tabs-runtime.md`) depends on these interfaces and should be executed after this one is green.
