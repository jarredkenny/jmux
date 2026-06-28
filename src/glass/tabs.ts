import type { AgentState } from "../types";

export type { AgentState } from "../types";

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

const MAX_TAB_NAME = 24;

/** Build a stable, unique slug id from a display name. */
export function slugifyTabName(name: string, existingIds: Iterable<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tab";
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export type TabValidation = { ok: true; name: string } | { ok: false; error: string };

export function validateTabName(
  name: string,
  tabs: TabEntry[],
  opts?: { excludeId?: string },
): TabValidation {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, error: "Tab name cannot be empty" };
  if (trimmed.length > MAX_TAB_NAME) return { ok: false, error: "Tab name too long (max 24)" };
  const lower = trimmed.toLowerCase();
  for (const t of tabs) {
    if (opts?.excludeId && t.id === opts.excludeId) continue;
    if (t.name.toLowerCase() === lower) {
      return { ok: false, error: `A tab named "${trimmed}" already exists` };
    }
  }
  return { ok: true, name: trimmed };
}

export type TabMutation = { ok: true; tabs: TabEntry[] } | { ok: false; error: string };

export function addTab(tabs: TabEntry[], name: string): TabMutation {
  const v = validateTabName(name, tabs);
  if (!v.ok) return v;
  const id = slugifyTabName(v.name, tabs.map(t => t.id));
  return { ok: true, tabs: [...tabs, { id, name: v.name }] };
}

export function renameTab(tabs: TabEntry[], id: string, newName: string): TabMutation {
  if (!tabs.some(t => t.id === id)) return { ok: false, error: "Unknown tab" };
  const v = validateTabName(newName, tabs, { excludeId: id });
  if (!v.ok) return v;
  return { ok: true, tabs: tabs.map(t => (t.id === id ? { ...t, name: v.name } : t)) };
}

export function deleteTab(tabs: TabEntry[], id: string, memberCount: number): TabMutation {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return { ok: false, error: "Unknown tab" };
  if (idx === 0) return { ok: false, error: "Cannot delete the default tab" };
  if (memberCount > 0) return { ok: false, error: "Tab is not empty" };
  return { ok: true, tabs: tabs.filter(t => t.id !== id) };
}

export function moveTab(tabs: TabEntry[], id: string, dir: "left" | "right"): TabEntry[] {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx <= 0) return tabs; // unknown, or the protected default
  const target = dir === "left" ? idx - 1 : idx + 1;
  if (target <= 0 || target >= tabs.length) return tabs; // never cross index 0; clamp at edges
  const next = [...tabs];
  [next[idx], next[target]] = [next[target], next[idx]];
  return next;
}

/**
 * Reduce a tab's tile states to one summary state for its strip chip dot:
 * most-attention-needed wins (waiting → running → complete). Null when the tab
 * holds no agents (plain shells / empty).
 */
export function summarizeTabState(
  states: ReadonlyArray<AgentState | null>,
): AgentState | null {
  let hasRunning = false;
  let hasComplete = false;
  for (const s of states) {
    if (s === "waiting") return "waiting";
    if (s === "running") hasRunning = true;
    else if (s === "complete") hasComplete = true;
  }
  if (hasRunning) return "running";
  if (hasComplete) return "complete";
  return null;
}
