import type { AgentState, AgentStateRecord } from "./types";

/**
 * Structural shape for a stored snapshot agent state. Task 3 will declare
 * the canonical `SnapshotAgentState` type in `src/snapshot/schema.ts`
 * with this exact shape — structural typing keeps these compatible
 * without a cross-module import.
 */
export interface StoredAgentState {
  state: AgentState;
  /** ISO timestamp string. */
  since: string;
}

/**
 * If the snapshot is older than `thresholdMs` and the stored state is
 * `running` or `waiting`, coerce it to `complete` — an agent that was
 * running 10+ minutes ago without any subsequent hook fire is almost
 * certainly dead. Used by the snapshot restore path.
 *
 * A malformed `capturedAt` is treated as stale (safest: we don't want
 * to leave a bogus "RUNNING 4h" on the screen after a long suspend).
 *
 * The generic `<T extends StoredAgentState>` means callers can pass a
 * richer type (e.g. SnapshotAgentState) and get it back unchanged when
 * not coerced, preserving any extra fields.
 */
export function coerceStaleAgentState<T extends StoredAgentState>(
  stored: T | null,
  capturedAt: string,
  nowMs: number,
  thresholdMs: number,
): T | null {
  if (stored === null) return null;
  if (stored.state === "complete") return stored;

  const capturedMs = Date.parse(capturedAt);
  const age = Number.isFinite(capturedMs)
    ? nowMs - capturedMs
    : Number.POSITIVE_INFINITY;

  if (age <= thresholdMs) return stored;
  // Cast through unknown: we're deliberately widening `state` from a
  // narrower literal to "complete". The generic T is preserved for all
  // other fields; only `state` is overwritten.
  return { ...stored, state: "complete" } as unknown as T;
}

// Keep VALID_STATES in sync with the AgentState union: adding/removing a
// member there must change the keys here, otherwise this object becomes a
// type error.
const VALID_STATES_KEYS: Record<AgentState, true> = {
  running: true,
  waiting: true,
  complete: true,
};
const VALID_STATES: ReadonlySet<string> = new Set(Object.keys(VALID_STATES_KEYS));

function isAgentState(v: string): v is AgentState {
  return VALID_STATES.has(v);
}

type ChangeListener = (sessionId: string) => void;

/**
 * Reflects the per-session @jmux-agent-state / @jmux-agent-state-since
 * tmux user options into a typed in-process map. Treats tmux as the source
 * of truth — apply() consumes raw string updates from the control channel
 * and parses/validates them.
 */
export class AgentStateTracker {
  private records = new Map<string, AgentStateRecord>();
  private listeners: ChangeListener[] = [];

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  get size(): number {
    return this.records.size;
  }

  getState(sessionId: string): AgentState | null {
    return this.records.get(sessionId)?.state ?? null;
  }

  getRecord(sessionId: string): AgentStateRecord | null {
    return this.records.get(sessionId) ?? null;
  }

  onChange(fn: ChangeListener): void {
    this.listeners.push(fn);
  }

  /**
   * Apply an update from the control channel. rawState comes from
   * @jmux-agent-state; rawSince comes from @jmux-agent-state-since (epoch
   * seconds as a string, the way `date +%s` produces it).
   *
   * - null or empty rawState clears the record.
   * - unknown rawState is ignored (no state change, no emission).
   * - missing/unparseable rawSince falls back to nowMs().
   * - idempotent re-apply (same state, same since) does not emit.
   */
  apply(
    sessionId: string,
    rawState: string | null,
    rawSince: string | null,
  ): void {
    const previous = this.records.get(sessionId) ?? null;

    if (rawState === null || rawState === "") {
      if (previous === null) return;
      this.records.delete(sessionId);
      this.emit(sessionId);
      return;
    }

    if (!isAgentState(rawState)) return;

    const sinceMs = this.parseSinceMs(rawSince);
    if (previous && previous.state === rawState && previous.since === sinceMs) {
      return;
    }
    this.records.set(sessionId, { state: rawState, since: sinceMs });
    this.emit(sessionId);
  }

  pruneExcept(activeIds: string[]): void {
    const active = new Set(activeIds);
    // Snapshot keys first, then delete — iterating while mutating a Map is
    // legal but unidiomatic and trips readers. Pruning is a cleanup pass,
    // not a semantic state change, so we intentionally do not emit.
    const toDelete = [...this.records.keys()].filter((id) => !active.has(id));
    for (const id of toDelete) this.records.delete(id);
  }

  private parseSinceMs(rawSince: string | null): number {
    if (rawSince === null || rawSince === "") return this.nowMs();
    const seconds = Number(rawSince);
    if (!Number.isFinite(seconds) || seconds <= 0) return this.nowMs();
    return Math.floor(seconds * 1000);
  }

  private emit(sessionId: string): void {
    for (const fn of this.listeners) fn(sessionId);
  }
}
