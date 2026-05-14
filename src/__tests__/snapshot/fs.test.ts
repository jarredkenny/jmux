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

  test("cleans up .tmp on rename failure", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "target");
    // Pre-create target as a directory — rename will fail trying to overwrite it with a file
    const { mkdirSync } = await import("fs");
    mkdirSync(path);
    let threw = false;
    try {
      await fs.writeAtomic(path, new TextEncoder().encode("hello"));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(existsSync(path + ".tmp")).toBe(false);
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

describe("ProductionFileSystem.rename", () => {
  test("moves a file from one path to another", async () => {
    const fs = new ProductionFileSystem();
    const from = join(dir, "a.txt");
    const to = join(dir, "b.txt");
    writeFileSync(from, "hello");
    await fs.rename(from, to);
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(to, "utf8")).toBe("hello");
  });
});

describe("ProductionFileSystem.unlink", () => {
  test("deletes an existing file", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "del.txt");
    writeFileSync(path, "x");
    await fs.unlink(path);
    expect(existsSync(path)).toBe(false);
  });

  test("ignores ENOENT silently", async () => {
    const fs = new ProductionFileSystem();
    // Should not throw for a file that does not exist
    await fs.unlink(join(dir, "nonexistent.txt"));
  });

  test("propagates non-ENOENT errors", async () => {
    const fs = new ProductionFileSystem();
    // Attempt to unlink a directory (EISDIR on Linux, EPERM on macOS)
    const subdir = join(dir, "subdir");
    const { mkdirSync } = await import("fs");
    mkdirSync(subdir);
    let threw = false;
    try {
      await fs.unlink(subdir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("ProductionFileSystem.readDir", () => {
  test("returns empty array for missing directory", async () => {
    const fs = new ProductionFileSystem();
    const result = await fs.readDir(join(dir, "nosuchdir"));
    expect(result).toEqual([]);
  });

  test("returns file names in an existing directory", async () => {
    const fs = new ProductionFileSystem();
    writeFileSync(join(dir, "one.txt"), "");
    writeFileSync(join(dir, "two.txt"), "");
    const result = await fs.readDir(dir);
    expect(result).toContain("one.txt");
    expect(result).toContain("two.txt");
  });
});

describe("ProductionFileSystem.stat", () => {
  test("returns null for missing file", async () => {
    const fs = new ProductionFileSystem();
    const result = await fs.stat(join(dir, "missing.txt"));
    expect(result).toBeNull();
  });

  test("returns size and mtimeMs for existing file", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "sized.txt");
    writeFileSync(path, "hello");
    const result = await fs.stat(path);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(5);
    expect(typeof result!.mtimeMs).toBe("number");
  });
});

describe("ProductionFileSystem.mkdir", () => {
  test("creates nested directories", async () => {
    const fs = new ProductionFileSystem();
    const nested = join(dir, "a", "b", "c");
    await fs.mkdir(nested);
    expect(existsSync(nested)).toBe(true);
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

  test("double release is a no-op", async () => {
    const fs = new ProductionFileSystem();
    const lock = await fs.lock(join(dir, ".lock"));
    expect(lock).not.toBeNull();
    await lock!.release();
    // Should not throw
    await lock!.release();
  });

  test("can re-acquire after double release", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, ".lock");
    const first = await fs.lock(path);
    await first!.release();
    await first!.release(); // double release, no throw
    const second = await fs.lock(path);
    expect(second).not.toBeNull();
    await second!.release();
  });
});
