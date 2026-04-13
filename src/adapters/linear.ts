// src/adapters/linear.ts
import type { IssueTrackerAdapter, AdapterAuthState, Issue } from "./types";

const LINEAR_API = "https://api.linear.app/graphql";

// Shared GraphQL fields for issue queries
const ISSUE_FIELDS = `id identifier title description branchName state { name } assignee { name } team { name } project { name } priority updatedAt attachments { nodes { title url sourceType } } comments(first: 20) { nodes { body user { name } createdAt } } url`;

export function extractIssueIdFromBranch(branch: string): string | null {
  const match = branch.match(/(?:^|\/?)([a-zA-Z]+-\d+)/);
  if (!match) return null;
  return match[1].toUpperCase();
}

export class LinearAdapter implements IssueTrackerAdapter {
  type = "linear";
  authState: AdapterAuthState = "unauthenticated";
  authHint = "$LINEAR_API_KEY or $LINEAR_TOKEN";
  private token: string | null = null;

  constructor(_config: Record<string, unknown>) {}

  async authenticate(): Promise<void> {
    const token = process.env.LINEAR_API_KEY ?? process.env.LINEAR_TOKEN ?? null;
    if (!token) { this.authState = "failed"; return; }
    this.token = token;
    this.authState = "ok";
  }

  async getLinkedIssue(mrUrl: string): Promise<Issue | null> {
    const query = `query($url: String!) { attachments(filter: { url: { eq: $url } }, first: 1) { nodes { issue { ${ISSUE_FIELDS} } } } }`;
    const resp = await this.graphql(query, { url: mrUrl });
    if (!resp) return null;
    const nodes = resp.data?.attachments?.nodes;
    if (!nodes || nodes.length === 0) return null;
    return this.mapIssue(nodes[0].issue);
  }

  async getIssueByBranch(branch: string): Promise<Issue | null> {
    const identifier = extractIssueIdFromBranch(branch);
    if (!identifier) return null;
    const query = `query($identifier: String!) { issueSearch(query: $identifier, first: 1) { nodes { ${ISSUE_FIELDS} } } }`;
    const resp = await this.graphql(query, { identifier });
    if (!resp) return null;
    const nodes = resp.data?.issueSearch?.nodes;
    if (!nodes || nodes.length === 0) return null;
    const issue = nodes[0];
    if (issue.identifier?.toUpperCase() !== identifier) return null;
    return this.mapIssue(issue);
  }

  async pollIssue(issueId: string): Promise<Issue> {
    const query = `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
    const resp = await this.graphql(query, { id: issueId });
    if (!resp?.data?.issue) {
      const err = new Error("Issue not found");
      (err as any).status = 404;
      throw err;
    }
    return this.mapIssue(resp.data.issue);
  }

  async pollAllIssues(issueIds: string[]): Promise<Map<string, Issue>> {
    const result = new Map<string, Issue>();
    if (issueIds.length === 0) return result;
    const varDefs = issueIds.map((_, i) => `$id${i}: String!`).join(", ");
    const fragments = issueIds.map(
      (_, i) =>
        `issue${i}: issue(id: $id${i}) { ${ISSUE_FIELDS} }`
    );
    const variables: Record<string, unknown> = {};
    issueIds.forEach((id, i) => { variables[`id${i}`] = id; });
    const query = `query(${varDefs}) { ${fragments.join("\n")} }`;
    const resp = await this.graphql(query, variables);
    if (!resp?.data) return result;
    for (let i = 0; i < issueIds.length; i++) {
      const raw = resp.data[`issue${i}`];
      if (raw) result.set(issueIds[i], this.mapIssue(raw));
    }
    return result;
  }

  async getAvailableStatuses(issueId: string): Promise<string[]> {
    const query = `query($id: String!) { issue(id: $id) { team { states { nodes { name position } } } } }`;
    const resp = await this.graphql(query, { id: issueId });
    if (!resp?.data?.issue?.team?.states?.nodes) return [];
    const states = resp.data.issue.team.states.nodes as Array<{ name: string; position: number }>;
    return states.sort((a, b) => a.position - b.position).map((s) => s.name);
  }

  openInBrowser(issueId: string): void {
    this.graphql(`query($id: String!) { issue(id: $id) { url } }`, { id: issueId }).then((resp) => {
      const url = resp?.data?.issue?.url;
      if (url) Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    });
  }

  async searchIssues(query: string): Promise<Issue[]> {
    if (this.authState !== "ok") return [];
    const gql = `
      query($query: String!) {
        issueSearch(query: $query, first: 20) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `;
    const resp = await this.graphql(gql, { query });
    if (!resp?.data?.issueSearch?.nodes) return [];
    return resp.data.issueSearch.nodes.map((n: any) => this.mapIssue(n));
  }

  async getMyIssues(): Promise<Issue[]> {
    if (this.authState !== "ok") return [];
    const query = `
      query {
        viewer {
          assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
            nodes { ${ISSUE_FIELDS} }
          }
        }
      }
    `;
    const resp = await this.graphql(query, {});
    if (!resp?.data?.viewer?.assignedIssues?.nodes) return [];
    return resp.data.viewer.assignedIssues.nodes.map((n: any) => this.mapIssue(n));
  }

  async getTeams(): Promise<Array<{ id: string; name: string }>> {
    if (this.authState !== "ok") return [];
    const query = `query { teams { nodes { id name } } }`;
    const resp = await this.graphql(query, {});
    if (!resp?.data?.teams?.nodes) return [];
    return resp.data.teams.nodes.map((t: any) => ({ id: t.id ?? "", name: t.name ?? "" }));
  }

  async updateStatus(issueId: string, status: string): Promise<void> {
    const statesQuery = `query($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`;
    const statesResp = await this.graphql(statesQuery, { id: issueId });
    const states = statesResp?.data?.issue?.team?.states?.nodes as
      | Array<{ id: string; name: string }>
      | undefined;
    if (!states) return;
    const targetState = states.find((s) => s.name === status);
    if (!targetState) return;
    const mutation = `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;
    await this.graphql(mutation, { id: issueId, stateId: targetState.id });
  }

  private mapIssue(raw: any): Issue {
    return {
      id: raw.id ?? "",
      identifier: raw.identifier ?? "",
      title: raw.title ?? "",
      status: raw.state?.name ?? "Unknown",
      assignee: raw.assignee?.name ?? null,
      linkedMrUrls: (raw.attachments?.nodes ?? [])
        .map((a: any) => a.url)
        .filter((u: string) => u && (u.includes("merge_requests") || u.includes("/pull/"))),
      webUrl: raw.url ?? "",
      team: raw.team?.name ?? undefined,
      project: raw.project?.name ?? undefined,
      priority: typeof raw.priority === "number" ? raw.priority : undefined,
      updatedAt: raw.updatedAt ? new Date(raw.updatedAt).getTime() : undefined,
      description: raw.description ?? undefined,
      branchName: raw.branchName ?? undefined,
      comments: (raw.comments?.nodes ?? []).map((c: any) => ({
        author: c.user?.name ?? "Unknown",
        body: c.body ?? "",
        createdAt: c.createdAt ?? "",
      })),
      links: (raw.attachments?.nodes ?? [])
        .filter((a: any) => a.url)
        .map((a: any) => ({
          type: a.sourceType ?? "",
          title: a.title ?? undefined,
          url: a.url,
        })),
    };
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>
  ): Promise<any | null> {
    try {
      const resp = await fetch(LINEAR_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.token ?? "",
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) this.authState = "failed";
        const err = new Error(`Linear API error: ${resp.status}`);
        (err as any).status = resp.status;
        throw err;
      }
      return await resp.json();
    } catch (e: any) {
      if (e?.status) throw e;
      return null;
    }
  }
}
