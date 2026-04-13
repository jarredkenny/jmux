import { mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";
import { DEMO_SESSIONS, DEMO_MANUAL_LINKS } from "./seed-data";
import { DemoCodeHostAdapter } from "./mock-code-host";
import { DemoIssueTrackerAdapter } from "./mock-issue-tracker";

export interface DemoContext {
  socketName: string;      // "jmux-demo-<pid>"
  tmpDir: string;          // "/tmp/jmux-demo-<pid>"
  configPath: string;      // "<tmpDir>/config.json"
  statePath: string;       // "<tmpDir>/state.json"
  codeHost: DemoCodeHostAdapter;
  issueTracker: DemoIssueTrackerAdapter;
}

export function setupDemo(): DemoContext {
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

  // 2. Write config.json
  const config = {
    sidebarWidth: 26,
    cacheTimers: false,
    adapters: {
      codeHost: { type: "demo" },
      issueTracker: { type: "demo" },
    },
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
      ["tmux", "-L", socketName, "new-session", "-d", "-s", session.name, "-c", dir],
      { stdout: "pipe", stderr: "pipe" },
    );
  }

  // 5. Set attention flags for sessions that need them
  for (const session of DEMO_SESSIONS) {
    if (session.attention) {
      Bun.spawnSync(
        ["tmux", "-L", socketName, "set-option", "-t", session.name, "@jmux-attention", "1"],
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
