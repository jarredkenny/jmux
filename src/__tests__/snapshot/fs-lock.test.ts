import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProductionFileSystem } from "../../snapshot/fs";

describe("ProductionFileSystem.lock (proper-lockfile)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jmux-lock-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("acquires, blocks a second acquire as locked_live, releases", async () => {
    const fs = new ProductionFileSystem();
    const a = await fs.lock(`${dir}/.lock`);
    expect(a.ok).toBe(true);
    // proper-lockfile manages `${path}.lock` as the on-disk artifact.
    expect(existsSync(`${dir}/.lock.lock`)).toBe(true);

    const b = await fs.lock(`${dir}/.lock`);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("locked_live");

    if (a.ok) await a.lock.release();
    expect(existsSync(`${dir}/.lock.lock`)).toBe(false);

    const c = await fs.lock(`${dir}/.lock`);
    expect(c.ok).toBe(true);
    if (c.ok) await c.lock.release();
  });

  test("clean re-acquire after release", async () => {
    const fs = new ProductionFileSystem();
    const a = await fs.lock(`${dir}/.lock`);
    expect(a.ok).toBe(true);
    if (a.ok) await a.lock.release();
    const b = await fs.lock(`${dir}/.lock`);
    expect(b.ok).toBe(true);
    if (b.ok) await b.lock.release();
  });

  test("double release does not throw", async () => {
    const fs = new ProductionFileSystem();
    const a = await fs.lock(`${dir}/.lock`);
    expect(a.ok).toBe(true);
    if (a.ok) {
      await a.lock.release();
      await a.lock.release();
    }
  });
});
