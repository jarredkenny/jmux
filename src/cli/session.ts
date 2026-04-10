import { sanitizeTmuxSessionName, buildOtelResourceAttrs } from "../config";
import { runTmuxDirect, type TmuxResult } from "./tmux";
import { resolveCurrentSession, CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

export interface SessionEntry {
  id: string;
  name: string;
  activity: number;
  attached: boolean;
  windows: number;
  attention: boolean;
  path: string;
}

function tmuxOrThrow(result: TmuxResult): string[] {
  if (!result.ok) {
    throw new CliError(result.error);
  }
  return result.lines;
}

export function parseSessionListOutput(lines: string[]): SessionEntry[] {
  return lines
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.split(":");
      // Format: id:name:activity:attached:windows:attention:path...
      // path may contain colons, so rejoin everything from index 6 onward
      const id = parts[0];
      const name = parts[1];
      const activity = parseInt(parts[2], 10);
      const attached = parts[3] === "1";
      const windows = parseInt(parts[4], 10);
      const attention = parts[5] === "1";
      const path = parts.slice(6).join(":");
      return { id, name, activity, attached, windows, attention, path };
    });
}

export function validateSessionCreate(flags: Record<string, string | boolean>): {
  name: string;
  dir: string;
  command?: string;
} {
  if (!flags.name || typeof flags.name !== "string") {
    throw new CliError("--name is required");
  }
  if (!flags.dir || typeof flags.dir !== "string") {
    throw new CliError("--dir is required");
  }
  const name = sanitizeTmuxSessionName(flags.name);
  const dir = flags.dir;
  const command = typeof flags.command === "string" ? flags.command : undefined;
  return { name, dir, ...(command !== undefined ? { command } : {}) };
}

export function handleSession(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const { action, flags } = parsed;

  switch (action) {
    case "list": {
      const result = runTmuxDirect(
        ["list-sessions", "-F", "#{session_id}:#{session_name}:#{session_activity}:#{session_attached}:#{session_windows}:#{@jmux-attention}:#{pane_current_path}"],
        ctx.socket,
      );
      // If no sessions exist, tmux exits non-zero — treat as empty list
      const lines = result.ok ? result.lines : [];
      const sessions = parseSessionListOutput(lines);
      return { sessions };
    }

    case "create": {
      const { name, dir, command } = validateSessionCreate(flags);
      const otel = buildOtelResourceAttrs(name);

      const createArgs = ["new-session", "-d", "-e", `OTEL_RESOURCE_ATTRIBUTES=${otel}`, "-s", name, "-c", dir];
      if (command) {
        createArgs.push(command);
      }

      tmuxOrThrow(runTmuxDirect(createArgs, ctx.socket));

      // Resolve the session ID
      const idResult = runTmuxDirect(
        ["list-sessions", "-F", "#{session_id}:#{session_name}", "-f", `#{==:#{session_name},${name}}`],
        ctx.socket,
      );
      let id: string | null = null;
      if (idResult.ok && idResult.lines.length > 0) {
        const parts = idResult.lines[0].split(":");
        id = parts[0];
      }

      return { name, id };
    }

    case "info": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;

      const sessionResult = runTmuxDirect(
        ["list-sessions", "-F", "#{session_id}:#{session_name}:#{session_activity}:#{session_attached}:#{session_windows}:#{@jmux-attention}:#{pane_current_path}", "-f", `#{==:#{session_name},${target}}`],
        ctx.socket,
      );
      tmuxOrThrow(sessionResult);
      const sessions = parseSessionListOutput(sessionResult.lines);
      const session = sessions[0];
      if (!session) {
        throw new CliError(`session "${target}" not found`);
      }

      const windowsResult = runTmuxDirect(
        ["list-windows", "-t", target, "-F", "#{window_id}:#{window_index}:#{window_name}:#{window_active}:#{window_bell_flag}:#{window_zoomed_flag}"],
        ctx.socket,
      );
      tmuxOrThrow(windowsResult);

      const windows_detail = windowsResult.lines.map((line) => {
        const parts = line.split(":");
        return {
          id: parts[0],
          index: parseInt(parts[1], 10),
          name: parts[2],
          active: parts[3] === "1",
          bell: parts[4] === "1",
          zoomed: parts[5] === "1",
        };
      });

      return { ...session, windows_detail };
    }

    case "switch": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      if (!ctx.insideTmux) {
        throw new CliError("switch requires an active tmux session (not inside tmux)");
      }
      const target = flags.target;
      tmuxOrThrow(runTmuxDirect(["switch-client", "-t", target], ctx.socket));
      return { switched: target };
    }

    case "kill": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;

      if (!flags.force) {
        // Self-destruction guard
        const current = resolveCurrentSession(ctx);
        if (current && current === target) {
          throw new CliError(
            `Refusing to kill current session "${target}". Use --force to override.`,
          );
        }

        // Last-session guard
        const listResult = runTmuxDirect(["list-sessions", "-F", "#{session_name}"], ctx.socket);
        if (listResult.ok && listResult.lines.length <= 1) {
          throw new CliError(
            `Refusing to kill the last session "${target}". Use --force to override.`,
          );
        }
      }

      tmuxOrThrow(runTmuxDirect(["kill-session", "-t", target], ctx.socket));
      return { killed: target };
    }

    case "rename": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      if (!flags.name || typeof flags.name !== "string") {
        throw new CliError("--name is required");
      }
      const target = flags.target;
      const newName = sanitizeTmuxSessionName(flags.name);
      tmuxOrThrow(runTmuxDirect(["rename-session", "-t", target, newName], ctx.socket));
      return { renamed: newName, from: target };
    }

    case "set-attention": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;

      if (flags.clear) {
        tmuxOrThrow(runTmuxDirect(["set-option", "-t", target, "-u", "@jmux-attention"], ctx.socket));
        return { target, attention: false };
      } else {
        tmuxOrThrow(runTmuxDirect(["set-option", "-t", target, "@jmux-attention", "1"], ctx.socket));
        return { target, attention: true };
      }
    }

    default:
      throw new CliError(
        `Unknown session action "${action}". Known actions: list, create, info, switch, kill, rename, set-attention`,
      );
  }
}
