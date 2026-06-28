export interface TilePlanSpec {
  paneId: string;
  tabId: string;
}

export interface TilePlan {
  /** Active-tab panes not yet warm — spawn these. */
  spawn: string[];
  /** Warm panes no longer in membership — tear these down. */
  teardown: string[];
  /** Active-tab panes to draw, in membership order. */
  render: string[];
}

/**
 * Decide tile lifecycle for lazy keep-warm. Active-tab panes spawn on first
 * visit; tiles stay warm across tab switches; only panes that leave membership
 * entirely are torn down. The active tab is a render filter over the warm set.
 */
export function planTiles(
  all: ReadonlyArray<TilePlanSpec>,
  activeTabId: string,
  warm: ReadonlySet<string>,
): TilePlan {
  const allIds = new Set(all.map((s) => s.paneId));
  const activeOrder = all.filter((s) => s.tabId === activeTabId).map((s) => s.paneId);

  const spawn = activeOrder.filter((id) => !warm.has(id));
  const teardown = [...warm].filter((id) => !allIds.has(id));
  const render = activeOrder;

  return { spawn, teardown, render };
}
