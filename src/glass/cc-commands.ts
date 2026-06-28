import type { PaletteCommand, PaletteSublistOption } from "../types";
import type { TabEntry } from "./tabs";

export const NEW_TAB_OPTION_ID = "__new_tab__";

export interface CcCommandInput {
  inGlass: boolean;
  tabs: TabEntry[];
  activeTabId: string;
  tabCounts: Map<string, number>;
  focusedPaneId: string | null;
  focusedTabId: string | null;
  focusedIsAuto: boolean;
  sessionActivePinned: boolean;
}

function tabSublist(
  tabs: TabEntry[],
  counts: Map<string, number>,
  opts?: { excludeId?: string },
): PaletteSublistOption[] {
  const out: PaletteSublistOption[] = [];
  for (const t of tabs) {
    if (opts?.excludeId && t.id === opts.excludeId) continue;
    out.push({ id: t.id, label: `${t.name} (${counts.get(t.id) ?? 0})` });
  }
  out.push({ id: NEW_TAB_OPTION_ID, label: "+ New tab…" });
  return out;
}

export function buildCcCommands(input: CcCommandInput): PaletteCommand[] {
  const cmds: PaletteCommand[] = [];
  const { tabs, activeTabId, tabCounts } = input;

  if (input.inGlass) {
    if (input.focusedPaneId) {
      cmds.push({
        id: "move-tile", label: "Move tile to tab…", category: "command center",
        sublist: tabSublist(tabs, tabCounts, { excludeId: input.focusedTabId ?? undefined }),
      });
      if (input.focusedIsAuto) {
        cmds.push({
          id: "unpin-tile", label: "Unpin tile", category: "command center",
          disabled: true, hint: "auto-pinned; disable auto-pin or it returns",
        });
      } else {
        cmds.push({ id: "unpin-tile", label: "Unpin tile", category: "command center" });
      }
    }
    // Tab management (active-tab subject).
    cmds.push({ id: "new-cc-tab", label: "New Command Center tab…", category: "command center" });
    cmds.push({ id: "rename-cc-tab", label: "Rename current tab…", category: "command center" });
    cmds.push({ id: "delete-cc-tab", label: "Delete current tab", category: "command center" });

    const activeIdx = tabs.findIndex((t) => t.id === activeTabId);
    if (activeIdx > 1) cmds.push({ id: "move-tab-left", label: "Move tab left", category: "command center" });
    if (activeIdx >= 1 && activeIdx < tabs.length - 1)
      cmds.push({ id: "move-tab-right", label: "Move tab right", category: "command center" });
  } else {
    // Session context: pin (fused) or unpin the active pane.
    if (input.sessionActivePinned) {
      cmds.push({ id: "unpin-pane", label: "Unpin from Command Center", category: "command center" });
    } else {
      cmds.push({
        id: "pin-pane", label: "Pin to Command Center", category: "command center",
        sublist: tabSublist(tabs, tabCounts),
      });
    }
  }

  // Switch-to-tab is available everywhere.
  cmds.push({
    id: "switch-cc-tab", label: "Switch to Command Center tab…", category: "command center",
    sublist: tabs.map((t) => ({ id: t.id, label: `${t.name} (${tabCounts.get(t.id) ?? 0})`, current: t.id === activeTabId })),
  });

  return cmds;
}
