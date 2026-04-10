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

/**
 * Build the argument array for a tmux command, prepending socket flags if needed.
 * If socket contains a '/' it's treated as a path (-S), otherwise as a name (-L).
 */
export function buildTmuxArgs(command: string, socket: string | null): string[] {
  const socketArgs: string[] = socket
    ? socket.includes("/")
      ? ["-S", socket]
      : ["-L", socket]
    : [];
  return [...socketArgs, command];
}

export interface TmuxResult {
  ok: boolean;
  lines: string[];
  error: string;
}

/**
 * Run a tmux command synchronously and return structured output.
 *
 * The command is passed through `sh -c` so that quoted format strings like
 * `list-sessions -F '#{session_name}'` are handled correctly by the shell
 * before being forwarded to tmux.
 */
/**
 * Run a tmux command synchronously with a pre-built argument array.
 * Unlike runTmux, this bypasses `sh -c` — safe for arguments that may contain
 * shell-special characters (e.g. arbitrary text for send-keys).
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
      error: stderr || `tmux exited with code ${exitCode}`,
    };
  }

  const lines = result.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return { ok: true, lines, error: "" };
}

export function runTmux(command: string, socket: string | null): TmuxResult {
  const socketPrefix = socket
    ? socket.includes("/")
      ? `-S ${socket}`
      : `-L ${socket}`
    : "";
  const shellCmd = socketPrefix ? `tmux ${socketPrefix} ${command}` : `tmux ${command}`;

  const result = Bun.spawnSync(["sh", "-c", shellCmd], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = result.exitCode ?? 1;

  if (exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    return {
      ok: false,
      lines: [],
      error: stderr || `tmux exited with code ${exitCode}`,
    };
  }

  const lines = result.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return { ok: true, lines, error: "" };
}
