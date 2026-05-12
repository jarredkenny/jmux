import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProductionFileSystem } from "../../snapshot/fs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jmux-atomic-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ProductionFileSystem atomic-write stress", () => {
  test("concurrent writers never produce a partial file", async () => {
    const fs = new ProductionFileSystem();
    const path = join(dir, "state.json");
    const writers = Array.from({ length: 8 }).map((_, i) =>
      (async () => {
        for (let j = 0; j < 30; j++) {
          const payload = JSON.stringify({ writer: i, n: j, pad: "x".repeat(200) });
          await fs.writeAtomic(path, new TextEncoder().encode(payload));
          const content = readFileSync(path, "utf8");
          // Parse must always succeed — never see a partial write
          JSON.parse(content);
        }
      })(),
    );
    await Promise.all(writers);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(path + ".tmp")).toBe(false);
  }, 30000);
});
