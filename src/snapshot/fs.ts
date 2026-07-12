import { promises as fsp, constants as fsConstants } from "fs";
import { dirname } from "path";
import type { FileSystem, FileStat, Lock, LockOptions, LockResult } from "./deps";

let writeCounter = 0;

export class ProductionFileSystem implements FileSystem {
  async readFile(path: string): Promise<Uint8Array | null> {
    try {
      const buf = await fsp.readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    // Each concurrent write gets its own unique tmp path so concurrent writers
    // don't race over a shared .tmp file.
    const tmp = `${path}.tmp.${process.pid}.${++writeCounter}`;
    let wroteTmp = false;
    try {
      const fh = await fsp.open(tmp, "w");
      try {
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      wroteTmp = true;
      await fsp.rename(tmp, path);
    } catch (err) {
      if (wroteTmp) {
        // rename failed — tmp exists on disk, unlink it
        await fsp.unlink(tmp).catch(() => undefined);
      } else {
        // open/write/sync failed — tmp may exist partially
        await fsp.unlink(tmp).catch(() => undefined);
      }
      throw err;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to);
  }

  async unlink(path: string): Promise<void> {
    try {
      await fsp.unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async rmdir(path: string): Promise<void> {
    try {
      await fsp.rmdir(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw err;
    }
  }

  async readDir(path: string): Promise<string[]> {
    try {
      return await fsp.readdir(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await fsp.mkdir(path, { recursive });
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await fsp.stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async lock(path: string, _opts?: LockOptions): Promise<LockResult> {
    await fsp.mkdir(dirname(path), { recursive: true });
    try {
      const handle = await fsp.open(
        path,
        fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_EXCL,
        0o600,
      );
      let released = false;
      const lock: Lock = {
        release: async () => {
          if (released) return;
          released = true;
          try {
            await handle.close();
          } catch {
            // already closed — fine
          }
          try {
            await fsp.unlink(path);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        },
      };
      return { ok: true, lock };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST")
        return { ok: false, reason: "locked_live" };
      return { ok: false, reason: "error", detail: String(err) };
    }
  }
}
