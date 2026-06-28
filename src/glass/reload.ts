import { defaultTabId, type TabEntry } from "./tabs";

/** Keep active/last-active tab ids that still exist; fold vanished ones to default. */
export function clampTabSelection(
  tabs: TabEntry[],
  activeId: string,
  lastActiveId: string,
): { activeTabId: string; lastActiveTabId: string } {
  const has = (id: string) => tabs.some((t) => t.id === id);
  const def = defaultTabId(tabs);
  return {
    activeTabId: has(activeId) ? activeId : def,
    lastActiveTabId: has(lastActiveId) ? lastActiveId : def,
  };
}
