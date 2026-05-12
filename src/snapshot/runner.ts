import type { TmuxRunner, TmuxRunResult } from "./deps";

export class ProductionTmuxRunner implements TmuxRunner {
  constructor(private readonly socketName: string | null = null) {}

  async run(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<TmuxRunResult> {
    const full = this.socketName ? ["-L", this.socketName, ...args] : args;
    const proc = Bun.spawn(["tmux", ...full], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const killer = setTimeout(() => {
      proc.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(killer);
    }
  }
}
