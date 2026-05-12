import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProductionFileSystem } from "../../snapshot/fs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jmux-fs-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ProductionFileSystem.writeAtomic", () => {
  test("writes file and contents are readable", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "out.json");
    await fs.writeAtomic(path, new TextEncoder().encode("hello"));
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  test("no .tmp file remains after success", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "out.json");
    await fs.writeAtomic(path, new TextEncoder().encode("hello"));
    expect(existsSync(path + ".tmp")).toBe(false);
  });

  test("overwrites existing file", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "out.json");
    writeFileSync(path, "old");
    await fs.writeAtomic(path, new TextEncoder().encode("new"));
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  test("creates parent directories on demand", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "a", "b", "c", "out.json");
    await fs.writeAtomic(path, new TextEncoder().encode("ok"));
    expect(readFileSync(path, "utf8")).toBe("ok");
  });
});

describe("ProductionFileSystem.readFile", () => {
  test("returns null for missing file", async () => {
    const fs = new ProductionFileSystem();
    const result = await fs.readFile(join(dir, "missing"));
    expect(result).toBeNull();
  });

  test("returns bytes for existing file", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "f");
    writeFileSync(path, "abc");
    const result = await fs.readFile(path);
    expect(result).not.toBeNull();
    expect(new TextDecoder().decode(result!)).toBe("abc");
  });
});

describe("ProductionFileSystem.lock", () => {
  test("acquires lock on a fresh path", async () => {
    const fs = new ProductionFileSystem();
    const lock = await fs.lock(join(dir, ".lock"));
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  test("second acquisition returns null while first is held", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, ".lock");
    const first = await fs.lock(path);
    expect(first).not.toBeNull();
    const second = await fs.lock(path);
    expect(second).toBeNull();
    await first!.release();
  });

  test("after release, lock can be re-acquired", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, ".lock");
    const first = await fs.lock(path);
    await first!.release();
    const second = await fs.lock(path);
    expect(second).not.toBeNull();
    await second!.release();
  });
});
