import { resolveSessionContext } from "./context-resolver";
import type {
  CodeHostAdapter,
  IssueTrackerAdapter,
  SessionContext,
  BranchContext,
} from "./types";
import { getGitBranch } from "./context-resolver";

const ACTIVE_INTERVAL_MS = 20_000;
const BACKGROUND_INTERVAL_MS = 180_000;
const RATE_LIMITED_ACTIVE_MS = 60_000;

export type RateLimitState = "normal" | "rate_limited" | "hard_limited";

export interface PollCoordinatorOptions {
  codeHost: CodeHostAdapter | null;
  issueTracker: IssueTrackerAdapter | null;
  onUpdate: (sessionName: string) => void;
  getSessionDir: (sessionName: string) => string | null;
}

export class PollCoordinator {
  private opts: PollCoordinatorOptions;
  private contexts = new Map<string, SessionContext>();
  private sessionDirs = new Map<string, string>();
  private activeSession: string | null = null;
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private _rateLimitState: RateLimitState = "normal";

  get rateLimitState(): RateLimitState {
    return this._rateLimitState;
  }

  get codeHost(): CodeHostAdapter | null {
    return this.opts.codeHost;
  }

  get issueTracker(): IssueTrackerAdapter | null {
    return this.opts.issueTracker;
  }

  constructor(opts: PollCoordinatorOptions) {
    this.opts = opts;
  }

  start(): void {
    this.startActivePolling();
    this.startBackgroundPolling();
  }

  stop(): void {
    if (this.activeTimer) {
      clearInterval(this.activeTimer);
      this.activeTimer = null;
    }
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  addSession(name: string, dir: string): void {
    this.sessionDirs.set(name, dir);
  }

  removeSession(name: string): void {
    this.sessionDirs.delete(name);
    this.contexts.delete(name);
  }

  async setActiveSession(name: string): Promise<void> {
    this.activeSession = name;
    if (!this.contexts.has(name)) {
      await this.resolveContext(name);
    }
  }

  getContext(session: string): SessionContext | null {
    return this.contexts.get(session) ?? null;
  }

  getAllContexts(): Map<string, SessionContext> {
    return this.contexts;
  }

  reportRateLimit(state: RateLimitState): void {
    this._rateLimitState = state;
    this.stop();
    if (state !== "hard_limited") {
      this.start();
    }
  }

  reportAuthFailure(adapterKey: "codeHost" | "issueTracker"): void {
    const adapter = this.opts[adapterKey];
    if (adapter) {
      adapter.authState = "failed";
    }
  }

  private async resolveContext(name: string): Promise<void> {
    const dir = this.sessionDirs.get(name);
    if (!dir) return;
    const ctx = await resolveSessionContext({
      sessionName: name,
      dir,
      codeHost: this.opts.codeHost,
      issueTracker: this.opts.issueTracker,
    });
    this.contexts.set(name, ctx);
    this.opts.onUpdate(name);
  }

  private async pollActiveSession(): Promise<void> {
    if (!this.activeSession || this._rateLimitState === "hard_limited") return;
    const name = this.activeSession;
    const ctx = this.contexts.get(name);
    if (!ctx) {
      await this.resolveContext(name);
      return;
    }

    const dir = this.sessionDirs.get(name);
    if (dir) {
      const currentBranch = await getGitBranch(dir);
      if (currentBranch !== ctx.branch) {
        await this.resolveContext(name);
        return;
      }
    }

    const { codeHost, issueTracker } = this.opts;
    let changed = false;

    if (ctx.mr && codeHost && codeHost.authState === "ok") {
      try {
        const updated = await codeHost.pollMergeRequest(ctx.mr.id);
        ctx.mr = updated;
        changed = true;
      } catch (e: any) {
        if (e?.status === 401 || e?.status === 403) {
          this.reportAuthFailure("codeHost");
        } else if (e?.status === 429) {
          this.reportRateLimit("rate_limited");
        }
      }
    }

    if (ctx.issue && issueTracker && issueTracker.authState === "ok") {
      try {
        const updated = await issueTracker.pollIssue(ctx.issue.id);
        ctx.issue = updated;
        changed = true;
      } catch (e: any) {
        if (e?.status === 401 || e?.status === 403) {
          this.reportAuthFailure("issueTracker");
        } else if (e?.status === 429) {
          this.reportRateLimit("rate_limited");
        }
      }
    }

    if (changed) {
      ctx.resolvedAt = Date.now();
      this.opts.onUpdate(name);
    }
  }

  private async pollBackgroundSessions(): Promise<void> {
    if (this._rateLimitState !== "normal") return;
    const { codeHost, issueTracker } = this.opts;
    const branchContexts: BranchContext[] = [];
    const issueIds: string[] = [];
    const issueSessionMap = new Map<string, string>();

    for (const [name, ctx] of this.contexts) {
      if (name === this.activeSession) continue;
      if (ctx.branch && ctx.remote) {
        branchContexts.push({ sessionName: name, remote: ctx.remote, branch: ctx.branch });
      }
      if (ctx.issue) {
        issueIds.push(ctx.issue.id);
        issueSessionMap.set(ctx.issue.id, name);
      }
    }

    if (branchContexts.length > 0 && codeHost && codeHost.authState === "ok") {
      try {
        const results = await codeHost.pollAllMergeRequests(branchContexts);
        for (const [sessionName, mr] of results) {
          const ctx = this.contexts.get(sessionName);
          if (ctx) {
            ctx.mr = mr;
            ctx.resolvedAt = Date.now();
            this.opts.onUpdate(sessionName);
          }
        }
      } catch (e: any) {
        if (e?.status === 429) this.reportRateLimit("rate_limited");
      }
    }

    if (issueIds.length > 0 && issueTracker && issueTracker.authState === "ok") {
      try {
        const results = await issueTracker.pollAllIssues(issueIds);
        for (const [issueId, issue] of results) {
          const sessionName = issueSessionMap.get(issueId);
          if (sessionName) {
            const ctx = this.contexts.get(sessionName);
            if (ctx) {
              ctx.issue = issue;
              ctx.resolvedAt = Date.now();
              this.opts.onUpdate(sessionName);
            }
          }
        }
      } catch (e: any) {
        if (e?.status === 429) this.reportRateLimit("rate_limited");
      }
    }
  }

  private startActivePolling(): void {
    const interval =
      this._rateLimitState === "rate_limited" ? RATE_LIMITED_ACTIVE_MS : ACTIVE_INTERVAL_MS;
    this.activeTimer = setInterval(() => this.pollActiveSession(), interval);
  }

  private startBackgroundPolling(): void {
    if (this._rateLimitState !== "normal") return;
    this.backgroundTimer = setInterval(
      () => this.pollBackgroundSessions(),
      BACKGROUND_INTERVAL_MS,
    );
  }
}
