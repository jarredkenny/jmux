import type { PaneKind } from "./schema";

export interface PainterInput {
  scrollbackPath: string;
  capturedAt: string;
  kind: PaneKind;
  claudeCommand: string;
  userShell: string;
}

const PAINTER_BODY =
  'F=$1; [ -s "$F" ] && cat "$F"; ' +
  'printf "\\n\\033[2m--- restored @ %s ---\\033[0m\\n" "$2"; ' +
  'shift 2; exec "$@"';

function tokenize(cmd: string): string[] {
  return cmd
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildPainterArgv(input: PainterInput): string[] {
  const tail =
    input.kind === "claude"
      ? [...tokenize(input.claudeCommand), "--continue"]
      : [input.userShell, "-i"];

  return [
    "sh",
    "-c",
    PAINTER_BODY,
    "jmux-restore",
    input.scrollbackPath,
    input.capturedAt,
    ...tail,
  ];
}

const SHELL_NAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
]);

export function detectPaneKind(command: string): PaneKind {
  const tokens = tokenize(command);
  if (tokens.length === 0) return "other";

  // Walk past "bun run", "npm run", "pnpm run", "yarn run" prefixes.
  let i = 0;
  while (
    i + 1 < tokens.length &&
    (tokens[i] === "bun" ||
      tokens[i] === "npm" ||
      tokens[i] === "pnpm" ||
      tokens[i] === "yarn") &&
    tokens[i + 1] === "run"
  ) {
    i += 2;
  }
  if (i < tokens.length) {
    const head = tokens[i];
    if (head === "claude" || head.endsWith("/claude")) return "claude";
  }

  const head = tokens[0];
  const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
  if (SHELL_NAMES.has(base)) return "shell";

  return "other";
}
