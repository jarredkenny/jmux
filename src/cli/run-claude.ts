import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { sanitizeTmuxSessionName, buildOtelResourceAttrs, loadUserConfig } from "../config";
import { runTmux, type TmuxResult } from "./tmux";
import { CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";

function tmuxOrThrow(result: TmuxResult): string[] {
  if (!result.ok) {
    throw new CliError(result.error);
  }
  return result.lines;
}

export function validateRunClaude(flags: Record<string, string | boolean>): {
  name: string;
  dir: string;
} {
  if (!flags.name || typeof flags.name !== "string") {
    throw new CliError("--name is required");
  }
  if (!flags.dir || typeof flags.dir !== "string") {
    throw new CliError("--dir is required");
  }
  const name = sanitizeTmuxSessionName(flags.name);
  const dir = flags.dir;
  return { name, dir };
}

export function buildClaudeLaunchCommand(
  claudeCmd: string,
  promptTempFile: string | null,
  shell: string,
): string {
  if (promptTempFile === null) {
    return `${shell} -c '${claudeCmd}; exec ${shell}'`;
  }
  return `${shell} -c '${claudeCmd} -p "$(cat ${promptTempFile})"; rm -f ${promptTempFile}; exec ${shell}'`;
}

export function handleRunClaude(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const { flags } = parsed;

  const { name, dir } = validateRunClaude(flags);

  const config = loadUserConfig();
  const claudeCmd = config.claudeCommand ?? "claude";

  const shell = process.env.SHELL ?? "/bin/sh";

  const otel = buildOtelResourceAttrs(name);

  let promptTempFile: string | null = null;
  if (typeof flags.message === "string") {
    const rand = Math.random().toString(36).slice(2);
    const tempPath = resolve(tmpdir(), `jmux-prompt-${Date.now()}-${rand}`);
    writeFileSync(tempPath, flags.message, "utf-8");
    promptTempFile = tempPath;
  } else if (typeof flags["message-file"] === "string") {
    promptTempFile = flags["message-file"];
  }

  const launchCmd = buildClaudeLaunchCommand(claudeCmd, promptTempFile, shell);

  tmuxOrThrow(
    runTmux(
      `new-session -d -e 'OTEL_RESOURCE_ATTRIBUTES=${otel}' -s '${name}' -c '${dir}' '${launchCmd}'`,
      ctx.socket,
    ),
  );

  const paneResult = runTmux(`display-message -t '${name}' -p '#{pane_id}'`, ctx.socket);
  const paneId = paneResult.ok && paneResult.lines.length > 0 ? paneResult.lines[0] : null;

  return {
    session: name,
    pane: paneId,
    claude_command: claudeCmd,
    command_dispatched: true,
  };
}
