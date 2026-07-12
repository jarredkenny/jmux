import { promises as fsp } from "fs";
import { dirname } from "path";
import lockfile from "proper-lockfile";
import type { FileSystem, FileStat, Lock, LockOptions, LockResult } from "./deps";

let writeCounter = 0;

/** Recognizes writeAtomic temp files: `<name>.tmp` or `<name>.tmp.<pid>.<counter>`. */
export function isSnapshotTempName(name: string): boolean {
  return /\.tmp(\.\d+\.\d+)?$/.test(name);
}

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
      // Durability: fsync the parent directory so the rename's directory entry
      // survives power loss (the file bytes were already fsync'd above).
      try {
        const dh = await fsp.open(dirname(path), "r");
        try {
          await dh.sync();
        } finally {
          await dh.close();
        }
      } catch {
        // Best-effort — not all platforms/filesystems support directory fsync.
      }
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

  async removeRecursive(path: string): Promise<void> {
    // force:true makes a missing path a no-op; recursive:true removes trees,
    // so a directory entry never triggers the EPERM that plain unlink would.
    await fsp.rm(path, { recursive: true, force: true });
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

  async lock(path: string, opts?: LockOptions): Promise<LockResult> {
    // proper-lockfile creates `${path}.lock` as the on-disk artifact and refreshes
    // its mtime while held (`update`). A holder that dies stops refreshing, so the
    // lock ages past `stale` and is reclaimed automatically on the next acquire —
    // the exact failure mode the old O_EXCL lock could not recover from.
    await fsp.mkdir(dirname(path), { recursive: true });
    try {
      const release = await lockfile.lock(path, {
        stale: 30_000,
        update: 10_000,
        realpath: false,
        onCompromised: (err) => opts?.onCompromised?.(err),
      });
      let released = false;
      const lock: Lock = {
        release: async () => {
          if (released) return;
          released = true;
          await release().catch(() => undefined);
        },
      };
      return { ok: true, lock };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ELOCKED") return { ok: false, reason: "locked_live" };
      return { ok: false, reason: "error", detail: String(err) };
    }
  }
}
