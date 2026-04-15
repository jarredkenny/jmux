import type { SessionInfo, CacheTimerState } from "./types";
import type { SessionContext } from "./adapters/types";

const CACHE_TIMER_TTL = 300; // seconds

export interface SessionView {
  sessionId: string;
  sessionName: string;

  hasActivity: boolean;
  hasAttention: boolean;

  // Row 1, right-aligned
  linearId: string | null;

  // Row 2, left-aligned
  branch: string | null;

  // Row 2, center-right
  timerText: string | null;
  timerRemaining: number;

  // Row 2, right-aligned
  mrId: string | null;
  pipelineState: string | null;
}

function formatTimer(remaining: number): string {
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Extract the MR iid (e.g. "42") from compound id "project:42" */
function extractMrIid(compoundId: string): string {
  const colonIdx = compoundId.lastIndexOf(":");
  return colonIdx >= 0 ? compoundId.slice(colonIdx + 1) : compoundId;
}

export function buildSessionView(
  session: SessionInfo,
  ctx: SessionContext | undefined,
  timerState: CacheTimerState | undefined,
  activitySet: Set<string>,
): SessionView {
  // Linear ID: first issue identifier
  const linearId = ctx?.issues[0]?.identifier ?? null;

  // MR: pick latest by createdAt, fall back to last in array
  let selectedMr = null;
  if (ctx && ctx.mrs.length > 0) {
    const withCreated = ctx.mrs.filter((mr) => mr.createdAt != null);
    if (withCreated.length > 0) {
      selectedMr = withCreated.reduce((latest, mr) =>
        (mr.createdAt! > latest.createdAt!) ? mr : latest
      );
    } else {
      selectedMr = ctx.mrs[ctx.mrs.length - 1];
    }
  }

  const mrId = selectedMr ? `!${extractMrIid(selectedMr.id)}` : null;
  const pipelineState = selectedMr?.pipeline?.state ?? null;

  // Timer
  let timerText: string | null = null;
  let timerRemaining = 0;
  if (timerState) {
    const elapsed = Math.floor((Date.now() - timerState.lastRequestTime) / 1000);
    timerRemaining = Math.max(0, CACHE_TIMER_TTL - elapsed);
    timerText = formatTimer(timerRemaining);
  }

  return {
    sessionId: session.id,
    sessionName: session.name,
    hasActivity: activitySet.has(session.id),
    hasAttention: session.attention,
    linearId,
    branch: session.gitBranch ?? null,
    timerText,
    timerRemaining,
    mrId,
    pipelineState,
  };
}
