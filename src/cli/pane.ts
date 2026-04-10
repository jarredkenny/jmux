import { readFileSync } from "fs";
import { runTmux, runTmuxDirect, type TmuxResult } from "./tmux";
import { requireSession, CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

const PANE_FORMAT =
  "#{pane_id}:#{window_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_current_command}:#{pane_current_path}";

export interface PaneEntry {
  id: string;
  window: string;
  active: boolean;
  width: number;
  height: number;
  command: string;
  path: string;
}

function tmuxOrThrow(result: TmuxResult): string[] {
  if (!result.ok) {
    throw new CliError(result.error);
  }
  return result.lines;
}

export function parsePaneListOutput(lines: string[]): PaneEntry[] {
  return lines
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.split(":");
      // Format: id:window:active:width:height:command:path...
      // path (last field) may contain colons — rejoin everything from index 6 onward
      const id = parts[0];
      const window = parts[1];
      const active = parts[2] === "1";
      const width = parseInt(parts[3], 10);
      const height = parseInt(parts[4], 10);
      const command = parts[5];
      const path = parts.slice(6).join(":");
      return { id, window, active, width, height, command, path };
    });
}

export function handlePane(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const { action, flags } = parsed;

  switch (action) {
    case "list": {
      const session =
        typeof flags.session === "string" ? flags.session : requireSession(ctx);
      // --window narrows the target to a specific window
      const target =
        typeof flags.window === "string" ? flags.window : session;
      const lines = tmuxOrThrow(
        runTmux(`list-panes -t '${target}' -F '${PANE_FORMAT}'`, ctx.socket),
      );
      return { panes: parsePaneListOutput(lines) };
    }

    case "split": {
      const session =
        typeof flags.session === "string" ? flags.session : requireSession(ctx);
      const dir = flags.direction === "h" ? "-h" : "-v";
      let cmd = `split-window ${dir} -t '${session}'`;
      if (typeof flags.dir === "string") {
        cmd += ` -c '${flags.dir}'`;
      }
      if (typeof flags.command === "string") {
        cmd += ` '${flags.command}'`;
      }
      tmuxOrThrow(runTmux(cmd, ctx.socket));

      // Query the newly active pane
      const idResult = tmuxOrThrow(
        runTmux(
          `display-message -t '${session}' -p '#{pane_id}:#{window_id}'`,
          ctx.socket,
        ),
      );
      const idParts = idResult[0]?.split(":") ?? [];
      const pane = idParts[0] ?? null;
      const window = idParts[1] ?? null;
      return { pane, session, window };
    }

    case "send-keys": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;

      let text: string;
      if (flags.stdin === true) {
        text = readFileSync("/dev/stdin", "utf-8");
      } else if (typeof flags.file === "string") {
        text = readFileSync(flags.file, "utf-8");
      } else if (parsed.positional.length > 0) {
        text = parsed.positional.join(" ");
      } else {
        throw new CliError(
          "send-keys requires text via positional args, --stdin, or --file",
        );
      }

      // Use runTmuxDirect to bypass sh -c so arbitrary text is safe
      const sendResult = runTmuxDirect(
        ["send-keys", "-t", target, "-l", "--", text],
        ctx.socket,
      );
      if (!sendResult.ok) {
        throw new CliError(sendResult.error);
      }

      // Send Enter unless --no-enter is set
      if (!flags["no-enter"]) {
        const enterResult = runTmuxDirect(
          ["send-keys", "-t", target, "Enter"],
          ctx.socket,
        );
        if (!enterResult.ok) {
          throw new CliError(enterResult.error);
        }
      }

      return { sent: true, target };
    }

    case "capture": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;
      let cmd = `capture-pane -t '${target}' -p`;
      if (flags.raw) {
        cmd += " -e";
      }
      if (typeof flags.lines === "string") {
        const n = Math.min(parseInt(flags.lines, 10), 1000);
        cmd += ` -S -${n}`;
      }
      const lines = tmuxOrThrow(runTmux(cmd, ctx.socket));
      return { target, content: lines.join("\n") };
    }

    case "kill": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;
      if (!flags.force && ctx.paneId === target) {
        throw new CliError(
          `Refusing to kill current pane "${target}". Use --force to override.`,
        );
      }
      tmuxOrThrow(runTmux(`kill-pane -t '${target}'`, ctx.socket));
      return { killed: target };
    }

    default:
      throw new CliError(
        `Unknown pane action "${action}". Known actions: list, split, send-keys, capture, kill`,
      );
  }
}
