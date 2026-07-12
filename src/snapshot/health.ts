export type SnapshotHealth =
  | "disabled"
  | "starting"
  | "healthy"
  | "locked_live"
  | "stale"
  | "error"
  | "stopped"
  | "control_channel_lost";

export interface SubsystemHealth {
  lastSuccessMs: number | null;
  lastAttemptMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface HealthSnapshot {
  topology: SubsystemHealth;
  stateCommit: SubsystemHealth;
  scrollback: SubsystemHealth;
  lockCompromised: boolean;
  updatedAtMs: number;
}

export function emptySubsystem(): SubsystemHealth {
  return {
    lastSuccessMs: null,
    lastAttemptMs: null,
    lastError: null,
    consecutiveFailures: 0,
  };
}

export function emptyHealth(nowMs: number): HealthSnapshot {
  return {
    topology: emptySubsystem(),
    stateCommit: emptySubsystem(),
    scrollback: emptySubsystem(),
    lockCompromised: false,
    updatedAtMs: nowMs,
  };
}

export function recordSuccess(s: SubsystemHealth, nowMs: number): void {
  s.lastAttemptMs = nowMs;
  s.lastSuccessMs = nowMs;
  s.lastError = null;
  s.consecutiveFailures = 0;
}

export function recordFailure(
  s: SubsystemHealth,
  nowMs: number,
  err: string,
): void {
  s.lastAttemptMs = nowMs;
  s.lastError = err;
  s.consecutiveFailures += 1;
}

const DEFAULT_FAIL_THRESHOLD = 3;

/**
 * Collapse the per-subsystem signals into a single health verdict.
 *
 * - `lockCompromised` or any subsystem failing `failThreshold` times in a row
 *   is `error`.
 * - No successful state commit yet is `starting`.
 * - A state commit older than `staleMs` is `stale`.
 * - Otherwise `healthy`.
 *
 * Note: this derives from *storage* + *topology* signals; a fully frozen event
 * loop cannot advance any signal, so its staleness is only observable via the
 * persisted health read on the next launch.
 */
export function deriveHealth(
  h: HealthSnapshot,
  nowMs: number,
  staleMs: number,
  failThreshold: number = DEFAULT_FAIL_THRESHOLD,
): SnapshotHealth {
  if (h.lockCompromised) return "error";
  if (
    h.topology.consecutiveFailures >= failThreshold ||
    h.stateCommit.consecutiveFailures >= failThreshold ||
    h.scrollback.consecutiveFailures >= failThreshold
  ) {
    return "error";
  }
  const lastCommit = h.stateCommit.lastSuccessMs;
  if (lastCommit == null) return "starting";
  if (nowMs - lastCommit > staleMs) return "stale";
  return "healthy";
}
