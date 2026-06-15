/**
 * Auto-detection of agent panes for the Command Center. When the user enables
 * "Auto-pin agent panes", every Claude/Codex pane is surfaced on the grid
 * without a manual pin. Detection is best-effort from two signals:
 *
 *  1. The pane is the **active** pane of a session that has `@jmux-agent-state`
 *     set — this catches Claude (its hooks set the session agent-state), even
 *     though `@jmux-agent-pane` is often unpopulated.
 *  2. The pane's `pane_current_command` matches a configurable regex — this
 *     catches Codex (and anything else the user configures), independent of the
 *     jmux hooks.
 */

const US = "\x1f";

/** `list-panes -a -F` format that feeds {@link parseAgentDetectLines}. */
export const AGENT_DETECT_FORMAT = [
  "#{pane_id}",
  "#{@jmux-agent-state}",
  "#{pane_active}",
  "#{pane_current_command}",
].join(US);

export interface AgentPaneRow {
  paneId: string;
  /** The pane's session `@jmux-agent-state` (inherited), "" if none. */
  agentState: string;
  active: boolean;
  command: string;
}

export function parseAgentDetectLines(lines: string[]): AgentPaneRow[] {
  const out: AgentPaneRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const [paneId, agentState, active, command] = line.split(US);
    if (!paneId) continue;
    out.push({
      paneId,
      agentState: agentState ?? "",
      active: active === "1",
      command: command ?? "",
    });
  }
  return out;
}

/**
 * The set of pane ids that should be auto-surfaced on the Command Center.
 * `commandRegex` is matched case-insensitively against `pane_current_command`;
 * an invalid or empty pattern simply disables the command-match signal.
 */
export function detectAgentPanes(
  rows: AgentPaneRow[],
  commandRegex: string | null,
): Set<string> {
  let re: RegExp | null = null;
  if (commandRegex) {
    try {
      re = new RegExp(commandRegex, "i");
    } catch {
      re = null;
    }
  }
  const out = new Set<string>();
  for (const r of rows) {
    const agentSessionActive = r.agentState !== "" && r.active;
    const commandMatch = re !== null && r.command !== "" && re.test(r.command);
    if (agentSessionActive || commandMatch) out.add(r.paneId);
  }
  return out;
}
