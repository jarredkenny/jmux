import { writeFileSync } from "fs";
import { resolve } from "path";

import { DEMO_AGENT_JOBS } from "./repo-files";
import type { DemoContext } from "./setup";

/**
 * Launch real agents inside demo sessions.
 *
 * Demo mode normally seeds `@jmux-agent-state` directly, which is enough for a
 * still screenshot but not for video: a pane holding a shell prompt reads as a
 * mockup the moment it sits on screen for more than a second. `--live` puts an
 * actual agent in the sessions the camera is pointed at, so the badges in the
 * sidebar are reporting work that is really happening.
 *
 * Only the sessions named in `DEMO_AGENT_JOBS` go live. The rest keep their
 * seeded state, written through the same tmux options a real agent writes —
 * there is no second code path for a "fake" agent, just a value with no process
 * behind it.
 */
export interface LiveAgentOptions {
  /** Command that starts the agent. Matches the `claudeCommand` repo setting. */
  command?: string;
  /** Restrict to these session names. Defaults to every session with a task. */
  only?: readonly string[];
}

export interface LiveAgentResult {
  started: string[];
  skipped: string[];
}

export function startLiveAgents(
  ctx: DemoContext,
  opts: LiveAgentOptions = {},
): LiveAgentResult {
  const command = opts.command ?? "claude";
  const names = opts.only ?? Object.keys(DEMO_AGENT_JOBS);

  const started: string[] = [];
  const skipped: string[] = [];

  for (const name of names) {
    const job = DEMO_AGENT_JOBS[name];
    if (!job) {
      skipped.push(name);
      continue;
    }

    // Same idiom as main.ts's issue-session launch: the prompt goes to a file
    // and is read back by the shell, so no amount of quoting in the task text
    // can break the command line. `exec $SHELL` leaves a usable pane behind
    // when the agent exits, instead of killing the window mid-demo.
    const promptFile = resolve(ctx.tmpDir, `prompt-${name}.txt`);
    writeFileSync(promptFile, job.task);

    // `--strict-mcp-config` with no `--mcp-config` loads *no* MCP servers. The
    // user's own servers are irrelevant to the demo and announce themselves in
    // the pane ("N MCP servers need authentication"), which is a banner about
    // the viewer's machine sitting in the middle of a product demo.
    const cmd =
      `${command} --strict-mcp-config "$(cat ${promptFile})"; ` +
      `rm -f ${promptFile}; exec $SHELL`;

    const proc = Bun.spawnSync(
      ["tmux", "-L", ctx.socketName, "send-keys", "-t", name, cmd, "Enter"],
      { stdout: "pipe", stderr: "pipe" },
    );

    if (proc.exitCode === 0) started.push(name);
    else skipped.push(name);
  }

  return { started, skipped };
}

/** Text Claude Code shows when asking whether a workspace is trusted. */
const TRUST_PROMPT = /Is this a project you created or one you trust/;

/**
 * Answer the workspace-trust prompt in each live pane.
 *
 * Every demo session is a directory that did not exist a moment ago, so Claude
 * Code asks about all of them and then blocks — without this, `--live` produces
 * four panes sitting on a dialog and no agent ever runs.
 *
 * Three things about how this is done matter:
 *
 * - **It answers a question about a directory jmux itself just created**, whose
 *   entire contents jmux wrote, and which is deleted on exit. It is not a
 *   blanket trust setting and it does not persist anywhere.
 * - **It is not `--dangerously-skip-permissions`.** That flag would suppress
 *   every later permission prompt too, and those are exactly what drive the
 *   `waiting` state the sidebar exists to show. Only the trust dialog is
 *   answered; ordinary tool permissions still stop and ask.
 * - **It waits to see the prompt before pressing anything.** A blind `Enter`
 *   after a fixed delay lands in whatever happens to be on screen — a running
 *   agent, or nothing — which is how a demo ends up submitting an empty prompt
 *   to an agent that was already working.
 */
export async function acceptWorkspaceTrust(
  ctx: DemoContext,
  names: readonly string[] = Object.keys(DEMO_AGENT_JOBS),
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const pollMs = opts.pollMs ?? 400;
  const deadline = Date.now() + timeoutMs;

  const pending = new Set(names);
  const answered: string[] = [];

  while (pending.size > 0 && Date.now() < deadline) {
    for (const name of [...pending]) {
      const cap = Bun.spawnSync(
        ["tmux", "-L", ctx.socketName, "capture-pane", "-p", "-t", name],
        { stdout: "pipe", stderr: "pipe" },
      );
      const text = new TextDecoder().decode(cap.stdout);
      if (!TRUST_PROMPT.test(text)) continue;

      Bun.spawnSync(
        ["tmux", "-L", ctx.socketName, "send-keys", "-t", name, "Enter"],
        { stdout: "pipe", stderr: "pipe" },
      );
      pending.delete(name);
      answered.push(name);
    }
    if (pending.size > 0) await Bun.sleep(pollMs);
  }

  return answered;
}

/**
 * Keep answering the trust dialog, for every session on the demo socket, for as
 * long as the demo runs. Returns a stop function.
 *
 * The one-shot pass above only covers the sessions that exist at startup. But
 * the flow this mode most needs to demonstrate — `Ctrl-a u`, and `n` in the
 * issue panel — *creates* sessions in *new* worktree directories, and Claude
 * asks about each one. Without a standing watcher, the headline "one keystroke
 * from ticket to briefed agent" ends on a modal asking whether the directory
 * jmux just created is trustworthy.
 *
 * Enumerating sessions each tick rather than taking a fixed list is the whole
 * point: the sessions that need this are the ones that did not exist yet.
 */
export function watchWorkspaceTrust(
  ctx: DemoContext,
  opts: { intervalMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 1000;
  let stopped = false;

  const tick = () => {
    if (stopped) return;

    const list = Bun.spawnSync(
      ["tmux", "-L", ctx.socketName, "list-panes", "-a", "-F", "#{pane_id}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const panes = new TextDecoder().decode(list.stdout).trim().split("\n").filter(Boolean);

    for (const pane of panes) {
      const cap = Bun.spawnSync(
        ["tmux", "-L", ctx.socketName, "capture-pane", "-p", "-t", pane],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (!TRUST_PROMPT.test(new TextDecoder().decode(cap.stdout))) continue;

      Bun.spawnSync(["tmux", "-L", ctx.socketName, "send-keys", "-t", pane, "Enter"], {
        stdout: "pipe",
        stderr: "pipe",
      });
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Never hold the process open for this — it is a background convenience, and
  // jmux exiting must not wait on it.
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Whether an agent command is actually on PATH.
 *
 * Checked before launching so `--live` fails with one clear line instead of
 * four panes each printing "command not found" underneath jmux's chrome, which
 * looks like jmux is broken rather than like a missing dependency.
 */
export function agentAvailable(command = "claude"): boolean {
  const bin = command.trim().split(/\s+/)[0];
  if (!bin) return false;
  return Bun.spawnSync(["which", bin], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}
