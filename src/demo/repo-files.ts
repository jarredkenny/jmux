/**
 * Seeded source trees for demo mode's sessions.
 *
 * These are string constants rather than files read from the source tree on
 * purpose: `bun build --compile` collapses `import.meta.dir` to `/$bunfs`, so a
 * demo repo loaded off disk would work from source and break in the shipped
 * binary. Strings compile in. This is the same constraint `assets.ts` solves
 * with materialization, but nothing here needs to be read by another *process*,
 * so plain constants are enough — no hashing, no XDG directory, no race.
 *
 * The code is deliberately small, plausible, and *slightly wrong* in the place
 * each seed issue describes, so a live agent pointed at the matching task has a
 * real defect to find rather than a blank file to invent one in.
 */

export type DemoProject = "platform" | "dashboard";

const PLATFORM_FILES: Record<string, string> = {
  "package.json": `{
  "name": "@acme/platform",
  "version": "2.4.0",
  "type": "module",
  "scripts": {
    "test": "bun test"
  }
}
`,

  "src/auth.ts": `import { apiFetch } from "./client";

export interface Session {
  token: string;
  refreshToken: string;
  expiresAt: number;
}

let current: Session | null = null;

export function setSession(session: Session): void {
  current = session;
}

export function getSession(): Session | null {
  return current;
}

/**
 * Refresh the access token using the long-lived refresh token.
 */
export async function refreshSession(): Promise<Session> {
  if (!current) throw new Error("no session to refresh");

  const res = await apiFetch("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: current.refreshToken }),
  });

  const next = (await res.json()) as Session;
  setSession(next);
  return next;
}

/**
 * Perform an authenticated request.
 *
 * ENG-1234: a 401 here means the access token expired mid-flight. We surface
 * the error to the caller instead of refreshing and retrying once, so any
 * long-running page throws at the user the moment the token ages out.
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = getSession();
  if (!session) throw new Error("not authenticated");

  const res = await apiFetch(path, {
    ...init,
    headers: { ...init.headers, authorization: \`Bearer \${session.token}\` },
  });

  if (res.status === 401) {
    throw new Error("unauthorized");
  }

  return res;
}
`,

  "src/client.ts": `const BASE_URL = process.env.ACME_API_URL ?? "https://api.acme.test";

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(\`\${BASE_URL}\${path}\`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}
`,

  "src/pagination.ts": `export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * ENG-1241: offset paging drops rows when the underlying set changes between
 * requests. Should be cursor-based.
 */
export function buildQuery(offset: number, limit: number): string {
  return \`?offset=\${offset}&limit=\${limit}\`;
}

export function parsePage<T>(body: { data: T[]; total: number }, offset: number, limit: number): Page<T> {
  const consumed = offset + body.data.length;
  return {
    items: body.data,
    nextCursor: consumed < body.total ? String(consumed) : null,
  };
}
`,

  "test/auth.test.ts": `import { describe, expect, test, beforeEach } from "bun:test";
import { setSession, getSession, authedFetch } from "../src/auth";

describe("auth", () => {
  beforeEach(() => {
    setSession({ token: "t0", refreshToken: "r0", expiresAt: 0 });
  });

  test("stores the session", () => {
    expect(getSession()?.token).toBe("t0");
  });

  test("throws without a session", async () => {
    // @ts-expect-error deliberately clearing for the test
    setSession(null);
    await expect(authedFetch("/me")).rejects.toThrow("not authenticated");
  });
});
`,

  "README.md": `# @acme/platform

Core API client and session handling for the Acme platform.

    bun install
    bun test
`,
};

const DASHBOARD_FILES: Record<string, string> = {
  "package.json": `{
  "name": "@acme/dashboard",
  "version": "1.9.2",
  "type": "module",
  "scripts": {
    "test": "bun test"
  }
}
`,

  "src/chart.ts": `export interface Point {
  t: number;
  v: number;
}

/**
 * DASH-315: this re-sorts and re-scans the full series on every render. With
 * 10k points the dashboard drops frames while panning.
 */
export function render(points: Point[], width: number): string[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const min = Math.min(...sorted.map((p) => p.v));
  const max = Math.max(...sorted.map((p) => p.v));
  const span = max - min || 1;

  const cols: string[] = [];
  for (let x = 0; x < width; x++) {
    const slice = sorted.filter((_, i) => i % width === x);
    const avg = slice.reduce((sum, p) => sum + p.v, 0) / (slice.length || 1);
    cols.push(bar((avg - min) / span));
  }
  return cols;
}

function bar(ratio: number): string {
  const glyphs = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const i = Math.round(ratio * (glyphs.length - 1));
  return glyphs[Math.max(0, Math.min(glyphs.length - 1, i))]!;
}
`,

  "src/settings.ts": `export interface Preferences {
  theme: "light" | "dark" | "system";
  density: "comfortable" | "compact";
  timezone: string;
}

export const DEFAULTS: Preferences = {
  theme: "system",
  density: "comfortable",
  timezone: "UTC",
};

/**
 * DASH-301: unknown keys in stored preferences silently overwrite defaults,
 * so a preference removed in a later release keeps applying.
 */
export function load(raw: string): Preferences {
  const parsed = JSON.parse(raw) as Partial<Preferences>;
  return { ...DEFAULTS, ...parsed };
}
`,

  "test/chart.test.ts": `import { describe, expect, test } from "bun:test";
import { render } from "../src/chart";

describe("chart", () => {
  test("renders one column per width unit", () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ t: i, v: i % 10 }));
    expect(render(points, 20)).toHaveLength(20);
  });

  test("handles a flat series", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ t: i, v: 5 }));
    expect(render(points, 5)).toHaveLength(5);
  });
});
`,

  "README.md": `# @acme/dashboard

Charting and preferences for the Acme dashboard.

    bun install
    bun test
`,
};

/** Source tree for a demo project, keyed by path relative to the repo root. */
export function repoFiles(project: DemoProject): Record<string, string> {
  return project === "platform" ? PLATFORM_FILES : DASHBOARD_FILES;
}

/**
 * Claude Code permission mode for a demo session.
 *
 * `default` prompts before each edit; `acceptEdits` works straight through.
 */
export type DemoPermissionMode = "default" | "acceptEdits";

export interface DemoAgentJob {
  /** Prompt handed to the agent. */
  task: string;
  /** Permission mode written into the session's project-local settings. */
  mode: DemoPermissionMode;
  /**
   * Tools pre-approved for this session.
   *
   * `acceptEdits` only covers *edits*. An agent that also runs its tests shells
   * out, and Bash still stops to ask — which is how three sessions meant to be
   * quietly working ended up flagged WAITING alongside the one that was supposed
   * to be the only flag on screen. Naming the tools is narrower than
   * `bypassPermissions` and, unlike it, still honours deny rules.
   */
  allow?: readonly string[];
}

/** Pre-approvals for a session that should work through without stopping. */
const WORKS_THROUGH: readonly string[] = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];

/**
 * What each live session's agent is told to do, keyed by session name.
 *
 * Tasks are scoped deliberately tight. A broad prompt ("improve the auth
 * module") makes a live agent wander for minutes and produce a different diff
 * every take; a narrow one lands in roughly the same place each time, which is
 * what makes a retake comparable to the take before it. Every task names a file
 * that exists and a defect that is really in it.
 *
 * **`mode` is what composes the shot.** Every agent left on `default` hits its
 * first edit at roughly the same moment and stops, so the sidebar fills with
 * WAITING and the pitch inverts — "five agents working, one needs you" becomes
 * five agents all needing you. Exactly one session asks; the rest are trusted
 * to work through, so the sidebar shows a working fleet with a single flag on
 * it. That is also just what a real fleet looks like.
 */
export const DEMO_AGENT_JOBS: Record<string, DemoAgentJob> = {
  // The hero session: the one that stops and asks, on camera.
  "auth-refactor": {
    task:
      "ENG-1234: authedFetch in src/auth.ts throws on a 401 instead of refreshing " +
      "the token and retrying once. Fix it, and add a test to test/auth.test.ts " +
      "covering the retry.",
    mode: "default",
  },
  "api-pagination": {
    task:
      "ENG-1241: buildQuery in src/pagination.ts uses offset paging, which drops " +
      "rows when the set changes between requests. Switch it to cursor-based.",
    mode: "acceptEdits",
    allow: WORKS_THROUGH,
  },
  "chart-perf": {
    task:
      "DASH-315: render in src/chart.ts re-sorts and re-scans the whole series on " +
      "every call. Make it do a single pass.",
    mode: "acceptEdits",
    allow: WORKS_THROUGH,
  },
  "user-settings": {
    task:
      "DASH-301: load in src/settings.ts lets unknown keys through and overwrite " +
      "defaults. Drop keys that aren't in DEFAULTS.",
    mode: "acceptEdits",
    allow: WORKS_THROUGH,
  },
};
