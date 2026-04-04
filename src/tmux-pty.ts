import { Terminal } from "bun-pty";

export interface TmuxPtyOptions {
  sessionName?: string;
  socketName?: string;
  configFile?: string;
  jmuxDir?: string;
  cols: number;
  rows: number;
}

export class TmuxPty {
  private pty: Terminal;
  private _pid: number;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];

  constructor(options: TmuxPtyOptions) {
    const args: string[] = [];
    if (options.configFile) {
      args.push("-f", options.configFile);
    }
    if (options.socketName) {
      args.push("-L", options.socketName);
    }
    args.push("new-session", "-A");
    if (options.sessionName) {
      args.push("-s", options.sessionName);
    }

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
