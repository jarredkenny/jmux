export interface TabEntry {
  id: string;
  name: string;
}

export const DEFAULT_TAB_SEED_ID = "default";
export const DEFAULT_TAB_SEED_NAME = "Main";

function seedDefault(): TabEntry[] {
  return [{ id: DEFAULT_TAB_SEED_ID, name: DEFAULT_TAB_SEED_NAME }];
}

/**
 * Parse/validate/synthesize the tab registry. Always returns a non-empty array
 * whose index 0 is the protected default tab. Malformed entries are dropped and
 * duplicate ids are collapsed (first occurrence wins). An empty or fully-invalid
 * input synthesizes the seed default.
 */
export function normalizeTabs(raw: unknown): TabEntry[] {
  if (!Array.isArray(raw)) return seedDefault();
  const out: TabEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const name = (entry as { name?: unknown }).name;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string" || name.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out.length > 0 ? out : seedDefault();
}

/** The default tab is whatever sits at index 0. */
export function defaultTabId(tabs: TabEntry[]): string {
  return tabs[0].id;
}

/**
 * Resolve a raw `@jmux-pinned` value to a tab id. A non-empty value that names a
 * known tab resolves to that tab; everything else (legacy "1", unknown ids,
 * empty/auto) folds to the default tab. No pane rewrite — interpretation only.
 */
export function resolveTabId(
  rawPinValue: string | null | undefined,
  tabs: TabEntry[],
): string {
  if (rawPinValue) {
    for (const t of tabs) {
      if (t.id === rawPinValue) return rawPinValue;
    }
  }
  return defaultTabId(tabs);
}
