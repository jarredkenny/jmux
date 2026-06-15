/**
 * jmux-internal tmux sessions (the pane-of-glass holding session, the parked
 * main-client scratch session, and the per-tile group-member sessions) all
 * share this reserved name prefix so a single predicate can hide them from the
 * sidebar, the snapshotter, and every `jmux ctl` reader.
 */
export const INTERNAL_SESSION_PREFIX = "__jmux_";

/** The single hidden holding session pinned panes are broken out into. */
export const GLASS_HOLDING_SESSION = `${INTERNAL_SESSION_PREFIX}glass`;

/** Scratch session the main interactive client parks on while the glass is up. */
export const PARK_SESSION = `${INTERNAL_SESSION_PREFIX}park`;

/** Per-tile session-group member name for a given pane id (e.g. "%7" → "__jmux_tile_7"). */
export function tileSessionName(paneId: string): string {
  return `${INTERNAL_SESSION_PREFIX}tile_${paneId.replace(/^%/, "")}`;
}

/** True when a session name belongs to jmux's internal set and must be hidden. */
export function isInternalSession(name: string): boolean {
  return name.startsWith(INTERNAL_SESSION_PREFIX);
}

/**
 * tmux `-f` filter for `list-sessions` that drops internal sessions at the
 * source. `-f` keeps rows whose format evaluates to a non-zero, non-empty
 * value; this conditional yields "0" for a name matching `__jmux_*` (skipped)
 * and "1" otherwise (kept). Uses only operators documented in the tmux 3.6a
 * manual — there is NO `#{!:}` logical-NOT operator.
 */
export const INTERNAL_SESSION_FILTER = "#{?#{m:__jmux_*,#{session_name}},0,1}";
