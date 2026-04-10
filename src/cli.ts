import { CliError, resolveContext } from "./cli/context";
import { handleSession } from "./cli/session";
import { handleWindow } from "./cli/window";
import { handlePane } from "./cli/pane";
import { handleRunClaude } from "./cli/run-claude";

export interface ParsedCtlArgs {
  group: string;
  action: string | null;
  flags: Record<string, string | boolean>;
  positional: string[];
}

const KNOWN_GROUPS = ["session", "window", "pane", "run-claude"] as const;
const STANDALONE_GROUPS = new Set(["run-claude"]);

// Flags that take a value argument (after group/action, or global)
const GLOBAL_VALUE_FLAGS = new Set(["session", "socket"]);
const VALUE_FLAGS = new Set([
  "name",
  "dir",
  "target",
  "direction",
  "command",
  "message",
  "message-file",
  "file",
  "lines",
  "window",
]);
const BOOL_FLAGS = new Set(["force", "no-enter", "enter", "raw", "clear", "stdin"]);

const CTL_HELP = `
jmux ctl — programmatic interface to jmux/tmux

USAGE
  jmux ctl [GLOBAL FLAGS] <group> [action] [FLAGS] [args...]

GROUPS
  session    Manage tmux sessions
  window     Manage tmux windows
  pane       Manage tmux panes
  run-claude Run a Claude Code agent in a session

GLOBAL FLAGS
  --session <name>   Target session name
  --socket <path>    tmux socket path or name (-L)
  -L <name>          Alias for --socket

FLAGS
  --name <val>         Name for created resource
  --dir <val>          Working directory
  --target <val>       tmux target (session, window, or pane)
  --direction <val>    Split direction (horizontal|vertical)
  --command <val>      Command to run
  --message <val>      Message text
  --message-file <val> Path to file containing message
  --file <val>         File path
  --lines <val>        Number of lines
  --window <val>       Window target
  --force              Skip confirmation prompts
  --no-enter           Don't send Enter after keys
  --enter              Send Enter after keys
  --raw                Raw output mode
  --clear              Clear before running
  --stdin              Read from stdin
`.trim();

export function parseCtlArgs(argv: string[]): ParsedCtlArgs {
  if (argv.length > 0 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(CTL_HELP);
    process.exit(0);
  }

  const flags: Record<string, string | boolean> = {};
  let i = 0;

  // Parse global flags before the group
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-L") {
      if (i + 1 >= argv.length) {
        throw new CliError("Flag -L requires a value");
      }
      flags.socket = argv[++i];
      i++;
    } else if (arg === "--session") {
      if (i + 1 >= argv.length) {
        throw new CliError("Flag --session requires a value");
      }
      flags.session = argv[++i];
      i++;
    } else if (arg === "--socket") {
      if (i + 1 >= argv.length) {
        throw new CliError("Flag --socket requires a value");
      }
      flags.socket = argv[++i];
      i++;
    } else {
      // Not a global flag — must be the group
      break;
    }
  }

  if (i >= argv.length) {
    throw new CliError("Missing required group (session|window|pane|run-claude)");
  }

  const group = argv[i++];
  if (!(KNOWN_GROUPS as readonly string[]).includes(group)) {
    throw new CliError(
      `Unknown group "${group}". Known groups: ${KNOWN_GROUPS.join(", ")}`,
    );
  }

  // Standalone groups have no sub-action
  let action: string | null = null;
  if (!STANDALONE_GROUPS.has(group)) {
    if (i < argv.length && !argv[i].startsWith("-")) {
      action = argv[i++];
    }
  }

  // Parse remaining flags and positional args
  const positional: string[] = [];
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (BOOL_FLAGS.has(name)) {
        flags[name] = true;
        i++;
      } else if (VALUE_FLAGS.has(name) || GLOBAL_VALUE_FLAGS.has(name)) {
        if (i + 1 >= argv.length) {
          throw new CliError(`Flag --${name} requires a value`);
        }
        flags[name] = argv[++i];
        i++;
      } else {
        // Unknown flag — treat as boolean (permissive)
        flags[name] = true;
        i++;
      }
    } else {
      // Positional
      positional.push(arg);
      i++;
    }
  }

  return { group, action, flags, positional };
}

export async function runCtl(argv: string[]): Promise<void> {
  let parsed: ParsedCtlArgs;
  try {
    parsed = parseCtlArgs(argv);
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    }
    throw err;
  }

  const ctx = resolveContext({ env: process.env as Record<string, string | undefined>, flags: parsed.flags });

  try {
    let result: unknown;
    switch (parsed.group) {
      case "session":
        result = handleSession(ctx, parsed);
        break;
      case "window":
        result = handleWindow(ctx, parsed);
        break;
      case "pane":
        result = handlePane(ctx, parsed);
        break;
      case "run-claude":
        result = handleRunClaude(ctx, parsed);
        break;
      default:
        throw new CliError(`Unknown group: ${parsed.group}`);
    }
    process.stdout.write(JSON.stringify(result ?? null) + "\n");
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    }
    if (err instanceof Error) {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    }
    throw err;
  }
}
