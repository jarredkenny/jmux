import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import type { AdapterConfig } from "./adapters/types";

export interface JmuxConfig {
  sidebarWidth?: number;
  claudeCommand?: string;
  cacheTimers?: boolean;
  pinnedSessions?: string[];
  diffPanel?: {
    splitRatio?: number;
    hunkCommand?: string;
  };
  adapters?: AdapterConfig;
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

/**
 * Load jmux user config from ~/.config/jmux/config.json.
 * Returns an empty object if the file is missing or unparseable.
 */
export function loadUserConfig(configPath?: string): JmuxConfig {
  const path = configPath ?? resolve(homedir(), ".config", "jmux", "config.json");
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8")) as JmuxConfig;
    }
  } catch {
    // Invalid config — use defaults
  }
  return {};
}
