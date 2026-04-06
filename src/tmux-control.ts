import type { Subprocess } from "bun";

// --- Protocol Parser (unit-testable) ---

export type ControlEvent =
  | { type: "sessions-changed" }
  | { type: "session-changed"; args: string }
  | { type: "session-renamed"; args: string }
  | { type: "window-renamed"; args: string }
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

// --- Control Client (subprocess management) ---

export class TmuxControl {
  private proc: Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private parser = new ControlParser();
  // FIFO queue — tmux command numbers are global server counters,
  // not sequential from 0. We match responses in order instead.
  private pendingQueue: Array<{
    resolve: (lines: string[]) => void;
    reject: (err: Error) => void;
  }> = [];

  constructor() {
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

  async start(opts?: { socketName?: string; configFile?: string }): Promise<void> {
    const args = ["tmux"];
    if (opts?.configFile) args.push("-f", opts.configFile);
    if (opts?.socketName) args.push("-L", opts.socketName);
    args.push("-C", "attach");
    this.proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });

    // Read stdout in background
    this.readOutput();

    // Suppress %output notifications
    await this.sendCommand("refresh-client -f no-output");
  }

  private async readOutput(): Promise<void> {
    if (!this.proc?.stdout) return;
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Process exited
    }
  }

  async sendCommand(cmd: string): Promise<string[]> {
    if (!this.proc?.stdin) throw new Error("TmuxControl not started");
    const promise = new Promise<string[]>((resolve, reject) => {
      this.pendingQueue.push({ resolve, reject });
    });
    // Bun.spawn with stdin:"pipe" gives a FileSink, not a WritableStream
    this.proc.stdin.write(cmd + "\n");
    this.proc.stdin.flush();
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
    if (this.proc?.stdin) {
      try {
        this.proc.stdin.end();
      } catch {
        // Already closed
      }
    }
    this.proc?.kill();
    this.proc = null;
  }
}
