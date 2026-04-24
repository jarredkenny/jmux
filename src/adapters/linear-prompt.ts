import type { Issue } from "./types";

type IssueComment = NonNullable<Issue["comments"]>[number];

export function buildLinearPrompt(issue: Issue): string {
  const out: string[] = [];
  out.push(`Work on Linear issue ${issue.identifier}:`);
  out.push("");
  out.push(`<issue identifier="${issue.identifier}">`);
  out.push(`<title>${issue.title}</title>`);
  if (issue.description && issue.description.trim().length > 0) {
    out.push("<description>");
    out.push(issue.description);
    out.push("</description>");
  }
  if (issue.team) out.push(`<team name="${issue.team}"/>`);
  for (const label of issue.labels ?? []) {
    const text = label.group ? `${label.group} › ${label.name}` : label.name;
    out.push(`<label>${text}</label>`);
  }
  if (issue.project) out.push(`<project name="${issue.project}"/>`);
  out.push("</issue>");

  for (const thread of groupThreads(issue.comments ?? [])) {
    out.push("");
    out.push(renderThread(thread));
  }

  return out.join("\n");
}

interface Thread {
  rootId: string | null;
  comments: IssueComment[];
}

function groupThreads(comments: IssueComment[]): Thread[] {
  const byId = new Map<string, IssueComment>();
  for (const c of comments) {
    if (c.id) byId.set(c.id, c);
  }
  const threads = new Map<string, Thread>();
  const order: string[] = [];
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    let rootKey: string;
    let rootId: string | null;
    if (c.id) {
      let cursor: IssueComment = c;
      while (cursor.parentId && byId.has(cursor.parentId)) {
        cursor = byId.get(cursor.parentId)!;
      }
      rootId = cursor.id ?? null;
      rootKey = rootId ?? `__root_${i}`;
    } else {
      // No id available (e.g., demo data) — treat each comment as its own thread.
      rootId = null;
      rootKey = `__noid_${i}`;
    }
    let thread = threads.get(rootKey);
    if (!thread) {
      thread = { rootId, comments: [] };
      threads.set(rootKey, thread);
      order.push(rootKey);
    }
    thread.comments.push(c);
  }
  return order.map((k) => threads.get(k)!);
}

function renderThread(thread: Thread): string {
  const openAttr = thread.rootId ? ` comment-id="${thread.rootId}"` : "";
  const open = `<comment-thread${openAttr}>`;
  const close = `</comment-thread>`;
  const isSingleInline =
    thread.comments.length === 1 && !thread.comments[0].body.includes("\n");
  if (isSingleInline) {
    return `${open}${renderComment(thread.comments[0])}${close}`;
  }
  const lines: string[] = [open];
  for (const c of thread.comments) {
    lines.push(renderComment(c));
  }
  lines.push(close);
  return lines.join("\n");
}

function renderComment(c: IssueComment): string {
  const open = `<comment author="${c.author}" created-at="${c.createdAt}">`;
  const close = `</comment>`;
  if (c.body.includes("\n")) {
    return `${open}\n${c.body}\n${close}`;
  }
  return `${open}${c.body}${close}`;
}
