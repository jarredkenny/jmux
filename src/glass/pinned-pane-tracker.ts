type ChangeListener = (paneId: string) => void;

/**
 * Tracks each pane's desired Command Center membership via the per-pane tmux
 * option `@jmux-pinned`. The stored value is the raw option string — a tab id
 * (or legacy "1") — not just a boolean. tmux is the source of truth; this mirrors
 * what the control channel reports. It never breaks or joins panes.
 */
export class PinnedPaneTracker {
  private values = new Map<string, string>(); // paneId → raw non-empty value
  private listeners: ChangeListener[] = [];

  get size(): number {
    return this.values.size;
  }

  has(paneId: string): boolean {
    return this.values.has(paneId);
  }

  /** Raw `@jmux-pinned` value (tab id / legacy "1"), or undefined when unpinned. */
  getValue(paneId: string): string | undefined {
    return this.values.get(paneId);
  }

  all(): string[] {
    return [...this.values.keys()];
  }

  onChange(fn: ChangeListener): void {
    this.listeners.push(fn);
  }

  /**
   * Reflect a raw `@jmux-pinned` value. Non-empty → pinned with that value;
   * empty/null → unpinned. Emits only when the effective value changes.
   */
  apply(paneId: string, rawValue: string | null): void {
    const next = rawValue && rawValue.length > 0 ? rawValue : null;
    const prev = this.values.get(paneId) ?? null;
    if (next === prev) return;
    if (next === null) this.values.delete(paneId);
    else this.values.set(paneId, next);
    this.emit(paneId);
  }

  /** Drop any tracked pane not in `activeIds` (e.g. its process exited). */
  pruneExcept(activeIds: string[]): void {
    const active = new Set(activeIds);
    let changed: string | null = null;
    for (const id of [...this.values.keys()]) {
      if (!active.has(id)) {
        this.values.delete(id);
        changed = id;
      }
    }
    if (changed !== null) this.emit(changed);
  }

  private emit(paneId: string): void {
    for (const fn of this.listeners) fn(paneId);
  }
}
