export const SNAPSHOT_FORMAT_VERSION = 1 as const;

export type PaneKind = "claude" | "shell" | "other";
export type SnapshotPermissionMode = "default" | "plan" | "accept-edits" | null;

export interface SessionLink {
  type: "issue" | "mr";
  id: string;
}

export interface SnapshotOtel {
  costUsd: number;
  cacheWasHit: boolean | null;
  lastRequestTime: string | null;
  lastCompactionTime: string | null;
  lastTool: string | null;
  lastUserPromptTime: string | null;
  lastError: string | null;
  failedMcpServers: string[];
}

export interface SnapshotPane {
  index: number;
  cwd: string;
  command: string;
  kind: PaneKind;
  scrollbackFile: string | null;
}

export interface SnapshotWindow {
  index: number;
  name: string;
  layout: string;
  active: boolean;
  panes: SnapshotPane[];
}

export interface SnapshotSession {
  name: string;
  cwd: string;
  worktreePath: string | null;
  projectGroup: string | null;
  pinned: boolean;
  attention: boolean;
  permissionMode: SnapshotPermissionMode;
  otel: SnapshotOtel | null;
  links: SessionLink[];
  windows: SnapshotWindow[];
}

export interface SnapshotFile {
  formatVersion: 1;
  jmuxVersion: string;
  capturedAt: string;
  tmuxSocket: string;
  lastFocusedSession: string | null;
  sessions: SnapshotSession[];
}

export type ValidationResult =
  | { ok: true; value: SnapshotFile }
  | { ok: false; error: string };

const ISO_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validatePane(v: unknown, path: string): string | null {
  if (!isRecord(v)) return `${path}: not an object`;
  if (!isFiniteNumber(v.index)) return `${path}.index: not a number`;
  if (!isString(v.cwd)) return `${path}.cwd: not a string`;
  if (!isString(v.command)) return `${path}.command: not a string`;
  if (v.kind !== "claude" && v.kind !== "shell" && v.kind !== "other") {
    return `${path}.kind: invalid value`;
  }
  if (v.scrollbackFile !== null && !isString(v.scrollbackFile)) {
    return `${path}.scrollbackFile: not string or null`;
  }
  return null;
}

function validateWindow(v: unknown, path: string): string | null {
  if (!isRecord(v)) return `${path}: not an object`;
  if (!isFiniteNumber(v.index)) return `${path}.index: not a number`;
  if (!isString(v.name)) return `${path}.name: not a string`;
  if (!isString(v.layout)) return `${path}.layout: not a string`;
  if (!isBoolean(v.active)) return `${path}.active: not a boolean`;
  if (!Array.isArray(v.panes)) return `${path}.panes: not an array`;
  for (let i = 0; i < v.panes.length; i++) {
    const err = validatePane(v.panes[i], `${path}.panes[${i}]`);
    if (err) return err;
  }
  return null;
}

function validateLink(v: unknown, path: string): string | null {
  if (!isRecord(v)) return `${path}: not an object`;
  if (v.type !== "issue" && v.type !== "mr") return `${path}.type: invalid`;
  if (!isString(v.id)) return `${path}.id: not a string`;
  return null;
}

function validateOtel(v: unknown, path: string): string | null {
  if (v === null) return null;
  if (!isRecord(v)) return `${path}: not an object or null`;
  if (!isFiniteNumber(v.costUsd)) return `${path}.costUsd: not a number`;
  if (v.cacheWasHit !== null && !isBoolean(v.cacheWasHit)) {
    return `${path}.cacheWasHit: not boolean or null`;
  }
  const nullableStrings = [
    "lastRequestTime",
    "lastCompactionTime",
    "lastTool",
    "lastUserPromptTime",
    "lastError",
  ] as const;
  for (const k of nullableStrings) {
    if (v[k] !== null && !isString(v[k])) {
      return `${path}.${k}: not string or null`;
    }
  }
  if (!Array.isArray(v.failedMcpServers)) {
    return `${path}.failedMcpServers: not an array`;
  }
  for (let i = 0; i < v.failedMcpServers.length; i++) {
    if (!isString(v.failedMcpServers[i])) {
      return `${path}.failedMcpServers[${i}]: not a string`;
    }
  }
  return null;
}

function validateSession(v: unknown, path: string): string | null {
  if (!isRecord(v)) return `${path}: not an object`;
  if (!isString(v.name)) return `${path}.name: not a string`;
  if (!isString(v.cwd)) return `${path}.cwd: not a string`;
  if (v.worktreePath !== null && !isString(v.worktreePath)) {
    return `${path}.worktreePath: not string or null`;
  }
  if (v.projectGroup !== null && !isString(v.projectGroup)) {
    return `${path}.projectGroup: not string or null`;
  }
  if (!isBoolean(v.pinned)) return `${path}.pinned: not a boolean`;
  if (!isBoolean(v.attention)) return `${path}.attention: not a boolean`;
  if (
    v.permissionMode !== null &&
    v.permissionMode !== "default" &&
    v.permissionMode !== "plan" &&
    v.permissionMode !== "accept-edits"
  ) {
    return `${path}.permissionMode: invalid value`;
  }
  const otelErr = validateOtel(v.otel, `${path}.otel`);
  if (otelErr) return otelErr;
  if (!Array.isArray(v.links)) return `${path}.links: not an array`;
  for (let i = 0; i < v.links.length; i++) {
    const err = validateLink(v.links[i], `${path}.links[${i}]`);
    if (err) return err;
  }
  if (!Array.isArray(v.windows)) return `${path}.windows: not an array`;
  for (let i = 0; i < v.windows.length; i++) {
    const err = validateWindow(v.windows[i], `${path}.windows[${i}]`);
    if (err) return err;
  }
  return null;
}

export function validateSnapshot(input: unknown): ValidationResult {
  if (!isRecord(input)) return { ok: false, error: "root: not an object" };
  if (input.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    return {
      ok: false,
      error: `root.formatVersion: expected ${SNAPSHOT_FORMAT_VERSION}, got ${String(input.formatVersion)}`,
    };
  }
  if (!isString(input.jmuxVersion)) {
    return { ok: false, error: "root.jmuxVersion: not a string" };
  }
  if (!isString(input.capturedAt) || !ISO_RX.test(input.capturedAt)) {
    return { ok: false, error: "root.capturedAt: not an ISO timestamp" };
  }
  if (!isString(input.tmuxSocket)) {
    return { ok: false, error: "root.tmuxSocket: not a string" };
  }
  if (
    input.lastFocusedSession !== null &&
    !isString(input.lastFocusedSession)
  ) {
    return { ok: false, error: "root.lastFocusedSession: not string or null" };
  }
  if (!Array.isArray(input.sessions)) {
    return { ok: false, error: "root.sessions: not an array" };
  }
  for (let i = 0; i < input.sessions.length; i++) {
    const err = validateSession(input.sessions[i], `root.sessions[${i}]`);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, value: input as unknown as SnapshotFile };
}
