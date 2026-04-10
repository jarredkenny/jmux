/**
 * Thin wrapper around Bun.spawnSync for running tmux commands with the
 * correct socket flags and returning structured output.
 */

/**
 * Parse the socket path from the $TMUX environment variable.
 * Format: /path/to/socket,PID,INDEX
 */
export function parseTmuxSocket(tmuxEnv: string | undefined): string | null {
  if (!tmuxEnv) return null;
  const comma = tmuxEnv.indexOf(",");
  if (comma === -1) return null;
  const path = tmuxEnv.slice(0, comma);
  return path || null;
}

export interface TmuxResult {
  ok: boolean;
  /** Trimmed, non-empty lines — suitable for structured format-string output. */
  lines: string[];
  /** Unprocessed stdout — preserves blank lines and indentation (for capture-pane). */
  rawOutput: string;
  error: string;
}

/**
 * Run a tmux command synchronously with a pre-built argument array.
 * Bypasses `sh -c` — arguments are passed directly to tmux via execvp,
 * eliminating shell injection risk from user-controlled values.
 */
export function runTmuxDirect(args: string[], socket: string | null): TmuxResult {
  const socketArgs: string[] = socket
    ? socket.includes("/")
      ? ["-S", socket]
      : ["-L", socket]
    : [];

  const result = Bun.spawnSync(["tmux", ...socketArgs, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = result.exitCode ?? 1;

  if (exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    return {
      ok: false,
      lines: [],
      rawOutput: "",
      error: stderr || `tmux exited with code ${exitCode}`,
    };
  }

  const rawOutput = result.stdout.toString();
  const lines = rawOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return { ok: true, lines, rawOutput, error: "" };
}
