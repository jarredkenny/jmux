import { Terminal } from "bun-pty";

export type AttachMode = "createOrAttach" | "strictAttach";

export function buildTmuxPtyArgs(opts: {
  attachMode: AttachMode;
  sessionName?: string;
  socketName?: string;
  configFile?: string;
}): string[] {
  const args: string[] = [];
  if (opts.configFile) {
    args.push("-f", opts.configFile);
  }
  if (opts.socketName) {
    args.push("-L", opts.socketName);
  }
  if (opts.attachMode === "strictAttach") {
    if (!opts.sessionName) {
      throw new Error("strictAttach requires sessionName");
    }
    args.push("attach-session", "-t", opts.sessionName);
  } else {
    args.push("new-session", "-A");
    if (opts.sessionName) {
      args.push("-s", opts.sessionName);
    }
  }
  return args;
}

export interface TmuxPtyOptions {
  sessionName?: string;
  socketName?: string;
  configFile?: string;
  jmuxDir?: string;
  cols: number;
  rows: number;
  attachMode?: AttachMode;
}

export class TmuxPty {
  private pty: Terminal;
  private _pid: number;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];

  constructor(options: TmuxPtyOptions) {
    const args = buildTmuxPtyArgs({
      attachMode: options.attachMode ?? "createOrAttach",
      sessionName: options.sessionName,
      socketName: options.socketName,
      configFile: options.configFile,
    });

    this.pty = new Terminal("tmux", args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        JMUX_DIR: options.jmuxDir || "",
      },
    });

    this._pid = this.pty.pid;

    this.pty.onData((data: string) => {
      for (const listener of this.dataListeners) {
        listener(data);
      }
    });

    this.pty.onExit((event: { exitCode: number }) => {
      for (const listener of this.exitListeners) {
        listener(event.exitCode);
      }
    });
  }

  get pid(): number {
    return this._pid;
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  offData(listener: (data: string) => void): void {
    const idx = this.dataListeners.indexOf(listener);
    if (idx >= 0) this.dataListeners.splice(idx, 1);
  }

  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener);
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  kill(): void {
    this.pty.kill();
  }
}
