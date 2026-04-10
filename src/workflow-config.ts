// src/workflow-config.ts
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface WorkflowConfig {
  project: string;
  description?: string;
  tickets?: {
    linear?: {
      team?: string;
      projects?: string[];
    };
  };
  setup?: {
    worktree?: boolean;
    base_branch?: string;
    naming?: string;
  };
  agent?: {
    context?: string;
    instructions?: string;
    skill?: string;
  };
  merge_request?: {
    target_branch?: string;
  };
}

export function loadWorkflowConfig(projectDir: string): WorkflowConfig | null {
  const filePath = resolve(projectDir, ".jmux", "workflow.yml");
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const config = parseSimpleYaml(raw);
    if (!config.project) return null; // require at minimum a project field
    return config;
  } catch {
    return null;
  }
}

export interface DiscoveredWorkflow {
  dir: string;
  config: WorkflowConfig;
  raw: string;
}

export function discoverWorkflowConfigs(projectDirs: string[]): DiscoveredWorkflow[] {
  const results: DiscoveredWorkflow[] = [];
  for (const dir of projectDirs) {
    const filePath = resolve(dir, ".jmux", "workflow.yml");
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const config = parseSimpleYaml(raw);
      if (config && config.project) {
        results.push({ dir, config, raw });
      }
    } catch {
      // Skip invalid configs
    }
  }
  return results;
}

export function matchTicketToProject(
  ticketId: string,
  configs: { dir: string; config: WorkflowConfig }[],
  teamName?: string,
): { dir: string; config: WorkflowConfig } | null {
  const prefix = ticketId.replace(/-\d+$/, ""); // "MYAPP-123" → "MYAPP"

  for (const entry of configs) {
    const linear = entry.config.tickets?.linear;
    if (!linear) continue;

    // Match by project prefix
    if (linear.projects?.includes(prefix)) {
      return entry;
    }

    // Match by team name
    if (teamName && linear.team === teamName) {
      return entry;
    }
  }

  return null;
}

/**
 * Minimal YAML parser for workflow configs. Handles the flat/shallow
 * structure we need without pulling in a full YAML library.
 * Supports: scalars, simple inline arrays ([a, b]), nested objects (2 levels).
 */
function parseSimpleYaml(raw: string): WorkflowConfig {
  const lines = raw.split("\n");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {};
  let currentSection: string | null = null;
  let currentSubSection: string | null = null;

  for (const line of lines) {
    if (line.trim().startsWith("#") || line.trim() === "") continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0 && trimmed.includes(":")) {
      const colonIdx = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      currentSection = key;
      currentSubSection = null;
      if (value) {
        result[currentSection] = parseYamlValue(value);
      } else {
        result[currentSection] = result[currentSection] ?? {};
      }
    } else if (indent === 2 && trimmed.includes(":") && currentSection) {
      const colonIdx = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      currentSubSection = key;
      if (typeof result[currentSection] !== "object" || result[currentSection] === null) {
        result[currentSection] = {};
      }
      if (value) {
        result[currentSection][currentSubSection] = parseYamlValue(value);
      } else {
        result[currentSection][currentSubSection] = {};
      }
    } else if (indent === 4 && trimmed.includes(":") && currentSection && currentSubSection) {
      const colonIdx = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (typeof result[currentSection][currentSubSection] !== "object" || result[currentSection][currentSubSection] === null) {
        result[currentSection][currentSubSection] = {};
      }
      result[currentSection][currentSubSection][key] = parseYamlValue(value);
    }
  }

  // Handle block scalars (|) — for agent.context and agent.instructions
  const blockPattern = /^(\s*)(\w+):\s*\|\s*$/gm;
  let match;
  while ((match = blockPattern.exec(raw)) !== null) {
    const keyIndent = match[1].length;
    const key = match[2];
    const startIdx = match.index + match[0].length + 1;
    const blockLines: string[] = [];
    const remaining = raw.slice(startIdx).split("\n");
    for (const bline of remaining) {
      if (bline.trim() === "") { blockLines.push(""); continue; }
      const bi = bline.length - bline.trimStart().length;
      if (bi > keyIndent) {
        // Strip the key's indent + 2 (standard YAML block indent)
        blockLines.push(bline.slice(keyIndent + 2));
      } else {
        break;
      }
    }
    // Place the block scalar value in the correct section
    if (keyIndent === 0) {
      result[key] = blockLines.join("\n").trimEnd();
    } else if (keyIndent === 2) {
      for (const section of Object.keys(result)) {
        if (typeof result[section] === "object" && result[section] !== null && key in result[section]) {
          result[section][key] = blockLines.join("\n").trimEnd();
        }
      }
    } else if (keyIndent === 4) {
      for (const section of Object.keys(result)) {
        if (typeof result[section] !== "object" || result[section] === null) continue;
        for (const sub of Object.keys(result[section])) {
          if (typeof result[section][sub] === "object" && result[section][sub] !== null && key in result[section][sub]) {
            result[section][sub][key] = blockLines.join("\n").trimEnd();
          }
        }
      }
    }
  }

  return result as WorkflowConfig;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseYamlValue(value: string): any {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  // Inline array: ["a", "b"] or [a, b]
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map(s => {
      const t = s.trim();
      return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
        ? t.slice(1, -1)
        : t;
    });
  }
  // Quoted string
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
