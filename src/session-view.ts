import type { SessionInfo, SessionOtelState, AgentState, AgentStateRecord } from "./types";
import type { SessionContext } from "./adapters/types";

const CACHE_TIMER_TTL = 300; // seconds
const COMPACTION_FLASH_MS = 30_000;

export type IndicatorKind =
  | "error"
  | "mcp-down"
  | "agent-running"
  | "agent-waiting"
  | "agent-complete"
  | "activity"
  | null;

export type ModeBadge = "P" | "A" | "compaction" | null;

export interface SessionView {
  sessionId: string;
  sessionName: string;

  hasActivity: boolean;
  indicatorKind: IndicatorKind;

  // Row 1, between name and Linear ID
  modeBadge: ModeBadge;

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

  agentState: AgentState | null;
  agentStateSince: number | null;
}

function formatTimer(remaining: number): string {
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

/** Extract the MR iid (e.g. "42") from compound id "project:42" */
function extractMrIid(compoundId: string): string {
  const colonIdx = compoundId.lastIndexOf(":");
  return colonIdx >= 0 ? compoundId.slice(colonIdx + 1) : compoundId;
}

export function buildSessionView(
  session: SessionInfo,
  ctx: SessionContext | undefined,
  timerState: SessionOtelState | undefined,
  activitySet: Set<string>,
  agentStateRecord?: AgentStateRecord | null,
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

  // Row-1 unified timer fallback chain (see spec §"Row 1 unified timer"):
  //   1) cache countdown while alive (lastRequestTime within CACHE_TIMER_TTL)
  //   2) promoted session → elapsed since agentStateSince
  //   3) non-promoted with OTEL data → elapsed since latest OTEL event
  //   4) blank
  let timerText: string | null = null;
  let timerRemaining = 0;
  const now = Date.now();
  if (timerState && timerState.lastRequestTime > 0) {
    const elapsedS = Math.floor((now - timerState.lastRequestTime) / 1000);
    timerRemaining = Math.max(0, CACHE_TIMER_TTL - elapsedS);
    if (timerRemaining > 0) {
      timerText = formatTimer(timerRemaining);
    }
  }
  if (timerText === null) {
    if (agentStateRecord) {
      timerText = formatElapsed(now - agentStateRecord.since);
    } else if (timerState) {
      const candidates = [
        timerState.lastRequestTime,
        timerState.lastUserPromptTime ?? 0,
      ].filter((t) => t > 0);
      if (candidates.length > 0) {
        timerText = formatElapsed(now - Math.max(...candidates));
      }
    }
  }

  // Col-1 indicator priority: error > mcp-down > agent-state > activity.
  let indicatorKind: IndicatorKind = null;
  if (timerState?.lastError) indicatorKind = "error";
  else if ((timerState?.failedMcpServers.size ?? 0) > 0) indicatorKind = "mcp-down";
  else if (agentStateRecord?.state === "running") indicatorKind = "agent-running";
  else if (agentStateRecord?.state === "waiting") indicatorKind = "agent-waiting";
  else if (agentStateRecord?.state === "complete") indicatorKind = "agent-complete";
  else if (activitySet.has(session.id)) indicatorKind = "activity";

  // Mode badge: P for plan, A for accept-edits. Compaction marker (⊕) shows
  // for COMPACTION_FLASH_MS after a compaction event, but only when no
  // permission-mode badge is already taking the slot.
  let modeBadge: ModeBadge = null;
  if (timerState?.permissionMode === "plan") {
    modeBadge = "P";
  } else if (timerState?.permissionMode === "accept-edits") {
    modeBadge = "A";
  } else if (
    timerState?.lastCompactionTime !== null &&
    timerState?.lastCompactionTime !== undefined &&
    Date.now() - timerState.lastCompactionTime < COMPACTION_FLASH_MS
  ) {
    modeBadge = "compaction";
  }

  return {
    sessionId: session.id,
    sessionName: session.name,
    hasActivity: activitySet.has(session.id),
    indicatorKind,
    modeBadge,
    linearId,
    branch: session.gitBranch ?? null,
    timerText,
    timerRemaining,
    mrId,
    pipelineState,
    agentState: agentStateRecord?.state ?? null,
    agentStateSince: agentStateRecord?.since ?? null,
  };
}

const ROW3_GAP = "  ";

const STATE_LABEL: Record<AgentState, string> = {
  running: "RUNNING",
  waiting: "WAITING",
  complete: "COMPLETE",
};

export interface SessionRow3Result {
  text: string;
  /** 0-based column offset into `text` where the state label begins, or -1 if no label was rendered. */
  labelCol: number;
}

function formatContext(tokens: number): string {
  if (tokens <= 0) return "";
  const k = Math.round(tokens / 1000);
  if (k >= 1000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${k}k`;
}

export function buildSessionRow3(
  state: SessionOtelState,
  width: number,
  agentState: AgentState | null,
): SessionRow3Result {
  const contextText = formatContext(state.contextTokens);
  const usable = Math.max(0, width);

  // Promoted session: the state label is the right-anchored sentinel and always
  // stays. The context figure is dropped first if it doesn't fit.
  if (agentState !== null) {
    const stateText = STATE_LABEL[agentState];
    const candidates: Array<Array<{ text: string; align: "left" | "right" }>> = [];
    if (contextText) {
      candidates.push([
        { text: contextText, align: "left" },
        { text: stateText, align: "right" },
      ]);
    }
    candidates.push([{ text: stateText, align: "right" }]);

    for (const fields of candidates) {
      const totalLen = fields.reduce((s, f) => s + f.text.length, 0)
        + Math.max(0, fields.length - 1) * ROW3_GAP.length;
      if (totalLen <= usable) {
        const text = layoutRow3(fields, usable);
        const labelCol = text.length >= stateText.length
          ? text.length - stateText.length
          : 0;
        return { text, labelCol };
      }
    }
    const text = stateText.slice(0, usable);
    return { text, labelCol: 0 };
  }

  // Non-promoted session: context figure only, left-aligned. No state label.
  // slice is a no-op when the figure already fits within usable.
  if (contextText) {
    return { text: contextText.slice(0, usable), labelCol: -1 };
  }
  return { text: "", labelCol: -1 };
}

function layoutRow3(
  fields: Array<{ text: string; align: "left" | "right" }>,
  usable: number,
): string {
  if (fields.length === 0) return "";
  const lefts = fields.filter((f) => f.align === "left").map((f) => f.text);
  const rights = fields.filter((f) => f.align === "right").map((f) => f.text);
  const leftPart = lefts.join(ROW3_GAP);
  const rightPart = rights.join(ROW3_GAP);
  if (rightPart === "") return leftPart;
  if (leftPart === "") return " ".repeat(Math.max(0, usable - rightPart.length)) + rightPart;
  const padLen = Math.max(2, usable - leftPart.length - rightPart.length);
  return leftPart + " ".repeat(padLen) + rightPart;
}
