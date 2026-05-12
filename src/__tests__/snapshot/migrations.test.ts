import { describe, test, expect } from "bun:test";
import { MigrationRegistry } from "../../snapshot/migrations";

describe("MigrationRegistry", () => {
  test("returns input unchanged when version matches target", () => {
    const reg = new MigrationRegistry(1);
    const input = { formatVersion: 1, foo: "bar" };
    const result = reg.migrate(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(input);
  });

  test("applies registered migrator to step up versions", () => {
    const reg = new MigrationRegistry(1);
    reg.register(0, 1, (v) => ({ ...v, formatVersion: 1, migrated: true }));
    const result = reg.migrate({ formatVersion: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveProperty("migrated", true);
      expect((result.value as { formatVersion: number }).formatVersion).toBe(1);
    }
  });

  test("chains migrators across multiple versions", () => {
    const reg = new MigrationRegistry(2);
    reg.register(0, 1, (v) => ({ ...v, formatVersion: 1, a: true }));
    reg.register(1, 2, (v) => ({ ...v, formatVersion: 2, b: true }));
    const result = reg.migrate({ formatVersion: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveProperty("a", true);
      expect(result.value).toHaveProperty("b", true);
    }
  });

  test("fails when no path from source to target", () => {
    const reg = new MigrationRegistry(2);
    reg.register(0, 1, (v) => ({ ...v, formatVersion: 1 }));
    const result = reg.migrate({ formatVersion: 0 });
    expect(result.ok).toBe(false);
  });

  test("fails when input has unknown future formatVersion", () => {
    const reg = new MigrationRegistry(1);
    const result = reg.migrate({ formatVersion: 999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("999");
  });

  test("fails when input is not an object", () => {
    const reg = new MigrationRegistry(1);
    const result = reg.migrate("not an object");
    expect(result.ok).toBe(false);
  });
});
