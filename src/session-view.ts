import type { SessionInfo, SessionOtelState } from "./types";
import type { SessionContext } from "./adapters/types";

const CACHE_TIMER_TTL = 300; // seconds
const COMPACTION_FLASH_MS = 30_000;

export type IndicatorKind = "error" | "mcp-down" | "attention" | "activity" | null;

export type ModeBadge = "P" | "A" | "compaction" | null;

export interface SessionView {
  sessionId: string;
  sessionName: string;

  hasActivity: boolean;
  hasAttention: boolean;
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
  timerState: SessionOtelState | undefined,
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

  // Col-1 indicator priority: error > mcp-down > attention > activity.
  let indicatorKind: IndicatorKind = null;
  if (timerState?.lastError) indicatorKind = "error";
  else if ((timerState?.failedMcpServers.size ?? 0) > 0) indicatorKind = "mcp-down";
  else if (session.attention) indicatorKind = "attention";
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
    hasAttention: session.attention,
    indicatorKind,
    modeBadge,
    linearId,
    branch: session.gitBranch ?? null,
    timerText,
    timerRemaining,
    mrId,
    pipelineState,
  };
}

function formatToolDuration(ms: number): string {
  if (ms < 60_000) {
    const s = (ms / 1000).toFixed(1);
    return `${s}s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m${s}s`;
}

function formatIdle(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s idle`;
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return `${m}m idle`;
  const h = Math.floor(m / 60);
  return `${h}h idle`;
}

const ROW3_GAP = "  ";

export function buildSessionRow3(state: SessionOtelState, width: number): string {
  const costText = state.costUsd > 0 ? `$${state.costUsd.toFixed(2)}` : null;
  const toolText = state.lastTool
    ? `${state.lastTool.name} ${formatToolDuration(state.lastTool.durationMs)}`
    : null;
  const idleText = state.lastUserPromptTime !== null
    ? formatIdle(Date.now() - state.lastUserPromptTime)
    : null;

  const usable = Math.max(0, width);

  // Drop priority: try (cost+tool+idle), then (cost+tool), then (cost+idle), then (tool+idle), then singles.
  const candidates: Array<Array<{ text: string; align: "left" | "right" }>> = [];
  if (costText && toolText && idleText) {
    candidates.push([
      { text: costText, align: "left" },
      { text: toolText, align: "left" },
      { text: idleText, align: "right" },
    ]);
  }
  if (costText && toolText) {
    candidates.push([
      { text: costText, align: "left" },
      { text: toolText, align: "left" },
    ]);
  }
  if (costText && idleText) {
    candidates.push([
      { text: costText, align: "left" },
      { text: idleText, align: "right" },
    ]);
  }
  if (toolText && idleText) {
    candidates.push([
      { text: toolText, align: "left" },
      { text: idleText, align: "right" },
    ]);
  }
  if (costText) candidates.push([{ text: costText, align: "left" }]);
  if (toolText) candidates.push([{ text: toolText, align: "left" }]);
  if (idleText) candidates.push([{ text: idleText, align: "right" }]);

  for (const fields of candidates) {
    const totalLen = fields.reduce((s, f) => s + f.text.length, 0)
      + Math.max(0, fields.length - 1) * ROW3_GAP.length;
    if (totalLen <= usable) {
      return layoutRow3(fields, usable);
    }
  }

  // Last resort: cost truncated
  if (costText) return costText.slice(0, usable);
  return "";
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
