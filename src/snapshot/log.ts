import type { FileSystem } from "./deps";

export type RestoreOutcome = "restored" | "skipped" | "failed";

export interface RestoreLogEntry {
  ts: string;
  session: string;
  outcome: RestoreOutcome;
  reason?: string;
  windowCount?: number;
  paneCount?: number;
  stderr?: string;
}

export class RestoreLog {
  constructor(
    private readonly fs: FileSystem,
    private readonly path: string,
  ) {}

  async append(entry: RestoreLogEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    const existing = await this.fs.readFile(this.path);
    const prev = existing ? new TextDecoder().decode(existing) : "";
    await this.fs.writeAtomic(
      this.path,
      new TextEncoder().encode(prev + line),
    );
  }
}
