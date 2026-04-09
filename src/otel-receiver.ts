import type { CacheTimerState } from "./types";

export class OtelReceiver {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private state = new Map<string, CacheTimerState>();
  onUpdate: ((sessionId: string) => void) | null = null;

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

  getTimerState(sessionId: string): CacheTimerState | null {
    return this.state.get(sessionId) ?? null;
  }

  getActiveSessionIds(): string[] {
    return [...this.state.keys()];
  }

  pruneExcept(activeSessionIds: string[]): void {
    const active = new Set(activeSessionIds);
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
      const sessionId = this.extractResourceAttr(rl?.resource, "tmux_session_id");
      if (!sessionId) continue;

      const scopeLogs = rl?.scopeLogs;
      if (!Array.isArray(scopeLogs)) continue;

      for (const sl of scopeLogs) {
        const logRecords = sl?.logRecords;
        if (!Array.isArray(logRecords)) continue;

        for (const record of logRecords) {
          this.processRecord(record, sessionId);
        }
      }
    }
  }

  private processRecord(record: any, sessionId: string): void {
    const attrs = record?.attributes;
    if (!Array.isArray(attrs)) return;

    const eventName = this.findAttrString(attrs, "event.name");
    if (eventName !== "api_request") return;

    const cacheReadTokens = this.findAttrInt(attrs, "cache_read_tokens");
    const cacheWasHit = cacheReadTokens > 0;

    this.state.set(sessionId, {
      lastRequestTime: Date.now(),
      cacheWasHit,
    });

    this.onUpdate?.(sessionId);
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

  private findAttrInt(attrs: any[], key: string): number {
    for (const attr of attrs) {
      if (attr?.key === key) {
        const v = attr?.value?.intValue;
        return typeof v === "number" ? v : parseInt(v, 10) || 0;
      }
    }
    return 0;
  }
}
