import { resolve } from "path";
import { homedir } from "os";
import { runTmuxDirect } from "./tmux";
import { loadUserConfig } from "../config";
import { INTERNAL_SESSION_FILTER } from "../glass/internal-sessions";
import { SessionState, type SessionLink } from "../session-state";
import { type CtlAgentState } from "./agent";
import { US, splitFields } from "../tmux-fields";
import type { CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

const VALID_AGENT_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "complete",
]);

export interface StatusSessionRow {
  id: string;
  name: string;
  agentState: string;
  agentSince: string;
  attention: string;
  attentionReason: string;
  linearIssue: string;
  path: string;
}

const STATUS_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{@jmux-agent-state}",
  "#{@jmux-agent-state-since}",
  "#{@jmux-attention}",
  "#{@jmux-attention-reason}",
  "#{@jmux-linear-issue}",
  "#{pane_current_path}",
].join(US);

export function parseStatusLine(line: string): StatusSessionRow | null {
  const p = splitFields(line);
  if (p.length < 8) return null;
  return {
    id: p[0],
    name: p[1],
    agentState: p[2],
    agentSince: p[3],
    attention: p[4],
    attentionReason: p[5],
    linearIssue: p[6],
    path: p[7],
  };
}

export interface StatusLink {
  type: string;
  id: string;
}

export interface StatusSession {
  id: string;
  name: string;
  path: string | null;
  branch: string | null;
  agent: {
    state: CtlAgentState;
    since: number | null;
    ageSeconds: number | null;
  } | null;
  links: StatusLink[];
  attention: boolean;
  attentionReason: string | null;
  pinned: boolean;
}

export interface StatusInputs {
  rows: StatusSessionRow[];
  /** Links from the existing SessionState store (state.json), keyed by name. */
  linksByName: (name: string) => SessionLink[];
  pinnedNames: ReadonlySet<string>;
  branchByPath: (path: string) => string | null;
  nowSeconds: number;
}

/**
 * Merge the TUI-owned SessionState links (issue + MR, auto-detected) with the
 * CLI-owned `@jmux-linear-issue` tmux option, deduped by (type, id). The two
 * stores exist because a running TUI holds SessionState in memory and would
 * clobber any CLI write to state.json, so CLI issue links live in tmux options
 * (see issue.ts) — `status` reads the union.
 */
function mergeLinks(stateLinks: SessionLink[], linearIssue: string): StatusLink[] {
  const out: StatusLink[] = [];
  const seen = new Set<string>();
  const add = (type: string, id: string) => {
    const key = `${type}${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ type, id });
    }
  };
  for (const l of stateLinks) add(l.type, l.id);
  if (linearIssue) add("issue", linearIssue);
  return out;
}

export function buildStatusSnapshot(inp: StatusInputs): {
  sessions: StatusSession[];
} {
  const sessions = inp.rows.map((row): StatusSession => {
    const state = VALID_AGENT_STATES.has(row.agentState)
      ? (row.agentState as CtlAgentState)
      : null;

    let since: number | null = null;
    const seconds = Number(row.agentSince);
    if (row.agentSince && Number.isFinite(seconds) && seconds > 0) {
      since = Math.floor(seconds);
    }

    const agent = state
      ? {
          state,
          since,
          ageSeconds: since !== null ? Math.max(0, inp.nowSeconds - since) : null,
        }
      : null;

    const attention = row.attention === "1";
    const attentionReason = attention ? row.attentionReason || null : null;

    return {
      id: row.id,
      name: row.name,
      path: row.path || null,
      branch: row.path ? inp.branchByPath(row.path) : null,
      agent,
      links: mergeLinks(inp.linksByName(row.name), row.linearIssue),
      attention,
      attentionReason,
      pinned: inp.pinnedNames.has(row.name),
    };
  });

  return { sessions };
}

function gitBranch(path: string): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((r.exitCode ?? 1) !== 0) return null;
    const branch = r.stdout.toString().trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export function handleStatus(ctx: CliContext, _parsed: ParsedCtlArgs): unknown {
  const result = runTmuxDirect(["list-sessions", "-f", INTERNAL_SESSION_FILTER, "-F", STATUS_FORMAT], ctx.socket);
  const lines = result.ok ? result.lines : [];
  const rows = lines
    .map(parseStatusLine)
    .filter((r): r is StatusSessionRow => r !== null);

  const config = loadUserConfig();
  const pinnedNames = new Set(config.pinnedSessions ?? []);

  const statePath = resolve(homedir(), ".config", "jmux", "state.json");
  const sessionState = new SessionState(statePath);

  // One git call per distinct worktree path, cached across sessions.
  const branchCache = new Map<string, string | null>();
  const branchByPath = (path: string): string | null => {
    const cached = branchCache.get(path);
    if (cached !== undefined) return cached;
    const branch = gitBranch(path);
    branchCache.set(path, branch);
    return branch;
  };

  return buildStatusSnapshot({
    rows,
    linksByName: (name) => sessionState.getLinks(name),
    pinnedNames,
    branchByPath,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
}
