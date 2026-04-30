import type { AdapterConfig, CodeHostAdapter, IssueTrackerAdapter } from "./types";
import { GitLabAdapter } from "./gitlab";
import { GitHubAdapter } from "./github";
import { LinearAdapter } from "./linear";

export interface AdapterSet {
  codeHost: CodeHostAdapter | null;
  issueTracker: IssueTrackerAdapter | null;
}

export function createAdapters(config: AdapterConfig | undefined): AdapterSet {
  const result: AdapterSet = { codeHost: null, issueTracker: null };
  if (!config) return result;

  if (config.codeHost) {
    switch (config.codeHost.type) {
      case "gitlab":
        result.codeHost = new GitLabAdapter(config.codeHost);
        break;
      case "github":
        result.codeHost = new GitHubAdapter(config.codeHost);
        break;
    }
  }

  if (config.issueTracker) {
    switch (config.issueTracker.type) {
      case "linear":
        result.issueTracker = new LinearAdapter(config.issueTracker);
        break;
    }
  }

  return result;
}
