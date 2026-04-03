import type { Subprocess } from "bun";

// --- Protocol Parser (unit-testable) ---

export type ControlEvent =
  | { type: "sessions-changed" }
  | { type: "session-changed"; args: string }
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
      lines: string[];
    }
  | {
      type: "error";
      commandNumber: number;
      lines: string[];
    };

type EventListener = (event: ControlEvent) => void;

export class ControlParser {
  private buffer = "";
  private listeners: EventListener[] = [];
  private inBlock = false;
  private blockCommandNumber = 0;
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
        const parts = line.split(" ");
        const cmdNum = parseInt(parts[2], 10);
        this.inBlock = false;
        this.emit({
          type: isError ? "error" : "response",
          commandNumber: cmdNum,
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
  }

  private emit(event: ControlEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

// --- Control Client (subprocess management) ---

export class TmuxControl {
  private proc: Subprocess | null = null;
  private parser = new ControlParser();
  private commandCounter = 0;
  private pendingCommands = new Map<
    number,
    {
      resolve: (lines: string[]) => void;
      reject: (err: Error) => void;
    }
  >();
  private writer: WritableStreamDefaultWriter | null = null;

  constructor() {
    this.parser.onEvent((event) => {
      if (event.type === "response" || event.type === "error") {
        const pending = this.pendingCommands.get(event.commandNumber);
        if (pending) {
          this.pendingCommands.delete(event.commandNumber);
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

  async start(): Promise<void> {
    this.proc = Bun.spawn(["tmux", "-C", "attach"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });

    this.writer = this.proc.stdin!.getWriter();

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
    if (!this.writer) throw new Error("TmuxControl not started");
    const cmdNum = this.commandCounter++;
    const promise = new Promise<string[]>((resolve, reject) => {
      this.pendingCommands.set(cmdNum, { resolve, reject });
    });
    const encoded = new TextEncoder().encode(cmd + "\n");
    await this.writer.write(encoded);
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
    if (this.writer) {
      try {
        await this.writer.close();
      } catch {
        // Already closed
      }
    }
    this.proc?.kill();
    this.proc = null;
  }
}
