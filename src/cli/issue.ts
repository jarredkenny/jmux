import { resolve, dirname, basename } from "path";
import { homedir, tmpdir } from "os";
import { existsSync, writeFileSync } from "fs";
import { runTmuxDirect } from "./tmux";
import { tmuxOrThrow, CliError, type CliContext } from "./context";
import {
  sanitizeTmuxSessionName,
  buildOtelResourceAttrs,
  loadUserConfig,
  type JmuxConfig,
} from "../config";
import { LinearAdapter } from "../adapters/linear";
import { buildLinearPrompt } from "../adapters/linear-prompt";
import { buildClaudeLaunchCommand } from "./run-claude";
import { US } from "./agent";
import type { Issue } from "../adapters/types";
import type { ParsedCtlArgs } from "../cli";

// --- Tmux-option-backed issue↔session links ----------------------------------
//
// Links live as tmux session user options (spec §8.6): server-side, race-free
// against the running TUI's in-memory SessionState, and discoverable via
// `tmux show-options -t <session> | grep @jmux-`.
//
//   @jmux-linear-issue   the linked issue identifier (e.g. TRA-123)
//   @jmux-repo-path      the repo the session's worktree belongs to

export interface IssueLinkRow {
  id: string;
  name: string;
  issue: string;
  path: string;
}

const ISSUE_LINK_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{@jmux-linear-issue}",
  "#{pane_current_path}",
].join(US);

export function parseIssueLinkRow(line: string): IssueLinkRow | null {
  const p = line.split(US);
  if (p.length < 4) return null;
  return { id: p[0], name: p[1], issue: p[2], path: p[3] };
}

export function findSessionForIssue(
  rows: IssueLinkRow[],
  issueId: string,
): IssueLinkRow | null {
  return rows.find((r) => r.issue === issueId) ?? null;
}

export type LinkDecision =
  | { kind: "ok" }
  | { kind: "noop" }
  | { kind: "error"; message: string };

/**
 * Pure decision for `issue link`, enforcing the strict 1:1 invariant
 * (spec §2.2 / §8.2):
 * - target session must exist;
 * - the issue must not already be linked to a *different* session;
 * - the session must not already be linked to a *different* issue;
 * - re-linking the same pair is a no-op (idempotent).
 */
export function decideIssueLink(
  rows: IssueLinkRow[],
  session: string,
  issueId: string,
): LinkDecision {
  const target = rows.find((r) => r.name === session);
  if (!target) return { kind: "error", message: `session "${session}" not found` };

  const other = rows.find((r) => r.issue === issueId && r.name !== session);
  if (other) {
    return {
      kind: "error",
      message: `issue "${issueId}" already linked to session "${other.name}"`,
    };
  }

  if (target.issue && target.issue !== issueId) {
    return {
      kind: "error",
      message: `session "${session}" already linked to issue "${target.issue}"; unlink first`,
    };
  }

  if (target.issue === issueId) return { kind: "noop" };
  return { kind: "ok" };
}

// --- Pure helpers for `issue start` ------------------------------------------

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * Branch/session name for an issue. The tracker's suggested `branchName` wins
 * when present; otherwise `<issueId>-<title-slug>`, falling back to the bare
 * issue id. Always normalized through `sanitizeTmuxSessionName`.
 */
export function computeBranchName(issueId: string, issue: Issue | null): string {
  if (issue?.branchName) return sanitizeTmuxSessionName(issue.branchName);
  const slug = issue?.title ? slugify(issue.title) : "";
  const raw = slug ? `${issueId}-${slug}` : issueId;
  return sanitizeTmuxSessionName(raw);
}

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Deterministic sibling worktree location:
 *   <repoParent>/<repoBasename>-worktrees/<branchName>
 * Deterministic so we never parse opaque `wtm` output, and outside the repo so
 * git doesn't reject a worktree nested in the main working tree.
 */
export function computeWorktreePath(repo: string, branchName: string): string {
  return resolve(dirname(repo), `${basename(repo)}-worktrees`, branchName);
}

/**
 * Repo for an issue: explicit `--repo` wins, else `issueWorkflow.teamRepoMap`
 * keyed by the issue's team. Returns null when nothing resolves — the caller
 * turns that into an actionable error rather than guessing.
 */
export function resolveRepoForIssue(
  flags: ParsedCtlArgs["flags"],
  issue: Issue | null,
  config: JmuxConfig,
): string | null {
  if (typeof flags.repo === "string") return expandTilde(flags.repo);
  const team = issue?.team;
  const map = config.issueWorkflow?.teamRepoMap ?? {};
  if (team && map[team]) return expandTilde(map[team]);
  return null;
}

// --- Handlers ----------------------------------------------------------------

export async function handleIssue(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<unknown> {
  const { action } = parsed;
  switch (action) {
    case "get":
      return await issueGet(parsed);
    case "link":
      return issueLink(ctx, parsed);
    case "unlink":
      return issueUnlink(ctx, parsed);
    case "start":
      return await issueStart(ctx, parsed);
    default:
      throw new CliError(
        `Unknown issue action "${action}". Known actions: get, link, unlink, start`,
      );
  }
}

async function fetchIssue(issueId: string): Promise<Issue | null> {
  const adapter = new LinearAdapter({});
  await adapter.authenticate();
  if (adapter.authState !== "ok") {
    throw new CliError(
      "Linear is not configured: set LINEAR_API_KEY or LINEAR_TOKEN",
    );
  }
  // getIssueByBranch extracts the identifier from the string and resolves it.
  return await adapter.getIssueByBranch(issueId);
}

async function issueGet(parsed: ParsedCtlArgs): Promise<unknown> {
  const issueId = parsed.positional[0];
  if (!issueId) throw new CliError("issue get requires an <issue-id>");
  const issue = await fetchIssue(issueId);
  if (!issue) throw new CliError(`issue "${issueId}" not found`);
  return { issue };
}

function listIssueLinkRows(ctx: CliContext): IssueLinkRow[] {
  const result = runTmuxDirect(
    ["list-sessions", "-F", ISSUE_LINK_FORMAT],
    ctx.socket,
  );
  const lines = result.ok ? result.lines : [];
  return lines
    .map(parseIssueLinkRow)
    .filter((r): r is IssueLinkRow => r !== null);
}

function findGitRoot(path: string): string | null {
  if (!path) return null;
  try {
    const r = Bun.spawnSync(["git", "-C", path, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((r.exitCode ?? 1) !== 0) return null;
    const root = r.stdout.toString().trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

function issueLink(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const session = parsed.positional[0];
  const issueId = parsed.positional[1];
  if (!session || !issueId) {
    throw new CliError("issue link requires <session> <issue-id>");
  }

  const rows = listIssueLinkRows(ctx);
  const decision = decideIssueLink(rows, session, issueId);
  if (decision.kind === "error") throw new CliError(decision.message);

  // ok and noop both (re)assert the option — set-option is idempotent.
  tmuxOrThrow(
    runTmuxDirect(
      ["set-option", "-t", session, "@jmux-linear-issue", issueId],
      ctx.socket,
    ),
  );

  // Best-effort repo discovery from the session's working directory.
  let repoPath: string | null = null;
  const target = rows.find((r) => r.name === session);
  const gitRoot = target ? findGitRoot(target.path) : null;
  if (gitRoot) {
    repoPath = gitRoot;
    runTmuxDirect(
      ["set-option", "-t", session, "@jmux-repo-path", gitRoot],
      ctx.socket,
    );
  }

  return { session, issue: issueId, repo: repoPath, linked: true };
}

function issueUnlink(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  const session = parsed.positional[0];
  if (!session) throw new CliError("issue unlink requires <session>");

  const rows = listIssueLinkRows(ctx);
  const target = rows.find((r) => r.name === session);
  if (!target) throw new CliError(`session "${session}" not found`);

  // Idempotent: -u on an unset option is a no-op.
  runTmuxDirect(["set-option", "-t", session, "-u", "@jmux-linear-issue"], ctx.socket);
  runTmuxDirect(["set-option", "-t", session, "-u", "@jmux-repo-path"], ctx.socket);

  return { session, unlinked: true };
}

function activePane(ctx: CliContext, session: string): string | null {
  const r = runTmuxDirect(
    ["display-message", "-t", session, "-p", "#{pane_id}"],
    ctx.socket,
  );
  return r.ok && r.lines.length > 0 ? r.lines[0] : null;
}

function createWorktree(
  repo: string,
  worktreePath: string,
  branch: string,
  base: string,
): void {
  // Idempotent: an existing worktree directory is reused as-is.
  if (existsSync(worktreePath)) return;

  const verify = Bun.spawnSync(
    ["git", "-C", repo, "rev-parse", "--verify", "--quiet", branch],
    { stdout: "ignore", stderr: "ignore" },
  );
  const branchExists = (verify.exitCode ?? 1) === 0;

  const args = branchExists
    ? ["-C", repo, "worktree", "add", worktreePath, branch]
    : ["-C", repo, "worktree", "add", "-b", branch, worktreePath, base];

  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if ((r.exitCode ?? 1) !== 0) {
    throw new CliError(`git worktree add failed: ${r.stderr.toString().trim()}`);
  }
}

async function issueStart(
  ctx: CliContext,
  parsed: ParsedCtlArgs,
): Promise<unknown> {
  const issueId = parsed.positional[0];
  if (!issueId) throw new CliError("issue start requires an <issue-id>");
  const { flags } = parsed;

  // Idempotency: if a session is already linked to this issue, return it.
  const existing = findSessionForIssue(listIssueLinkRows(ctx), issueId);
  if (existing) {
    return {
      session: existing.name,
      pane: activePane(ctx, existing.name),
      cwd: existing.path || null,
      issue: issueId,
      reused: true,
    };
  }

  const config = loadUserConfig();

  // Fetch issue when Linear is configured — needed for the team→repo mapping,
  // the branch name, and the launch prompt. Tolerate an unconfigured tracker as
  // long as --repo is supplied.
  let issue: Issue | null = null;
  const adapter = new LinearAdapter({});
  await adapter.authenticate();
  if (adapter.authState === "ok") {
    issue = await adapter.getIssueByBranch(issueId);
    // Tracker is configured but the id resolves to nothing — almost certainly a
    // typo. Refuse rather than silently create a worktree + launch Claude with
    // no prompt for a nonexistent issue. Offline mode (no tracker configured)
    // is the only path that proceeds without a resolved issue, and it requires
    // an explicit --repo.
    if (!issue) {
      throw new CliError(
        `issue "${issueId}" not found in Linear — refusing to start work for an unknown issue`,
      );
    }
  }

  const repo = resolveRepoForIssue(flags, issue, config);
  if (!repo) {
    throw new CliError(
      `could not resolve a repo for "${issueId}". Pass --repo <path> or configure issueWorkflow.teamRepoMap.`,
    );
  }
  if (!existsSync(repo)) {
    throw new CliError(`repo path does not exist: ${repo}`);
  }

  const branchName = computeBranchName(issueId, issue);
  const sessionName = sanitizeTmuxSessionName(branchName);
  const baseBranch =
    typeof flags["base-branch"] === "string"
      ? flags["base-branch"]
      : config.issueWorkflow?.defaultBaseBranch ?? "main";
  const worktreePath = computeWorktreePath(repo, branchName);

  createWorktree(repo, worktreePath, branchName, baseBranch);

  // Build the (optional) Claude launch command.
  const launchAgent = !flags["no-launch-agent"];
  let launchCmd: string | null = null;
  if (launchAgent) {
    const claudeCmd = config.claudeCommand ?? "claude";
    const shell = process.env.SHELL ?? "/bin/sh";
    let promptFile: string | null = null;
    if (issue) {
      const prompt = buildLinearPrompt(issue);
      const rand = Math.random().toString(36).slice(2);
      promptFile = resolve(tmpdir(), `jmux-prompt-${Date.now()}-${rand}`);
      writeFileSync(promptFile, prompt, "utf-8");
    }
    launchCmd = buildClaudeLaunchCommand(claudeCmd, promptFile, shell);
  }

  const otel = buildOtelResourceAttrs(sessionName);
  const createArgs = [
    "new-session",
    "-d",
    "-e",
    `OTEL_RESOURCE_ATTRIBUTES=${otel}`,
    "-s",
    sessionName,
    "-c",
    worktreePath,
  ];
  if (launchCmd) createArgs.push(launchCmd);
  tmuxOrThrow(runTmuxDirect(createArgs, ctx.socket));

  // Link the new session to the issue.
  runTmuxDirect(
    ["set-option", "-t", sessionName, "@jmux-linear-issue", issueId],
    ctx.socket,
  );
  runTmuxDirect(
    ["set-option", "-t", sessionName, "@jmux-repo-path", repo],
    ctx.socket,
  );

  return {
    session: sessionName,
    pane: activePane(ctx, sessionName),
    cwd: worktreePath,
    issue: issueId,
    reused: false,
  };
}
