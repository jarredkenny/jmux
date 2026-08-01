import { mkdirSync, readdirSync, writeFileSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { DEMO_SESSIONS, DEMO_MANUAL_LINKS } from "./seed-data";
import { DemoCodeHostAdapter } from "./mock-code-host";
import { DemoIssueTrackerAdapter } from "./mock-issue-tracker";
import { DEMO_AGENT_JOBS, repoFiles, type DemoProject } from "./repo-files";
import { CLAUDE_EVENTS } from "../agent-hooks/claude";
import { buildHookBlock } from "../agent-hooks/commands";

export interface DemoContext {
  socketName: string;      // "jmux-demo-<pid>"
  tmpDir: string;          // "/tmp/jmux-demo-<pid>"
  configPath: string;      // "<tmpDir>/config.json"
  statePath: string;       // "<tmpDir>/state.json"
  codeHost: DemoCodeHostAdapter;
  issueTracker: DemoIssueTrackerAdapter;
}

export interface DemoOptions {
  /**
   * jmux's tmux config. Demo mode creates the sessions, which *starts* the
   * server — and tmux honors `-f` only from the process that starts one. Without
   * it jmux's later attach silently inherits the user's defaults, so `status
   * off` never lands and tmux's own status bar draws underneath jmux's chrome.
   */
  configFile?: string;
}

/**
 * Write a demo project's source tree into `dir`, plus the jmux state emitter as
 * a *project-local* Claude hook.
 *
 * Local rather than global on purpose. `jmux --install-agent-hooks` edits
 * `~/.claude/settings.json`, which is right for a real install and wrong for a
 * throwaway demo — running the demo must not rewrite the user's own agent
 * config, and the demo's tmpdir is deleted on exit. `.claude/settings.json` in
 * the repo scopes the emitter to exactly these sessions and disappears with
 * them. The hook block itself is built by the shipped builder, so the demo
 * cannot drift from what a real install writes.
 */
function seedRepo(dir: string, project: DemoProject, sessionName: string): void {
  for (const [rel, contents] of Object.entries(repoFiles(project))) {
    const path = resolve(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  const settings = {
    hooks: buildHookBlock("claude", CLAUDE_EVENTS),
    // Pinned per session, and never left to the machine's own setting. Project
    // settings outrank `~/.claude/settings.json`, which matters in both
    // directions: a machine set to `dontAsk` *denies* edits outright rather than
    // prompting, so the agent stops and explains itself and no
    // `PermissionRequest` ever fires — the WAITING badge, the single most
    // important thing demo mode has to show, would never appear. A machine set
    // to accept everything would never show it either. Which sessions ask is a
    // property of the demo, not of the viewer.
    permissions: {
      defaultMode: DEMO_AGENT_JOBS[sessionName]?.mode ?? "default",
      allow: DEMO_AGENT_JOBS[sessionName]?.allow ?? [],
    },
  };
  mkdirSync(resolve(dir, ".claude"), { recursive: true });
  writeFileSync(
    resolve(dir, ".claude", "settings.json"),
    JSON.stringify(settings, null, 2) + "\n",
  );
}

/**
 * Kill demo servers whose jmux is gone, and delete their scratch directories.
 *
 * `cleanupDemo` runs on SIGINT/SIGTERM/SIGHUP, which covers quitting jmux but
 * not SIGKILL, a crash, or a terminal window closing out from under the pty —
 * and each of those strands a tmux server plus a `/tmp/jmux-demo-<pid>` tree
 * that nothing ever collects. They accumulate silently: a week of demo runs
 * leaves dozens of dead sockets behind.
 *
 * `--live` is what makes this worth fixing rather than tolerating. A stranded
 * plain demo wastes a socket file; a stranded *live* demo leaves real agents
 * running against the user's account with no window attached to them.
 *
 * Reaping keys on the pid embedded in the socket name and acts only when that
 * process is gone, so a second jmux running its own demo concurrently is never
 * touched — which is also why the name carries the pid in the first place.
 */
/** Team name → the project whose source tree seeds that team's base repo. */
const TEAM_PROJECTS: Record<string, DemoProject> = {
  Platform: "platform",
  Dashboard: "dashboard",
  Infrastructure: "platform",
};

/**
 * Create one base repo per team, for `Ctrl-a u` and the issue panel's `n` to
 * cut worktrees from.
 *
 * Without these, `startWorkOnIssue` finds no `teamRepoMap` entry and the single
 * most important thing jmux does — issue to worktree to briefed agent in one
 * keystroke — silently does nothing in the mode built for evaluating it.
 *
 * Everything stays inside the demo's tmpdir, and `wtmIntegration` is off for
 * these repos so the command is plain `git worktree add`. Demo mode promises
 * "nothing to configure"; it must not quietly require wtm to be installed, and
 * it must never cut a worktree into a repo the user actually cares about.
 */
function seedBaseRepos(tmpDir: string): Record<string, string> {
  const map: Record<string, string> = {};

  for (const [team, project] of Object.entries(TEAM_PROJECTS)) {
    const dir = resolve(tmpDir, "repos", team.toLowerCase());
    if (map[team]) continue;
    mkdirSync(dir, { recursive: true });

    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.name=Demo", "-c", "user.email=demo@jmux.dev", ...args], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });

    git("init", "-b", "main");
    seedRepo(dir, project, "");
    git("add", "-A");
    git("commit", "-m", "init");

    map[team] = dir;
  }

  return map;
}

export function reapStaleDemoServers(): string[] {
  const socketDir = resolve(
    process.env.TMUX_TMPDIR || "/tmp",
    `tmux-${process.getuid?.() ?? 0}`,
  );

  let entries: string[];
  try {
    entries = readdirSync(socketDir);
  } catch {
    return []; // no socket dir yet — nothing has ever run
  }

  const reaped: string[] = [];
  for (const name of entries) {
    const match = /^jmux-demo-(\d+)$/.exec(name);
    if (!match) continue;

    const pid = Number(match[1]);
    if (pid === process.pid || pidAlive(pid)) continue;

    Bun.spawnSync(["tmux", "-L", name, "kill-server"], { stdout: "pipe", stderr: "pipe" });
    try { rmSync(resolve(socketDir, name), { force: true }); } catch { /* already gone */ }
    try { rmSync(`/tmp/jmux-demo-${pid}`, { recursive: true, force: true }); } catch { /* already gone */ }
    reaped.push(name);
  }
  return reaped;
}

/** Whether a pid is still running. Signal 0 tests existence without delivering. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — alive, not ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function setupDemo(opts: DemoOptions = {}): DemoContext {
  reapStaleDemoServers();

  const pid = process.pid;
  const socketName = `jmux-demo-${pid}`;
  const tmpDir = `/tmp/jmux-demo-${pid}`;
  const configPath = resolve(tmpDir, "config.json");
  const statePath = resolve(tmpDir, "state.json");

  // 1. Create tmpDir and session subdirs, init git repos
  mkdirSync(tmpDir, { recursive: true });

  for (const session of DEMO_SESSIONS) {
    const dir = resolve(tmpDir, "sessions", session.group, session.name);
    mkdirSync(dir, { recursive: true });

    Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "checkout", "-b", session.branch], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    Bun.spawnSync(["git", "remote", "add", "origin", session.remote], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    seedRepo(dir, session.project as DemoProject, session.name);

    Bun.spawnSync(["git", "add", "-A"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      [
        "git",
        "-c", "user.name=Demo",
        "-c", "user.email=demo@jmux.dev",
        "commit",
        "--allow-empty",
        "-m", "init",
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
  }

  // 1b. Base repos the issue→worktree flow cuts from.
  const teamRepoMap = seedBaseRepos(tmpDir);

  // 2. Write config.json
  //
  // Stages are seeded rather than left to DEFAULT_VIEWS so demo mode exercises
  // the configured-workflow paths — stage grouping in the sidebar, and the Up
  // next band. `showUnstartedInSidebar` is deliberately ON here and OFF in the
  // shipped default: demo mode exists to show the features, and a band nobody
  // can see is a band nobody can check.
  const config = {
    sidebarWidth: 26,
    cacheTimers: false,
    adapters: {
      codeHost: { type: "demo" },
      issueTracker: { type: "demo" },
    },
    panelViews: [
      {
        id: "todo", label: "To do", source: "issues",
        filter: { scope: "assigned" },
        groupBy: "none", subGroupBy: "none",
        sortBy: "priority", sortOrder: "asc", sessionLinkedFirst: false,
        states: ["Todo", "Backlog"],
      },
      {
        id: "in-progress", label: "In progress", source: "issues",
        filter: { scope: "assigned" },
        groupBy: "none", subGroupBy: "none",
        sortBy: "priority", sortOrder: "asc", sessionLinkedFirst: true,
        states: ["In Progress", "In Review"],
      },
      {
        // Claims the hand-off statuses. Kept out of `parkedStates` on purpose:
        // demo mode opens with these sessions *visible*, so turning parking on
        // for the stage is a change the viewer watches happen — the sidebar
        // collapses in front of them — rather than a state they arrive to and
        // have to take on trust.
        id: "waiting", label: "Waiting", source: "issues",
        filter: { scope: "assigned" },
        groupBy: "none", subGroupBy: "none",
        sortBy: "updated", sortOrder: "desc", sessionLinkedFirst: true,
        states: ["In Code Review", "Awaiting QA Sign-off", "Pending Release Approval"],
      },
      {
        id: "done", label: "Done", source: "issues",
        filter: { scope: "assigned" },
        groupBy: "none", subGroupBy: "none",
        sortBy: "updated", sortOrder: "desc", sessionLinkedFirst: false,
        states: ["Done"],
      },
      {
        id: "my-mrs", label: "My MRs", source: "mrs",
        filter: { scope: "authored" },
        groupBy: "none", subGroupBy: "none",
        sortBy: "updated", sortOrder: "desc", sessionLinkedFirst: true,
      },
    ],
    pipeline: {
      // Feeds the flat "Up next" band on the non-stage grouping axes. Grouped by
      // stage, every stage fills its own band and this is not consulted.
      upNext: ["todo"],
      showUnstartedInSidebar: 3,
    },
    // Stage grouping so demo mode opens on the placement the feature is really
    // about: ghosts under each stage, including stages holding only ghosts.
    sidebarGroupBy: "stage",
    // Maps each demo team onto a base repo inside the demo's own tmpdir, so
    // `Ctrl-a u` and the panel's `n` cut a real worktree and launch a real
    // agent without touching anything outside it.
    issueWorkflow: { teamRepoMap },
    repoDefaults: {
      // Plain `git worktree add` — demo mode must not require wtm.
      wtmIntegration: false,
      defaultBaseBranch: "main",
      autoLaunchAgent: true,
    },
    // Off in the shipped default, on here for the same reason as
    // `showUnstartedInSidebar`: demo mode exists to show the feature. Under
    // `--live` this is what fills the Command Center — the agent panes surface
    // themselves off `@jmux-agent-kind`, with nothing to pin by hand.
    autoPinAgentPanes: true,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // 3. Write state.json — transform DEMO_MANUAL_LINKS into sessionLinks format
  const sessionLinks: Record<string, Array<{ type: string; id: string }>> = {};
  for (const { session, issueId } of DEMO_MANUAL_LINKS) {
    if (!sessionLinks[session]) {
      sessionLinks[session] = [];
    }
    sessionLinks[session].push({ type: "issue", id: issueId });
  }
  writeFileSync(statePath, JSON.stringify({ sessionLinks }, null, 2) + "\n");

  // 4. Create tmux sessions on the isolated socket
  for (const session of DEMO_SESSIONS) {
    const dir = resolve(tmpDir, "sessions", session.group, session.name);
    Bun.spawnSync(
      [
        "tmux",
        "-L", socketName,
        ...(opts.configFile ? ["-f", opts.configFile] : []),
        "new-session", "-d", "-s", session.name, "-c", dir,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        // `Bun.spawnSync` inherits the environment as it was when *this process*
        // started, not as it is now — a runtime `process.env.X = ...` does not
        // reach the child. `main.ts` sets `JMUX_DIR` at runtime, and
        // `config/tmux.conf` expands `$JMUX_DIR/config/defaults.conf`, so
        // without this the path resolves to `/config/defaults.conf`, tmux
        // silently sources nothing (exit code 0, no stderr), `core.conf` never
        // runs, and `status off` never applies — the green tmux status bar comes
        // straight back.
        //
        // Spreading `process.env` here reads it live, which is the fix. This
        // hides well: anyone whose shell already exports `JMUX_DIR` — which is
        // to say anyone running jmux from inside jmux — cannot reproduce it.
        env: { ...process.env },
      },
    );
  }

  // 5. Set agent-state for sessions that specify one
  const waitingSince = String(Math.floor(Date.now() / 1000));
  for (const session of DEMO_SESSIONS) {
    if (session.agentState !== undefined) {
      Bun.spawnSync(
        ["tmux", "-L", socketName, "set-option", "-t", session.name, "@jmux-agent-state", session.agentState],
        { stdout: "pipe", stderr: "pipe" },
      );
      Bun.spawnSync(
        ["tmux", "-L", socketName, "set-option", "-t", session.name, "@jmux-agent-state-since", waitingSince],
        { stdout: "pipe", stderr: "pipe" },
      );
    }
  }

  // 6. Instantiate mock adapters
  const codeHost = new DemoCodeHostAdapter();
  const issueTracker = new DemoIssueTrackerAdapter();

  return { socketName, tmpDir, configPath, statePath, codeHost, issueTracker };
}

export function cleanupDemo(ctx: DemoContext): void {
  try {
    Bun.spawnSync(["tmux", "-L", ctx.socketName, "kill-server"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    // ignore — server may already be gone
  }

  try {
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
