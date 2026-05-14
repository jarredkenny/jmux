import type { Clock } from "./snapshot/deps";
import { ProductionClock } from "./snapshot/clock";

// --- Protocol Parser (unit-testable) ---

export type ControlEvent =
  | { type: "sessions-changed" }
  | { type: "session-changed"; args: string }
  | { type: "session-renamed"; args: string }
  | { type: "window-renamed"; args: string }
  | { type: "window-add"; args: string }
  | { type: "window-close"; args: string }
  | { type: "session-window-changed"; args: string }
  | { type: "client-session-changed"; args: string }
  | {
      type: "subscription-changed";
      name: string;
      value: string;
    }
  | {
      type: "response";
      commandNumber: number;
      flags: number;
      lines: string[];
    }
  | {
      type: "error";
      commandNumber: number;
      flags: number;
      lines: string[];
    };

type EventListener = (event: ControlEvent) => void;

export class ControlParser {
  private buffer = "";
  private listeners: EventListener[] = [];
  private inBlock = false;
  private blockCommandNumber = 0;
  private blockFlags = 0;
  private blockLines: string[] = [];

  onEvent(listener: EventListener): void {
    this.listeners.push(listener);
  }

  feed(data: string): void {
    this.buffer += data;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    if (this.inBlock) {
      if (line.startsWith("%end ") || line.startsWith("%error ")) {
        const isError = line.startsWith("%error ");
        this.inBlock = false;
        this.emit({
          type: isError ? "error" : "response",
          commandNumber: this.blockCommandNumber,
          flags: this.blockFlags,
          lines: this.blockLines,
        });
        this.blockLines = [];
      } else {
        this.blockLines.push(line);
      }
      return;
    }

    if (line.startsWith("%begin ")) {
      const parts = line.split(" ");
      this.blockCommandNumber = parseInt(parts[2], 10);
      this.blockFlags = parseInt(parts[3], 10) || 0;
      this.inBlock = true;
      this.blockLines = [];
      return;
    }

    if (line === "%sessions-changed") {
      this.emit({ type: "sessions-changed" });
    } else if (line.startsWith("%session-changed ")) {
      this.emit({
        type: "session-changed",
        args: line.slice("%session-changed ".length),
      });
    } else if (line.startsWith("%session-renamed ")) {
      this.emit({
        type: "session-renamed",
        args: line.slice("%session-renamed ".length),
      });
    } else if (line.startsWith("%window-renamed ")) {
      this.emit({
        type: "window-renamed",
        args: line.slice("%window-renamed ".length),
      });
    } else if (line.startsWith("%window-add ") || line.startsWith("%unlinked-window-add ")) {
      this.emit({
        type: "window-add",
        args: line.includes("unlinked") ? line.slice("%unlinked-window-add ".length) : line.slice("%window-add ".length),
      });
    } else if (line.startsWith("%window-close ") || line.startsWith("%unlinked-window-close ")) {
      this.emit({
        type: "window-close",
        args: line.includes("%unlinked-window-close ")
          ? line.slice("%unlinked-window-close ".length)
          : line.slice("%window-close ".length),
      });
    } else if (line.startsWith("%session-window-changed ")) {
      this.emit({
        type: "session-window-changed",
        args: line.slice("%session-window-changed ".length),
      });
    } else if (line.startsWith("%client-session-changed ")) {
      this.emit({
        type: "client-session-changed",
        args: line.slice("%client-session-changed ".length),
      });
    } else if (line.startsWith("%subscription-changed ")) {
      const rest = line.slice("%subscription-changed ".length);
      const spaceIdx = rest.indexOf(" ");
      if (spaceIdx === -1) {
        this.emit({
          type: "subscription-changed",
          name: rest,
          value: "",
        });
      } else {
        this.emit({
          type: "subscription-changed",
          name: rest.slice(0, spaceIdx),
          value: rest.slice(spaceIdx + 1),
        });
      }
    }
    // Ignore unknown % lines (e.g. %output if not suppressed)
  }

  private emit(event: ControlEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

// --- Spawn injection seam ---

export interface ControlProcess {
  onData(fn: (data: string) => void): void;
  onExit(fn: (code: number) => void): void;
  write(data: string): void;
  kill(): void;
}

export interface ControlSpawner {
  spawn(): ControlProcess;
}

export interface TmuxControlOptions {
  socketName?: string;
  configFile?: string;
  spawner?: ControlSpawner;
  clock?: Clock;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  reconnectGiveUpMs?: number;
}

// --- Control Client (subprocess management) ---

export class TmuxControl {
  private parser = new ControlParser();
  // FIFO queue — tmux command numbers are global server counters,
  // not sequential from 0. We match responses in order instead.
  private pendingQueue: Array<{
    resolve: (lines: string[]) => void;
    reject: (err: Error) => void;
  }> = [];

  private readonly spawner: ControlSpawner;
  private readonly clock: Clock;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly reconnectGiveUpMs: number;
  private currentProcess: ControlProcess | null = null;
  private reconnectedListeners: Array<() => void> = [];
  private lostListeners: Array<() => void> = [];
  private currentBackoff = 0;
  private firstFailureAt: number | null = null;
  private reconnectTimerCancel: (() => void) | null = null;
  private cooldownTimerCancel: (() => void) | null = null;
  private isLost = false;

  // Options set at construction time; start() may override socketName/configFile
  private socketName: string | undefined;
  private configFile: string | undefined;

  constructor(arg?: string | TmuxControlOptions) {
    const opts: TmuxControlOptions =
      arg === undefined
        ? {}
        : typeof arg === "string"
          ? { socketName: arg }
          : arg;

    this.socketName = opts.socketName;
    this.configFile = opts.configFile;
    this.spawner = opts.spawner ?? this.makeDefaultSpawner();
    this.clock = opts.clock ?? this.makeDefaultClock();
    this.reconnectInitialMs = opts.reconnectInitialMs ?? 250;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 5000;
    this.reconnectGiveUpMs = opts.reconnectGiveUpMs ?? 30000;

    this.parser.onEvent((event) => {
      if (event.type === "response" || event.type === "error") {
        // flags=1 means this response is for a command sent by THIS client.
        // flags=0 means it's from the initial attach or another client — skip it.
        if (event.flags !== 1) return;

        const pending = this.pendingQueue.shift();
        if (pending) {
          if (event.type === "error") {
            pending.reject(new Error(event.lines.join("\n")));
          } else {
            pending.resolve(event.lines);
          }
        }
      }
    });
  }

  onEvent(listener: EventListener): void {
    this.parser.onEvent(listener);
  }

  onReconnected(fn: () => void): void {
    this.reconnectedListeners.push(fn);
  }

  onLost(fn: () => void): void {
    this.lostListeners.push(fn);
  }

  async start(opts?: { socketName?: string; configFile?: string }): Promise<void> {
    // Allow start() to override or supply socketName/configFile
    if (opts?.socketName !== undefined) this.socketName = opts.socketName;
    if (opts?.configFile !== undefined) this.configFile = opts.configFile;
    this.attach();
  }

  private attach(): void {
    if (this.isLost) return;
    // Cancel any prior cooldown timer before spawning a new connection.
    this.cooldownTimerCancel?.();
    const proc = this.spawner.spawn();
    this.currentProcess = proc;
    proc.onData((s) => this.parser.feed(s));
    proc.onExit(() => this.handleExit());

    // Suppress %output notifications so they don't flood the parser.
    // Fire-and-forget — we don't need to wait for the response.
    this.sendCommand("refresh-client -f no-output").catch(() => {});

    // Reset backoff if the connection survives a full cooldown period
    this.cooldownTimerCancel = this.clock.setTimeout(() => {
      this.cooldownTimerCancel = null;
      if (this.currentProcess === proc) {
        this.currentBackoff = 0;
        this.firstFailureAt = null;
      }
    }, this.reconnectMaxMs);
  }

  private handleExit(): void {
    this.currentProcess = null;
    // Drain any commands that were pending when the connection dropped.
    // Their callers used .catch(() => {}) or will see a rejection; either way
    // we must not let stale entries block future responses on reconnect.
    const drained = this.pendingQueue.splice(0);
    for (const { reject } of drained) {
      reject(new Error("TmuxControl: connection lost"));
    }

    const now = this.clock.now();
    if (this.firstFailureAt === null) this.firstFailureAt = now;
    if (now - this.firstFailureAt > this.reconnectGiveUpMs) {
      this.isLost = true;
      for (const fn of this.lostListeners) fn();
      return;
    }
    const wait =
      this.currentBackoff === 0
        ? this.reconnectInitialMs
        : Math.min(this.currentBackoff * 2, this.reconnectMaxMs);
    this.currentBackoff = wait;
    this.reconnectTimerCancel = this.clock.setTimeout(() => {
      this.reconnectTimerCancel = null;
      this.attach();
      for (const fn of this.reconnectedListeners) fn();
    }, wait);
  }

  private makeDefaultSpawner(): ControlSpawner {
    return {
      spawn: () => this.spawnProduction(),
    };
  }

  private makeDefaultClock(): Clock {
    return new ProductionClock();
  }

  private spawnProduction(): ControlProcess {
    const args = ["tmux"];
    if (this.configFile) args.push("-f", this.configFile);
    if (this.socketName) args.push("-L", this.socketName);
    args.push("-C", "attach");

    const proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });

    const dataListeners: Array<(s: string) => void> = [];
    const exitListeners: Array<(code: number) => void> = [];

    // Read stdout in background
    (async () => {
      if (!proc.stdout) return;
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const fn of dataListeners) fn(text);
        }
      } catch {
        // Process exited
      }
      const code = await proc.exited;
      for (const fn of exitListeners) fn(code);
    })();

    return {
      onData(fn: (s: string) => void): void {
        dataListeners.push(fn);
      },
      onExit(fn: (code: number) => void): void {
        exitListeners.push(fn);
      },
      write(data: string): void {
        if (proc.stdin) {
          proc.stdin.write(data);
          proc.stdin.flush();
        }
      },
      kill(): void {
        try {
          proc.stdin?.end();
        } catch {
          // Already closed
        }
        proc.kill();
      },
    };
  }

  async sendCommand(cmd: string): Promise<string[]> {
    if (!this.currentProcess) throw new Error("TmuxControl not started");
    const promise = new Promise<string[]>((resolve, reject) => {
      this.pendingQueue.push({ resolve, reject });
    });
    this.currentProcess.write(cmd + "\n");
    return promise;
  }

  async registerSubscription(
    name: string,
    interval: number,
    format: string,
  ): Promise<void> {
    await this.sendCommand(
      `refresh-client -B "${name}:${interval}:${format}"`,
    );
  }

  async close(): Promise<void> {
    this.reconnectTimerCancel?.();
    this.reconnectTimerCancel = null;
    this.cooldownTimerCancel?.();
    this.cooldownTimerCancel = null;
    this.isLost = true; // Prevent reconnect after explicit close
    this.currentProcess?.kill();
    this.currentProcess = null;
  }
}
