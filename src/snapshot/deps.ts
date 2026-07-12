export interface Lock {
  release(): Promise<void>;
}

export interface LockOptions {
  /** Called if the held lock is lost while running (e.g. our refresh stalled
      past `stale` and another process reclaimed it). */
  onCompromised?: (err: Error) => void;
}

export type LockResult =
  | { ok: true; lock: Lock }
  | { ok: false; reason: "locked_live" | "error"; detail?: string };

export interface FileStat {
  size: number;
  mtimeMs: number;
}

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array | null>;
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  readDir(path: string): Promise<string[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  stat(path: string): Promise<FileStat | null>;
  lock(path: string, opts?: LockOptions): Promise<LockResult>;
}

export interface TmuxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TmuxRunner {
  run(args: string[], opts?: { timeoutMs?: number }): Promise<TmuxRunResult>;
}

export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): () => void;
  setTimeout(fn: () => void, ms: number): () => void;
}
