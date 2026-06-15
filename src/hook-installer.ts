export type HookEvent =
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "PreToolUse"
  | "Stop";

export interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
}

export interface HookEntry {
  hooks: HookCommand[];
}

export type ClaudeSettings = {
  hooks?: Partial<Record<string, HookEntry[]>>;
  [k: string]: unknown;
};

export type InstallKind = "none" | "legacy" | "partial" | "current";
export type InstallOutcomeKind = "installed" | "migrated" | "noop";

export interface InstallOutcome {
  kind: InstallOutcomeKind;
  settings: ClaudeSettings;
}

// `@jmux-agent-pane` records the pane actually running Claude ($TMUX_PANE),
// distinct from a session's *active* pane (which drifts after splits). This
// lets `jmux ctl agent state` report the real agent pane an orchestrator should
// send keys to, rather than guessing the active one.
const SET_AGENT_PANE =
  'tmux set-option @jmux-agent-pane "$TMUX_PANE" 2>/dev/null';
const SET_RUNNING =
  `tmux set-option @jmux-agent-state running 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null && ${SET_AGENT_PANE} || true`;
const SET_WAITING =
  `tmux set-option @jmux-agent-state waiting 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null && ${SET_AGENT_PANE} || true`;
const SET_COMPLETE =
  `tmux set-option @jmux-agent-state complete 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null && ${SET_AGENT_PANE} || true`;
// PreToolUse fires on EVERY tool invocation mid-task. Without this guard
// every call would overwrite @jmux-agent-state-since, resetting the row-1
// elapsed timer and making a stuck tool invisible. The other three hooks
// fire at clean transition points and don't need the guard.
const SET_RUNNING_IDEMPOTENT =
  `[ "$(tmux show-option -qv @jmux-agent-state 2>/dev/null)" = "running" ] || { tmux set-option @jmux-agent-state running 2>/dev/null && tmux set-option @jmux-agent-state-since $(date +%s) 2>/dev/null && ${SET_AGENT_PANE}; } || true`;

const TIMEOUT = 5;

const HOOK_COMMANDS: Record<HookEvent, string> = {
  UserPromptSubmit: SET_RUNNING,
  PermissionRequest: SET_WAITING,
  // Idempotent — see SET_RUNNING_IDEMPOTENT comment.
  PreToolUse: SET_RUNNING_IDEMPOTENT,
  Stop: SET_COMPLETE,
};

const HOOK_EVENTS = Object.keys(HOOK_COMMANDS) as readonly HookEvent[];

export function buildHookBlock(): Record<HookEvent, HookEntry[]> {
  const out = {} as Record<HookEvent, HookEntry[]>;
  for (const event of HOOK_EVENTS) {
    out[event] = [
      {
        hooks: [
          { type: "command", command: HOOK_COMMANDS[event], timeout: TIMEOUT },
        ],
      },
    ];
  }
  return out;
}

function isJmuxHookCommand(cmd: string): boolean {
  return cmd.includes("@jmux-agent-state");
}

function isLegacyHookCommand(cmd: string): boolean {
  return cmd.includes("@jmux-attention");
}

function hasJmuxHook(entries: HookEntry[] | undefined): boolean {
  return !!entries?.some((e) => e.hooks.some((h) => isJmuxHookCommand(h.command)));
}

export function detectInstalledKind(settings: ClaudeSettings): InstallKind {
  const hooks = settings.hooks ?? {};
  const legacyStop = hooks.Stop?.some((e) =>
    e.hooks.some((h) => isLegacyHookCommand(h.command)),
  );
  if (legacyStop) return "legacy";

  const present = HOOK_EVENTS.filter((ev) => hasJmuxHook(hooks[ev]));
  if (present.length === 0) return "none";
  if (present.length === HOOK_EVENTS.length) return "current";
  return "partial";
}

function stripLegacyAndJmux(entries: HookEntry[] | undefined): HookEntry[] {
  if (!entries) return [];
  return entries
    .map((e) => ({
      ...e,
      hooks: e.hooks.filter(
        (h) => !isJmuxHookCommand(h.command) && !isLegacyHookCommand(h.command),
      ),
    }))
    .filter((e) => e.hooks.length > 0);
}

export function installHooks(settings: ClaudeSettings): InstallOutcome {
  const detected = detectInstalledKind(settings);
  if (detected === "current") {
    return {
      kind: "noop",
      settings: JSON.parse(JSON.stringify(settings)) as ClaudeSettings,
    };
  }

  // Deep-clone so callers can compare structurally and so we don't mutate the
  // caller's settings object.
  const next: ClaudeSettings = JSON.parse(JSON.stringify(settings));
  next.hooks ??= {};

  // For each managed event, strip any prior jmux/legacy entries and prepend
  // the canonical one. Preserves unrelated user entries.
  const block = buildHookBlock();
  for (const event of HOOK_EVENTS) {
    const existing = stripLegacyAndJmux(next.hooks![event] as HookEntry[] | undefined);
    next.hooks![event] = [...block[event], ...existing];
  }

  return {
    kind: detected === "legacy" ? "migrated" : "installed",
    settings: next,
  };
}
