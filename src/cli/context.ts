import { parseTmuxSocket, runTmuxDirect, type TmuxResult } from "./tmux";

export interface CliFlags {
  socket?: string;
  session?: string;
}

export interface CliContext {
  socket: string | null;
  paneId: string | null;
  sessionOverride: string | null;
  insideTmux: boolean;
  insideJmux: boolean;
}

interface ResolveInput {
  env: Record<string, string | undefined>;
  flags: CliFlags;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Run a tmux command and return the output lines, or throw CliError on failure.
 */
export function tmuxOrThrow(result: TmuxResult): string[] {
  if (!result.ok) {
    throw new CliError(result.error);
  }
  return result.lines;
}

// Pure function — testable without tmux
export function resolveContext(input: ResolveInput): CliContext {
  const { env, flags } = input;
  const socket = flags.socket ?? parseTmuxSocket(env.TMUX) ?? null;
  const paneId = env.TMUX_PANE ?? null;
  const insideTmux = !!env.TMUX;
  const insideJmux = env.JMUX === "1";
  const sessionOverride = flags.session ?? null;

  return { socket, paneId, sessionOverride, insideTmux, insideJmux };
}

// Requires live tmux server — resolves session name from $TMUX_PANE
export function resolveCurrentSession(ctx: CliContext): string | null {
  if (ctx.sessionOverride) return ctx.sessionOverride;
  if (!ctx.paneId) return null;

  const result = runTmuxDirect(
    ["display-message", "-t", ctx.paneId, "-p", "#{session_name}"],
    ctx.socket,
  );

  if (!result.ok || result.lines.length === 0) return null;
  return result.lines[0];
}

// Convenience — resolves or throws CliError
export function requireSession(ctx: CliContext): string {
  const session = resolveCurrentSession(ctx);
  if (!session) {
    throw new CliError(
      "Could not determine current tmux session. Use --session to specify one.",
    );
  }
  return session;
}
