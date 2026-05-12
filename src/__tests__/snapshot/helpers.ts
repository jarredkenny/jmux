import type {
  Clock,
  FileStat,
  FileSystem,
  Lock,
  TmuxRunResult,
  TmuxRunner,
} from "../../snapshot/deps";

export class FakeClock implements Clock {
  private current = 0;
  private intervals: { fn: () => void; ms: number; nextAt: number; id: number }[] = [];
  private timeouts: { fn: () => void; at: number; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.current;
  }

  setInterval(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.intervals.push({ fn, ms, nextAt: this.current + ms, id });
    return () => {
      this.intervals = this.intervals.filter((i) => i.id !== id);
    };
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timeouts.push({ fn, at: this.current + ms, id });
    return () => {
      this.timeouts = this.timeouts.filter((t) => t.id !== id);
    };
  }

  advance(ms: number): void {
    const target = this.current + ms;
    while (true) {
      const nextTimeout = this.timeouts
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      const nextInterval = this.intervals
        .filter((i) => i.nextAt <= target)
        .sort((a, b) => a.nextAt - b.nextAt)[0];
      const pickTimeout =
        nextTimeout &&
        (!nextInterval || nextTimeout.at <= nextInterval.nextAt);
      if (pickTimeout) {
        this.current = nextTimeout.at;
        this.timeouts = this.timeouts.filter((t) => t.id !== nextTimeout.id);
        nextTimeout.fn();
        continue;
      }
      if (nextInterval) {
        this.current = nextInterval.nextAt;
        nextInterval.nextAt += nextInterval.ms;
        nextInterval.fn();
        continue;
      }
      break;
    }
    this.current = target;
  }

  async flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}

export class FakeFs implements FileSystem {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  locks = new Set<string>();
  writeCount = new Map<string, number>();

  async readFile(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
    this.writeCount.set(path, (this.writeCount.get(path) ?? 0) + 1);
  }

  writes(path: string): number {
    return this.writeCount.get(path) ?? 0;
  }

  async rename(from: string, to: string): Promise<void> {
    const b = this.files.get(from);
    if (b !== undefined) {
      this.files.set(to, b);
      this.files.delete(from);
    }
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }

  async readDir(path: string): Promise<string[]> {
    const prefix = path.endsWith("/") ? path : path + "/";
    const set = new Set<string>();
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) {
        const rest = k.slice(prefix.length);
        const seg = rest.split("/")[0];
        if (seg) set.add(seg);
      }
    }
    return Array.from(set);
  }

  async mkdir(path: string, _recursive?: boolean): Promise<void> {
    this.dirs.add(path);
  }

  async stat(path: string): Promise<FileStat | null> {
    const b = this.files.get(path);
    return b ? { size: b.byteLength, mtimeMs: 0 } : null;
  }

  async lock(path: string): Promise<Lock | null> {
    if (this.locks.has(path)) return null;
    this.locks.add(path);
    return {
      release: async () => {
        this.locks.delete(path);
      },
    };
  }
}

export class FakeRunner implements TmuxRunner {
  invocations: string[][] = [];
  responses = new Map<string, TmuxRunResult>();
  defaultResponse: TmuxRunResult = { stdout: "", stderr: "", exitCode: 0 };

  setResponse(argsKey: string, result: TmuxRunResult): void {
    this.responses.set(argsKey, result);
  }

  async run(args: string[], _opts?: { timeoutMs?: number }): Promise<TmuxRunResult> {
    this.invocations.push([...args]);
    const key = args.join(" ");
    return this.responses.get(key) ?? this.defaultResponse;
  }
}
