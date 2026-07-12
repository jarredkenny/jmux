import { describe, test, expect } from "bun:test";
import { isSnapshotTempName } from "../../snapshot/fs";

describe("isSnapshotTempName", () => {
  test("matches the real writeAtomic temp pattern", () => {
    expect(isSnapshotTempName("state.json.tmp.12345.7")).toBe(true);
    expect(isSnapshotTempName("1-0.ansi.tmp.999.1")).toBe(true);
    expect(isSnapshotTempName("state.json.tmp")).toBe(true);
  });
  test("does not match real snapshot files", () => {
    expect(isSnapshotTempName("state.json")).toBe(false);
    expect(isSnapshotTempName("1-0.ansi")).toBe(false);
    expect(isSnapshotTempName("state.json.broken-2026-07-12T00:00:00.000Z")).toBe(
      false,
    );
  });
});
