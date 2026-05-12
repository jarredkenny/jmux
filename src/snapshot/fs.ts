import { promises as fsp, constants as fsConstants } from "fs";
import { dirname } from "path";
import type { FileSystem, FileStat, Lock } from "./deps";

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
    const tmp = `${path}.tmp`;
    const fh = await fsp.open(tmp, "w");
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, path);
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

  async lock(path: string): Promise<Lock | null> {
    await fsp.mkdir(dirname(path), { recursive: true });
    let handle: Awaited<ReturnType<typeof fsp.open>>;
    try {
      handle = await fsp.open(
        path,
        fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_EXCL,
        0o600,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
    return {
      release: async () => {
        await handle.close();
        await fsp.unlink(path).catch(() => undefined);
      },
    };
  }
}
