import { runTmuxDirect } from "./tmux";
import { resolveCurrentSession, requireSession, tmuxOrThrow, CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

const WINDOW_FORMAT =
  "#{window_id}:#{window_index}:#{window_name}:#{window_active}:#{window_bell_flag}:#{window_zoomed_flag}";

export interface WindowEntry {
  id: string;
  index: number;
  name: string;
  active: boolean;
  bell: boolean;
  zoomed: boolean;
}

export function parseWindowListOutput(lines: string[]): WindowEntry[] {
  return lines
    .filter((l) => l.length > 0)
    .map((line) => {
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
}

export function handleWindow(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const { action, flags } = parsed;

  switch (action) {
    case "list": {
      const session =
        typeof flags.session === "string" ? flags.session : requireSession(ctx);
      const lines = tmuxOrThrow(
        runTmuxDirect(["list-windows", "-t", session, "-F", WINDOW_FORMAT], ctx.socket),
      );
      return { windows: parseWindowListOutput(lines) };
    }

    case "create": {
      const session =
        typeof flags.session === "string" ? flags.session : requireSession(ctx);
      const createArgs = ["new-window", "-t", session];
      if (typeof flags.dir === "string") {
        createArgs.push("-c", flags.dir);
      }
      if (typeof flags.name === "string") {
        createArgs.push("-n", flags.name);
      }
      tmuxOrThrow(runTmuxDirect(createArgs, ctx.socket));

      // Get the newly created window — it will be the last by index
      const lines = tmuxOrThrow(
        runTmuxDirect(["list-windows", "-t", session, "-F", WINDOW_FORMAT], ctx.socket),
      );
      const windows = parseWindowListOutput(lines);
      const newest = windows.reduce((a, b) => (b.index > a.index ? b : a));
      return { id: newest.id, index: newest.index, name: newest.name };
    }

    case "select": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;
      tmuxOrThrow(runTmuxDirect(["select-window", "-t", target], ctx.socket));
      return { selected: target };
    }

    case "kill": {
      if (!flags.target || typeof flags.target !== "string") {
        throw new CliError("--target is required");
      }
      const target = flags.target;

      if (!flags.force && ctx.paneId) {
        // Self-destruction guard: check if the current window matches the target
        const result = runTmuxDirect(
          ["display-message", "-t", ctx.paneId, "-p", "#{window_id}"],
          ctx.socket,
        );
        if (result.ok && result.lines.length > 0 && result.lines[0] === target) {
          throw new CliError(
            `Refusing to kill current window "${target}". Use --force to override.`,
          );
        }
      }

      tmuxOrThrow(runTmuxDirect(["kill-window", "-t", target], ctx.socket));
      return { killed: target };
    }

    default:
      throw new CliError(
        `Unknown window action "${action}". Known actions: list, create, select, kill`,
      );
  }
}
