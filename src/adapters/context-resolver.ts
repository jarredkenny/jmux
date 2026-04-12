import type {
  CodeHostAdapter,
  IssueTrackerAdapter,
  SessionContext,
  MergeRequest,
  Issue,
  LinkSource,
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
  manualIssueIds: string[];
  manualMrIds: string[];
}

const MAX_MRS = 10;
const MAX_ISSUES = 10;

type TaggedMr = MergeRequest & { source: LinkSource };
type TaggedIssue = Issue & { source: LinkSource };

const SOURCE_PRIORITY: Record<LinkSource, number> = {
  manual: 0,
  branch: 1,
  "mr-link": 2,
  transitive: 3,
};

function deduplicateMrs(mrs: TaggedMr[]): TaggedMr[] {
  const seen = new Map<string, TaggedMr>();
  for (const mr of mrs) {
    const existing = seen.get(mr.id);
    if (!existing || SOURCE_PRIORITY[mr.source] < SOURCE_PRIORITY[existing.source]) {
      seen.set(mr.id, mr);
    }
  }
  return [...seen.values()];
}

function deduplicateIssues(issues: TaggedIssue[]): TaggedIssue[] {
  const seen = new Map<string, TaggedIssue>();
  for (const issue of issues) {
    const existing = seen.get(issue.id);
    if (!existing || SOURCE_PRIORITY[issue.source] < SOURCE_PRIORITY[existing.source]) {
      seen.set(issue.id, issue);
    }
  }
  return [...seen.values()];
}

export async function resolveSessionContext(
  opts: ResolveOptions,
): Promise<SessionContext> {
  const { sessionName, dir, codeHost, issueTracker, manualIssueIds, manualMrIds } = opts;
  const mrs: TaggedMr[] = [];
  const issues: TaggedIssue[] = [];

  // Step 1-2: Git state + branch auto-discovery
  const branch = await getGitBranch(dir);
  const remotes = branch ? await getGitRemotes(dir) : [];
  const remote = selectRemote(remotes, codeHost?.type ?? null);

  if (branch && remote && codeHost && codeHost.authState === "ok") {
    try {
      const mr = await codeHost.getMergeRequest(remote.url, branch);
      if (mr) mrs.push({ ...mr, source: "branch" });
    } catch {}
  }

  if (branch && issueTracker && issueTracker.authState === "ok") {
    try {
      const issue = await issueTracker.getIssueByBranch(branch);
      if (issue) issues.push({ ...issue, source: "branch" });
    } catch {}
  }

  // Step 3: Resolve manual issue links
  if (issueTracker && issueTracker.authState === "ok") {
    for (const id of manualIssueIds) {
      if (issues.length >= MAX_ISSUES) break;
      try {
        const issue = await issueTracker.pollIssue(id);
        if (issue) issues.push({ ...issue, source: "manual" });
      } catch {}
    }
  }

  // Step 4: Resolve manual MR links
  if (codeHost && codeHost.authState === "ok" && manualMrIds.length > 0) {
    try {
      const resolved = await codeHost.pollMergeRequestsByIds(manualMrIds);
      for (const [_id, mr] of resolved) {
        if (mrs.length >= MAX_MRS) break;
        mrs.push({ ...mr, source: "manual" });
      }
    } catch {}
  }

  // Step 5: Forward links — MR → linked issues
  if (issueTracker && issueTracker.authState === "ok") {
    const mrsCopy = [...mrs];
    for (const mr of mrsCopy) {
      if (issues.length >= MAX_ISSUES) break;
      try {
        const linked = await issueTracker.getLinkedIssue(mr.webUrl);
        if (linked) issues.push({ ...linked, source: "mr-link" });
      } catch {}
    }
  }

  // Step 6: Transitive links — issue → MR URLs
  if (codeHost && codeHost.authState === "ok") {
    const issuesCopy = [...issues];
    for (const issue of issuesCopy) {
      if (mrs.length >= MAX_MRS) break;
      for (const mrUrl of issue.linkedMrUrls) {
        if (mrs.length >= MAX_MRS) break;
        const mrId = codeHost.parseMrUrl(mrUrl);
        if (!mrId) continue;
        try {
          const mr = await codeHost.pollMergeRequest(mrId);
          if (mr) mrs.push({ ...mr, source: "transitive" });
        } catch {}
      }
    }
  }

  return {
    sessionName,
    dir,
    branch: branch ?? null,
    remote: remote?.url ?? null,
    mrs: deduplicateMrs(mrs),
    issues: deduplicateIssues(issues),
    resolvedAt: Date.now(),
  };
}
