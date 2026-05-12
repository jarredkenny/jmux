import type { Clock, FileSystem, TmuxRunner } from "./deps";
import { validateSnapshot, type SnapshotFile } from "./schema";
import { RestoreLog, type RestoreOutcome } from "./log";

export interface RestorerOptions {
  dir: string;
  fs: FileSystem;
  runner: TmuxRunner;
  clock: Clock;
  jmuxVersion: string;
  userShell: string;
  claudeCommand: string;
  cwdExists?: (path: string) => Promise<boolean>;
}

export type EligibilityResult =
  | { ok: true; snapshot: SnapshotFile }
  | { ok: false; reason: "no_snapshot" | "invalid_snapshot" | "server_busy" | "tmux_error" };

const NO_SERVER_RX = /no server running|error connecting to|no sessions/i;

export class Restorer {
  protected readonly log: RestoreLog;
  protected outcomes = new Map<string, RestoreOutcome>();

  constructor(protected readonly opts: RestorerOptions) {
    this.log = new RestoreLog(opts.fs, `${opts.dir}/restore.log`);
  }

  outcomeFor(session: string): RestoreOutcome | undefined {
    return this.outcomes.get(session);
  }

  async checkEligibility(): Promise<EligibilityResult> {
    const raw = await this.opts.fs.readFile(`${this.opts.dir}/state.json`);
    if (!raw) return { ok: false, reason: "no_snapshot" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      await this.backupCorrupt(raw);
      return { ok: false, reason: "invalid_snapshot" };
    }

    const v = validateSnapshot(parsed);
    if (!v.ok) {
      await this.backupCorrupt(raw);
      return { ok: false, reason: "invalid_snapshot" };
    }

    const sess = await this.opts.runner.run([
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    if (sess.exitCode === 0) {
      if (sess.stdout.trim().length === 0) return { ok: true, snapshot: v.value };
      return { ok: false, reason: "server_busy" };
    }
    if (NO_SERVER_RX.test(sess.stderr)) {
      return { ok: true, snapshot: v.value };
    }
    return { ok: false, reason: "tmux_error" };
  }

  protected async backupCorrupt(raw: Uint8Array): Promise<void> {
    const ts = new Date(this.opts.clock.now()).toISOString();
    await this.opts.fs.writeAtomic(
      `${this.opts.dir}/state.json.broken-${ts}`,
      raw,
    );
  }
}
