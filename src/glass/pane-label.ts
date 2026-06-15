import { basename } from "path";

export interface PaneLabelInput {
  sessionName: string;
  paneTitle: string;
  paneCurrentCommand: string;
  paneCurrentPath: string;
}

/**
 * Human label for a pinned pane, shown in the tile border and the sidebar's
 * Overview children. Prefers the pane title (programs like Claude set it);
 * otherwise "command · cwd-basename" disambiguates two node/bun panes in one
 * session.
 */
export function buildPaneLabel(input: PaneLabelInput): string {
  const { sessionName, paneTitle, paneCurrentCommand, paneCurrentPath } = input;
  const title = paneTitle.trim();
  if (title) return `${sessionName} › ${title}`;
  const base = basename(paneCurrentPath);
  const suffix = base && base !== "/" ? `${paneCurrentCommand} · ${base}` : paneCurrentCommand;
  return `${sessionName} › ${suffix}`;
}
