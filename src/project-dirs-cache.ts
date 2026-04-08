import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export function loadProjectDirsCache(cachePath: string): string[] {
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export function saveProjectDirsCache(cachePath: string, dirs: string[]): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(dirs));
  } catch {
    // Best-effort — a failed cache write should never crash jmux
  }
}
