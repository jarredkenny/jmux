import type { AgentState, AgentStateRecord } from "./types";

const VALID_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "complete",
]);

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
    for (const id of this.records.keys()) {
      if (!active.has(id)) {
        this.records.delete(id);
        // Intentionally no emit — pruning is a cleanup pass, not a
        // semantic state change. The renderer will reconcile via the
        // session list.
      }
    }
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
