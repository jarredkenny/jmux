import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadProjectDirsCache, saveProjectDirsCache } from "../project-dirs-cache";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

describe("project-dirs cache", () => {
  let tmpCacheDir: string;
  let cachePath: string;

  beforeEach(() => {
    tmpCacheDir = resolve(tmpdir(), `jmux-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpCacheDir, { recursive: true });
    cachePath = resolve(tmpCacheDir, "project-dirs.json");
  });

  afterEach(() => {
    try { rmSync(tmpCacheDir, { recursive: true, force: true }); } catch {}
  });

  test("returns empty array when cache file does not exist", () => {
    const dirs = loadProjectDirsCache(cachePath);
    expect(dirs).toEqual([]);
  });

  test("returns empty array when cache file is corrupt JSON", () => {
    writeFileSync(cachePath, "not valid json {{{");
    const dirs = loadProjectDirsCache(cachePath);
    expect(dirs).toEqual([]);
  });

  test("returns empty array when cache file has wrong shape", () => {
    writeFileSync(cachePath, JSON.stringify({ something: "else" }));
    const dirs = loadProjectDirsCache(cachePath);
    expect(dirs).toEqual([]);
  });

  test("save and load round-trip", () => {
    const dirs = ["/home/user/Code/proj1", "/home/user/Code/proj2"];
    saveProjectDirsCache(cachePath, dirs);
    expect(existsSync(cachePath)).toBe(true);
    const loaded = loadProjectDirsCache(cachePath);
    expect(loaded).toEqual(dirs);
  });

  test("save creates parent directory if missing", () => {
    const nestedPath = resolve(tmpCacheDir, "nested", "sub", "project-dirs.json");
    saveProjectDirsCache(nestedPath, ["/a", "/b"]);
    expect(existsSync(nestedPath)).toBe(true);
    expect(loadProjectDirsCache(nestedPath)).toEqual(["/a", "/b"]);
  });

  test("save does not throw if write fails (e.g., read-only fs)", () => {
    // Use a path that can't be created (contains null byte — invalid on all OSes)
    expect(() => saveProjectDirsCache("/\0/invalid/path.json", ["/a"])).not.toThrow();
  });

  test("load returns only strings from the array, filters other types", () => {
    writeFileSync(cachePath, JSON.stringify(["/a", 42, null, "/b", { x: 1 }, "/c"]));
    const dirs = loadProjectDirsCache(cachePath);
    expect(dirs).toEqual(["/a", "/b", "/c"]);
  });
});
