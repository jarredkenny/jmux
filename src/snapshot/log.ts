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
    let combined = prev + line;
    const lines = combined.split("\n");
    // lines includes a trailing "" from the final newline; cap to last 1000 real lines
    if (lines.length > 1001) {
      combined = lines.slice(lines.length - 1001).join("\n");
    }
    await this.fs.writeAtomic(
      this.path,
      new TextEncoder().encode(combined),
    );
  }
}
