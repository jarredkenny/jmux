import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import type { AdapterConfig } from "./adapters/types";
import type { PanelView } from "./panel-view";
import { logError } from "./log";

export interface IssueWorkflowConfig {
  teamRepoMap?: Record<string, string>;  // Linear team name → repo directory
  defaultBaseBranch?: string;             // default: "main"
  autoCreateWorktree?: boolean;           // default: true
  autoLaunchAgent?: boolean;              // default: true — launch claude with issue context
  sessionNameTemplate?: string;           // default: "{identifier}" — supports {identifier}, {title}
}

export interface JmuxConfig {
  sidebarWidth?: number;
  infoPanelWidth?: number;
  claudeCommand?: string;
  cacheTimers?: boolean;
  pinnedSessions?: string[];
  projectDirs?: string[];
  wtmIntegration?: boolean;
  diffPanel?: {
    splitRatio?: number;
    hunkCommand?: string;
  };
  adapters?: AdapterConfig;
  panelViews?: PanelView[];
  issueWorkflow?: IssueWorkflowConfig;
}

/**
 * tmux silently rewrites '.' and ':' in session names to '_'. If we let them
 * through, the session is created under the rewritten name but follow-up
 * commands like `switch-client -t name` parse '.' / ':' as window/pane
 * separators and fail with a misleading "can't find pane: X" error. Mirror
 * tmux's sanitization here so callers and tmux agree on the final name.
 */
export function sanitizeTmuxSessionName(name: string): string {
  return name.replace(/[.:]/g, "_");
}

/**
 * Build the OTEL_RESOURCE_ATTRIBUTES value for a given tmux session name.
 */
export function buildOtelResourceAttrs(sessionName: string): string {
  return `tmux_session_name=${sessionName}`;
}

const DEFAULT_CONFIG_PATH = resolve(homedir(), ".config", "jmux", "config.json");

/**
 * Load jmux user config from ~/.config/jmux/config.json.
 * Returns an empty object if the file is missing or unparseable.
 */
export function loadUserConfig(configPath?: string): JmuxConfig {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8")) as JmuxConfig;
    }
  } catch {
    // Invalid config — use defaults
  }
  return {};
}

/**
 * Centralized config store that owns both the in-memory config and
 * disk persistence. Eliminates the dual-state problem where some
 * settings updated in-memory while others only wrote to disk.
 */
export class ConfigStore {
  private data: JmuxConfig;
  private readonly path: string;

  constructor(configPath?: string) {
    this.path = configPath ?? DEFAULT_CONFIG_PATH;
    this.data = loadUserConfig(this.path);
  }

  /** Current in-memory config snapshot. */
  get config(): Readonly<JmuxConfig> {
    return this.data;
  }

  /** Path to the config file on disk. */
  get configPath(): string {
    return this.path;
  }

  /**
   * Set a top-level config key and persist to disk.
   * Updates in-memory state first, then writes to disk.
   */
  set<K extends keyof JmuxConfig>(key: K, value: JmuxConfig[K]): void {
    this.data[key] = value;
    this.persist();
  }

  /**
   * Delete a top-level config key and persist to disk.
   */
  delete<K extends keyof JmuxConfig>(key: K): void {
    delete this.data[key];
    this.persist();
  }

  /**
   * Merge a partial config into the current state and persist.
   * Shallow merge at the top level — nested objects are replaced, not deep-merged.
   */
  merge(partial: Partial<JmuxConfig>): void {
    Object.assign(this.data, partial);
    this.persist();
  }

  /**
   * Set a workflow setting (issueWorkflow sub-key) and persist.
   */
  setWorkflow<K extends keyof IssueWorkflowConfig>(key: K, value: IssueWorkflowConfig[K]): void {
    if (!this.data.issueWorkflow) this.data.issueWorkflow = {};
    this.data.issueWorkflow[key] = value;
    this.persist();
  }

  /**
   * Set or remove a team → repo mapping and persist.
   */
  setTeamRepo(team: string, repoDir: string | null): void {
    if (!this.data.issueWorkflow) this.data.issueWorkflow = {};
    if (!this.data.issueWorkflow.teamRepoMap) this.data.issueWorkflow.teamRepoMap = {};
    if (repoDir === null) {
      delete this.data.issueWorkflow.teamRepoMap[team];
    } else {
      this.data.issueWorkflow.teamRepoMap[team] = repoDir;
    }
    this.persist();
  }

  /**
   * Set an adapter config entry (codeHost or issueTracker) and persist.
   * Pass null to remove the entry.
   */
  setAdapter(key: "codeHost" | "issueTracker", value: { type: string } | null): void {
    if (!this.data.adapters) this.data.adapters = {};
    if (value === null) {
      delete this.data.adapters[key];
    } else {
      this.data.adapters[key] = value;
    }
    // Clean up empty adapters object
    if (this.data.adapters && Object.keys(this.data.adapters).length === 0) {
      delete this.data.adapters;
    }
    this.persist();
  }

  /**
   * Upsert a panel view and persist.
   */
  saveView(view: PanelView): void {
    if (!this.data.panelViews) this.data.panelViews = [];
    const idx = this.data.panelViews.findIndex(v => v.id === view.id);
    if (idx >= 0) {
      this.data.panelViews[idx] = view;
    } else {
      this.data.panelViews.push(view);
    }
    this.persist();
  }

  /**
   * Reload config from disk. Used by file watchers to pick up
   * external changes. Returns the new config.
   */
  reload(): JmuxConfig {
    this.data = loadUserConfig(this.path);
    return this.data;
  }

  /**
   * Ensure the config file exists (for first-run).
   * Creates the directory and an empty JSON file if needed.
   */
  ensureExists(): boolean {
    if (existsSync(this.path)) return false;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify({}, null, 2) + "\n");
    return true;
  }

  private persist(): void {
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n");
    } catch (e) {
      logError("ConfigStore", `persist failed: ${(e as Error).message}`);
    }
  }
}
