import { runTmuxDirect } from "./tmux";
import { INTERNAL_SESSION_FILTER } from "../glass/internal-sessions";
import { CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

/**
 * Field separator for structured tmux `-F` output. tmux session names cannot
 * contain it and `pane_current_path` / option values realistically never do,
 * so unlike the legacy `:`-splitting parsers we can split with an exact field
 * count and no rejoin gymnastics. ASCII Unit Separator (US, 0x1f).
 */
export const US = "\x1f";

export type CtlAgentState = "running" | "waiting" | "complete";

const VALID_AGENT_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "complete",
]);

export interface AgentRecord {
  session: string;
  sessionId: string;
  state: CtlAgentState | null;
  /** Epoch seconds, as written by the agent hooks (`date +%s`). */
  since: number | null;
  ageSeconds: number | null;
  /**
   * The pane actually running Claude, written by the agent hooks
   * (`@jmux-agent-pane`). `null` when hooks predate this option (re-run
   * `jmux --install-agent-hooks`) or no agent has fired yet. Prefer this over
   * `activePane` when targeting the agent — it's correct after splits.
   */
  agentPane: string | null;
  /** The session's currently active pane — a best-effort fallback only. */
  activePane: string | null;
  path: string | null;
}

const AGENT_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{@jmux-agent-state}",
  "#{@jmux-agent-state-since}",
  "#{@jmux-agent-pane}",
  "#{pane_id}",
  "#{pane_current_path}",
].join(US);

/**
 * Parse one `list-sessions -F` line into an AgentRecord. Pure — `nowSeconds`
 * is injected so age computation is deterministic in tests.
 *
 * tmux renders an unset user option as an empty string, so an agent that never
 * fired a hook yields `state: null` rather than a bogus record.
 */
export function parseAgentStateLine(
  line: string,
  nowSeconds: number,
): AgentRecord | null {
  const parts = line.split(US);
  if (parts.length < 7) return null;

  const sessionId = parts[0];
  const session = parts[1];
  const rawState = parts[2];
  const rawSince = parts[3];
  const agentPane = parts[4] || null;
  const activePane = parts[5] || null;
  const path = parts[6] || null;

  const state = VALID_AGENT_STATES.has(rawState)
    ? (rawState as CtlAgentState)
    : null;

  let since: number | null = null;
  const seconds = Number(rawSince);
  if (rawSince && Number.isFinite(seconds) && seconds > 0) {
    since = Math.floor(seconds);
  }

  const ageSeconds = since !== null ? Math.max(0, nowSeconds - since) : null;

  return { session, sessionId, state, since, ageSeconds, agentPane, activePane, path };
}

function listAgentRecords(
  ctx: CliContext,
  sessionFilter: string | null,
  nowSeconds: number,
): AgentRecord[] {
  const args = ["list-sessions", "-f", INTERNAL_SESSION_FILTER, "-F", AGENT_FORMAT];
  if (sessionFilter) {
    args.push("-f", `#{==:#{session_name},${sessionFilter}}`);
  }
  const result = runTmuxDirect(args, ctx.socket);
  // No sessions → tmux exits non-zero; treat as empty.
  const lines = result.ok ? result.lines : [];
  return lines
    .map((line) => parseAgentStateLine(line, nowSeconds))
    .filter((r): r is AgentRecord => r !== null);
}

/**
 * Resolve which sessions a query targets:
 * - `--all` always means every session.
 * - `--session <name>` means just that one.
 * - neither means every session (orchestrator-friendly default).
 */
function resolveAgentFilter(flags: ParsedCtlArgs["flags"]): string | null {
  if (flags.all) return null;
  if (typeof flags.session === "string") return flags.session;
  return null;
}

export async function handleAgent(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<unknown> {
  const { action, flags } = parsed;

  switch (action) {
    case "state": {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const filter = resolveAgentFilter(flags);
      const agents = listAgentRecords(ctx, filter, nowSeconds);
      return { agents };
    }

    case "watch":
      // Routed in runCtl before the dispatch switch — it streams JSONL and
      // never returns a single envelope. Reaching here is a programming error.
      throw new CliError("agent watch is handled as a streaming command");

    default:
      throw new CliError(
        `Unknown agent action "${action}". Known actions: state, watch`,
      );
  }
}

export interface AgentWatchEvent {
  type: "agent_state_changed";
  session: string;
  state: CtlAgentState | null;
  since: number | null;
}

export interface WatchEntry {
  session: string;
  state: CtlAgentState | null;
  since: number | null;
}

/**
 * Compute the JSONL events to emit given the previous and current per-session
 * state, keyed by tmux session id. Pure — the polling loop is the only impure
 * part and is intentionally not unit-tested (per the no-tmux-in-tests rule).
 *
 * Emission rules:
 * - A newly seen session emits only if it actually has an agent state (we don't
 *   announce idle shells on the first poll — that would be noise).
 * - A known session emits whenever `state` or `since` changes (a re-run bumps
 *   `since` even if the state label repeats).
 * - A session that disappears (killed) emits a terminal `state: null` event so a
 *   watcher monitoring one session learns it is gone.
 */
export function diffAgentStates(
  prev: Map<string, WatchEntry>,
  next: Map<string, WatchEntry>,
): AgentWatchEvent[] {
  const events: AgentWatchEvent[] = [];

  for (const [id, cur] of next) {
    const before = prev.get(id);
    if (!before) {
      if (cur.state !== null) {
        events.push(toEvent(cur));
      }
    } else if (before.state !== cur.state || before.since !== cur.since) {
      events.push(toEvent(cur));
    }
  }

  for (const [id, before] of prev) {
    if (!next.has(id) && before.state !== null) {
      events.push({
        type: "agent_state_changed",
        session: before.session,
        state: null,
        since: null,
      });
    }
  }

  return events;
}

function toEvent(entry: WatchEntry): AgentWatchEvent {
  return {
    type: "agent_state_changed",
    session: entry.session,
    state: entry.state,
    since: entry.since,
  };
}

const DEFAULT_WATCH_INTERVAL_MS = 1000;
const MIN_WATCH_INTERVAL_MS = 200;

function resolveInterval(flags: ParsedCtlArgs["flags"]): number {
  if (typeof flags.interval === "string") {
    const n = parseInt(flags.interval, 10);
    if (!Number.isNaN(n)) return Math.max(MIN_WATCH_INTERVAL_MS, n);
  }
  return DEFAULT_WATCH_INTERVAL_MS;
}

/**
 * Long-running poller. Emits one JSON line per state transition until the
 * process is interrupted (SIGINT). Internal polling keeps the external contract
 * — JSONL events — independent of how we observe tmux.
 */
export async function runAgentWatch(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<void> {
  const intervalMs = resolveInterval(parsed.flags);
  const filter = resolveAgentFilter(parsed.flags);

  let prev = new Map<string, WatchEntry>();
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const records = listAgentRecords(ctx, filter, nowSeconds);
    const next = new Map<string, WatchEntry>();
    for (const r of records) {
      next.set(r.sessionId, {
        session: r.session,
        state: r.state,
        since: r.since,
      });
    }
    for (const event of diffAgentStates(prev, next)) {
      process.stdout.write(JSON.stringify(event) + "\n");
    }
    prev = next;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
