import type { SessionOtelState, PermissionMode, ErrorState } from "./types";
import { makeSessionOtelState } from "./types";

function toIso(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  return null;
}

export interface OtelReceiverOptions {
  /**
   * Called once per api_request and tool_result event with the OTLP resource
   * attribute `tmux_session_name`. Used by main.ts to close the
   * WAITING→RUNNING gap when Claude resumes after a permission grant
   * without firing UserPromptSubmit. OtelReceiver itself holds no tmux
   * dependency and does not read state.
   */
  onAgentResumeHint?: (sessionName: string) => void;
}

export class OtelReceiver {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private state = new Map<string, SessionOtelState>();
  onUpdate: ((sessionName: string) => void) | null = null;
  private sessionUpdateListeners: Array<(name: string) => void> = [];
  private readonly onAgentResumeHint: (sessionName: string) => void;

  constructor(opts: OtelReceiverOptions = {}) {
    this.onAgentResumeHint = opts.onAgentResumeHint ?? (() => {});
  }

  onSessionUpdate(fn: (name: string) => void): void {
    this.sessionUpdateListeners.push(fn);
  }

  private emitSessionUpdate(name: string): void {
    for (const fn of this.sessionUpdateListeners) fn(name);
  }

  getSessionSnapshot(name: string): import("./snapshot/schema").SnapshotOtel | null {
    const s = this.state.get(name);
    if (!s) return null;
    return {
      costUsd: s.costUsd,
      cacheWasHit: s.lastRequestTime > 0 ? s.cacheWasHit : null,
      lastRequestTime: toIso(s.lastRequestTime),
      lastCompactionTime: toIso(s.lastCompactionTime),
      lastTool: s.lastTool?.name ?? null,
      lastUserPromptTime: toIso(s.lastUserPromptTime),
      lastError: s.lastError?.type ?? null,
      failedMcpServers: Array.from(s.failedMcpServers),
    };
  }

  /**
   * Overwrite per-session OTEL state from a persisted snapshot.
   * Called during boot to restore state that was captured at shutdown.
   * Timestamps are stored as ISO strings in the snapshot; convert back to epoch ms.
   */
  setSessionSnapshot(name: string, snap: import("./snapshot/schema").SnapshotOtel): void {
    const fromIso = (iso: string | null): number => {
      if (!iso) return 0;
      const t = Date.parse(iso);
      return Number.isFinite(t) ? t : 0;
    };

    const existing = this.state.get(name) ?? makeSessionOtelState();
    existing.costUsd = snap.costUsd;
    existing.cacheWasHit = snap.cacheWasHit ?? false;
    existing.lastRequestTime = fromIso(snap.lastRequestTime);
    existing.lastCompactionTime = snap.lastCompactionTime ? fromIso(snap.lastCompactionTime) : null;
    existing.lastUserPromptTime = snap.lastUserPromptTime ? fromIso(snap.lastUserPromptTime) : null;
    existing.lastTool = snap.lastTool
      ? { name: snap.lastTool, durationMs: 0, success: true, timestamp: 0 }
      : null;
    existing.lastError = snap.lastError
      ? { type: snap.lastError as ErrorState["type"], timestamp: 0 }
      : null;
    existing.failedMcpServers = new Set(snap.failedMcpServers);
    this.state.set(name, existing);
    this.emitSessionUpdate(name);
  }

  /**
   * Set the permission mode for a session from a persisted snapshot.
   * A null mode (unknown at snapshot time) is treated as "default".
   */
  setPermissionMode(name: string, mode: import("./snapshot/schema").SnapshotPermissionMode): void {
    const normalized: PermissionMode =
      mode === "plan" || mode === "accept-edits" ? mode : "default";
    const existing = this.state.get(name) ?? makeSessionOtelState();
    existing.permissionMode = normalized;
    this.state.set(name, existing);
    this.emitSessionUpdate(name);
  }

  async start(): Promise<number> {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.handleRequest(req),
    });
    return this.server.port!;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  getSessionState(key: string): SessionOtelState | null {
    return this.state.get(key) ?? null;
  }

  getActiveSessionIds(): string[] {
    return [...this.state.keys()];
  }

  pruneExcept(activeKeys: string[]): void {
    const active = new Set(activeKeys);
    for (const id of this.state.keys()) {
      if (!active.has(id)) this.state.delete(id);
    }
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/logs") {
      try {
        const body = await req.json();
        this.processLogs(body);
      } catch {
        // malformed JSON — ignore silently
      }
    }
    return new Response("", { status: 200 });
  }

  private processLogs(body: any): void {
    const resourceLogs = body?.resourceLogs;
    if (!Array.isArray(resourceLogs)) return;

    for (const rl of resourceLogs) {
      const sessionName = this.extractResourceAttr(rl?.resource, "tmux_session_name");
      if (!sessionName) continue;

      const scopeLogs = rl?.scopeLogs;
      if (!Array.isArray(scopeLogs)) continue;

      for (const sl of scopeLogs) {
        const logRecords = sl?.logRecords;
        if (!Array.isArray(logRecords)) continue;

        for (const record of logRecords) {
          this.processRecord(record, sessionName);
        }
      }
    }
  }

  private processRecord(record: any, sessionName: string): void {
    const attrs = record?.attributes;
    if (!Array.isArray(attrs)) return;

    const eventName = this.findAttrString(attrs, "event.name");
    if (!eventName) return;

    if (eventName === "api_request") {
      const cacheReadTokens = this.findAttrNumber(attrs, "cache_read_tokens");
      const cost = this.findAttrDouble(attrs, "cost_usd");

      const existing = this.state.get(sessionName) ?? makeSessionOtelState();
      existing.lastRequestTime = Date.now();
      existing.cacheWasHit = cacheReadTokens > 0;
      existing.lastError = null;
      if (cost !== null) existing.costUsd += cost;
      this.state.set(sessionName, existing);

      this.onUpdate?.(sessionName);
      this.emitSessionUpdate(sessionName);
      this.onAgentResumeHint(sessionName);
      return;
    }

    if (eventName === "api_error" || eventName === "api_retries_exhausted") {
      const existing = this.state.get(sessionName) ?? makeSessionOtelState();
      existing.lastError = {
        type: eventName,
        timestamp: Date.now(),
      };
      this.state.set(sessionName, existing);
      this.onUpdate?.(sessionName);
      this.emitSessionUpdate(sessionName);
      return;
    }

    if (eventName === "user_prompt") {
      const existing = this.state.get(sessionName) ?? makeSessionOtelState();
      existing.lastUserPromptTime = Date.now();
      this.state.set(sessionName, existing);
      this.onUpdate?.(sessionName);
      this.emitSessionUpdate(sessionName);
      return;
    }

    if (eventName === "compaction") {
      const existing = this.state.get(sessionName) ?? makeSessionOtelState();
      existing.lastCompactionTime = Date.now();
      this.state.set(sessionName, existing);
      this.onUpdate?.(sessionName);
      this.emitSessionUpdate(sessionName);
      return;
    }

    if (eventName === "permission_mode_changed") {
      const mode = this.findAttrString(attrs, "mode");
      if (mode === null) return;
      const normalized: PermissionMode =
        mode === "plan" || mode === "accept-edits" ? mode : "default";

      const existing = this.state.get(sessionName) ?? makeSessionOtelState();
      existing.permissionMode = normalized;
      this.state.set(sessionName, existing);
      this.onUpdate?.(sessionName);
      this.emitSessionUpdate(sessionName);
      return;
    }

    if (eventName === "mcp_server_connection") {
      const serverName = this.findAttrString(attrs, "server_name");
      if (!serverName) return;
      const connState = this.findAttrString(attrs, "state");

      const existing = this.state.get(sessionName) ?? makeSessionOtelState();
      if (connState === "connected") {
        existing.failedMcpServers.delete(serverName);
      } else if (connState === "failed" || connState === "disconnected") {
        existing.failedMcpServers.add(serverName);
      } else {
        return;
      }
      this.state.set(sessionName, existing);
      this.onUpdate?.(sessionName);
      this.emitSessionUpdate(sessionName);
      return;
    }

    if (eventName === "tool_result") {
      const toolName = this.findAttrString(attrs, "tool_name");
      if (!toolName) return;
      const durationMs = this.findAttrNumber(attrs, "duration_ms");
      const success = this.findAttrBool(attrs, "success");

      const existing = this.state.get(sessionName) ?? makeSessionOtelState();
      existing.lastTool = {
        name: toolName,
        durationMs,
        success: success !== false,
        timestamp: Date.now(),
      };
      this.state.set(sessionName, existing);
      this.onUpdate?.(sessionName);
      this.emitSessionUpdate(sessionName);
      this.onAgentResumeHint(sessionName);
      return;
    }
  }

  private extractResourceAttr(resource: any, key: string): string | null {
    const attrs = resource?.attributes;
    if (!Array.isArray(attrs)) return null;
    return this.findAttrString(attrs, key);
  }

  private findAttrString(attrs: any[], key: string): string | null {
    for (const attr of attrs) {
      if (attr?.key === key) return attr?.value?.stringValue ?? null;
    }
    return null;
  }

  private findAttrNumber(attrs: any[], key: string): number {
    for (const attr of attrs) {
      if (attr?.key === key) {
        const v = attr?.value;
        if (!v) return 0;
        // OTLP sends numbers as intValue or stringValue depending on the exporter
        if (v.intValue !== undefined) {
          return typeof v.intValue === "number" ? v.intValue : parseInt(v.intValue, 10) || 0;
        }
        if (v.stringValue !== undefined) {
          return parseInt(v.stringValue, 10) || 0;
        }
        return 0;
      }
    }
    return 0;
  }

  private findAttrBool(attrs: any[], key: string): boolean | null {
    for (const attr of attrs) {
      if (attr?.key === key) {
        const v = attr?.value;
        if (!v) return null;
        if (v.boolValue !== undefined) return Boolean(v.boolValue);
        if (v.stringValue !== undefined) return v.stringValue === "true";
        return null;
      }
    }
    return null;
  }

  private findAttrDouble(attrs: any[], key: string): number | null {
    for (const attr of attrs) {
      if (attr?.key === key) {
        const v = attr?.value;
        if (!v) return null;
        if (v.doubleValue !== undefined) {
          return typeof v.doubleValue === "number" ? v.doubleValue : parseFloat(v.doubleValue);
        }
        if (v.intValue !== undefined) {
          return typeof v.intValue === "number" ? v.intValue : parseFloat(v.intValue);
        }
        if (v.stringValue !== undefined) {
          const parsed = parseFloat(v.stringValue);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      }
    }
    return null;
  }
}
