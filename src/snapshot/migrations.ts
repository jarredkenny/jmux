type Migrator = (input: Record<string, unknown>) => Record<string, unknown>;

export type MigrationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export class MigrationRegistry {
  private migrators = new Map<number, { to: number; fn: Migrator }>();

  constructor(private readonly targetVersion: number) {}

  register(from: number, to: number, fn: Migrator): void {
    if (this.migrators.has(from)) {
      throw new Error(`migrator already registered for from=${from}`);
    }
    this.migrators.set(from, { to, fn });
  }

  migrate(input: unknown): MigrationResult {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, error: "input not an object" };
    }
    let current = input as Record<string, unknown>;
    const versionField = current.formatVersion;

    if (typeof versionField !== "number") {
      return { ok: false, error: "missing formatVersion" };
    }

    if (versionField > this.targetVersion) {
      return {
        ok: false,
        error: `formatVersion ${versionField} is newer than supported (${this.targetVersion})`,
      };
    }

    let version: number = versionField;
    while (version !== this.targetVersion) {
      const step = this.migrators.get(version);
      if (!step) {
        return {
          ok: false,
          error: `no migrator from version ${version}`,
        };
      }
      current = step.fn(current);
      version = step.to;
      current.formatVersion = version;
    }

    return { ok: true, value: current };
  }
}
