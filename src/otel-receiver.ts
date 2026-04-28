import type { SessionOtelState } from "./types";
import { makeSessionOtelState } from "./types";

export class OtelReceiver {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private state = new Map<string, SessionOtelState>();
  onUpdate: ((sessionName: string) => void) | null = null;

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

  /** @deprecated alias kept for one task — removed in Task 9 */
  getTimerState(key: string): SessionOtelState | null {
    return this.getSessionState(key);
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
