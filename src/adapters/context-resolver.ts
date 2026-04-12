import type {
  CodeHostAdapter,
  IssueTrackerAdapter,
  SessionContext,
} from "./types";

export interface GitRemote {
  name: string;
  url: string;
}

const HOSTNAME_MAP: Record<string, string[]> = {
  gitlab: ["gitlab.com"],
  github: ["github.com"],
};

export async function getGitBranch(dir: string): Promise<string | null> {
  try {
    const proc = Bun.spawnSync(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) return null;
    const branch = proc.stdout.toString().trim();
    return branch || null;
  } catch {
    return null;
  }
}

export async function getGitRemotes(dir: string): Promise<GitRemote[]> {
  try {
    const proc = Bun.spawnSync(
      ["git", "remote", "-v"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) return [];
    const lines = proc.stdout.toString().trim().split("\n");
    const seen = new Set<string>();
    const remotes: GitRemote[] = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const name = parts[0];
      if (seen.has(name)) continue;
      seen.add(name);
      remotes.push({ name, url: parts[1] });
    }
    return remotes;
  } catch {
    return [];
  }
}

export function selectRemote(
  remotes: GitRemote[],
  adapterType: string | null,
): GitRemote | null {
  if (remotes.length === 0) return null;

  if (adapterType) {
    const hostnames = HOSTNAME_MAP[adapterType] ?? [];
    for (const remote of remotes) {
      try {
        const hostname = new URL(remote.url).hostname;
        if (hostnames.includes(hostname)) return remote;
      } catch {
        for (const h of hostnames) {
          if (remote.url.includes(h)) return remote;
        }
      }
    }
  }

  return remotes.find((r) => r.name === "origin") ?? remotes[0];
}

export interface ResolveOptions {
  sessionName: string;
  dir: string;
  codeHost: CodeHostAdapter | null;
  issueTracker: IssueTrackerAdapter | null;
}

export async function resolveSessionContext(
  opts: ResolveOptions,
): Promise<SessionContext> {
  const { sessionName, dir, codeHost, issueTracker } = opts;
  const base: SessionContext = {
    sessionName,
    dir,
    branch: null,
    remote: null,
    mr: null,
    issue: null,
    resolvedAt: Date.now(),
  };

  const branch = await getGitBranch(dir);
  if (!branch) return base;
  base.branch = branch;

  const remotes = await getGitRemotes(dir);
  const remote = selectRemote(remotes, codeHost?.type ?? null);
  if (!remote) return base;
  base.remote = remote.url;

  if (codeHost && codeHost.authState === "ok") {
    try {
      base.mr = await codeHost.getMergeRequest(remote.url, branch);
    } catch {}
  }

  if (issueTracker && issueTracker.authState === "ok") {
    try {
      if (base.mr) {
        base.issue = await issueTracker.getLinkedIssue(base.mr.webUrl);
      }
      if (!base.issue) {
        base.issue = await issueTracker.getIssueByBranch(branch);
      }
    } catch {}
  }

  return base;
}
