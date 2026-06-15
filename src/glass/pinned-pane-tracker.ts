type ChangeListener = (paneId: string) => void;

/**
 * Tracks the set of panes the user/agents have marked as desired glass members
 * via the per-pane tmux option `@jmux-pinned`. This is *desired membership* only
 * — it never breaks or joins panes. tmux is the source of truth; this mirrors
 * what the control channel reports. Mirrors AgentStateTracker's shape.
 */
export class PinnedPaneTracker {
  private pinned = new Set<string>();
  private listeners: ChangeListener[] = [];

  get size(): number {
    return this.pinned.size;
  }

  has(paneId: string): boolean {
    return this.pinned.has(paneId);
  }

  all(): string[] {
    return [...this.pinned];
  }

  onChange(fn: ChangeListener): void {
    this.listeners.push(fn);
  }

  /**
   * Reflect a raw `@jmux-pinned` value for a pane. "1" → pinned; anything else
   * (empty / unset) → not pinned. Only emits when membership actually changes.
   */
  apply(paneId: string, rawPinned: string | null): void {
    const want = rawPinned === "1";
    const have = this.pinned.has(paneId);
    if (want === have) return;
    if (want) this.pinned.add(paneId);
    else this.pinned.delete(paneId);
    this.emit(paneId);
  }

  /** Drop any tracked pane not in `activeIds` (e.g. its process exited). */
  pruneExcept(activeIds: string[]): void {
    const active = new Set(activeIds);
    let changed: string | null = null;
    for (const id of [...this.pinned]) {
      if (!active.has(id)) {
        this.pinned.delete(id);
        changed = id;
      }
    }
    if (changed !== null) this.emit(changed);
  }

  private emit(paneId: string): void {
    for (const fn of this.listeners) fn(paneId);
  }
}
