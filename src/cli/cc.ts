import { runTmuxDirect } from "./tmux";
import { tmuxOrThrow, CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";
import { loadUserConfig } from "../config";
import { normalizeTabs, resolveTabId, type TabEntry } from "../glass/tabs";
import { parsePinnedListWithTab, PINNED_LIST_FORMAT } from "./pane";

export interface TabSummary {
  id: string;
  name: string;
  order: number;
  count: number;
}

/** Pure reducer: tab registry + raw pin pairs → per-tab summaries with counts. */
export function buildTabSummaries(
  tabs: TabEntry[],
  pins: ReadonlyArray<{ id: string; tab: string }>,
): TabSummary[] {
  const counts = new Map<string, number>();
  for (const t of tabs) counts.set(t.id, 0);
  for (const p of pins) {
    const resolved = resolveTabId(p.tab, tabs);
    counts.set(resolved, (counts.get(resolved) ?? 0) + 1);
  }
  return tabs.map((t, order) => ({ id: t.id, name: t.name, order, count: counts.get(t.id) ?? 0 }));
}

/** Load the normalized tab registry from the user config on disk. */
export function loadTabRegistry(): TabEntry[] {
  return normalizeTabs(loadUserConfig().commandCenterTabs);
}

export function handleCc(ctx: CliContext, parsed: ParsedCtlArgs): unknown {
  switch (parsed.action) {
    case "tabs": {
      const tabs = loadTabRegistry();
      const lines = tmuxOrThrow(
        runTmuxDirect(["list-panes", "-a", "-F", PINNED_LIST_FORMAT], ctx.socket),
      );
      const pins = parsePinnedListWithTab(lines);
      return { tabs: buildTabSummaries(tabs, pins) };
    }
    default:
      throw new CliError(
        `Unknown cc action "${parsed.action}". Known actions: tabs`,
      );
  }
}
