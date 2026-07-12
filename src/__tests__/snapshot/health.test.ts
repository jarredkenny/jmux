import { describe, test, expect } from "bun:test";
import {
  emptyHealth,
  recordSuccess,
  recordFailure,
  deriveHealth,
} from "../../snapshot/health";

describe("deriveHealth", () => {
  test("no commit yet -> starting", () => {
    const h = emptyHealth(1000);
    expect(deriveHealth(h, 1000, 60_000)).toBe("starting");
  });
  test("recent commit -> healthy", () => {
    const h = emptyHealth(1000);
    recordSuccess(h.stateCommit, 1000);
    expect(deriveHealth(h, 5_000, 60_000)).toBe("healthy");
  });
  test("commit older than staleMs -> stale", () => {
    const h = emptyHealth(1000);
    recordSuccess(h.stateCommit, 1000);
    expect(deriveHealth(h, 1000 + 120_000, 60_000)).toBe("stale");
  });
  test("topology failing repeatedly -> error even if state writes fresh", () => {
    const h = emptyHealth(1000);
    recordSuccess(h.stateCommit, 1000);
    recordFailure(h.topology, 1000, "boom");
    recordFailure(h.topology, 1000, "boom");
    recordFailure(h.topology, 1000, "boom");
    expect(deriveHealth(h, 2000, 60_000)).toBe("error");
  });
  test("lockCompromised -> error", () => {
    const h = emptyHealth(1000);
    recordSuccess(h.stateCommit, 1000);
    h.lockCompromised = true;
    expect(deriveHealth(h, 2000, 60_000)).toBe("error");
  });
  test("recordSuccess resets consecutiveFailures", () => {
    const h = emptyHealth(1000);
    recordFailure(h.scrollback, 1000, "x");
    recordSuccess(h.scrollback, 1100);
    expect(h.scrollback.consecutiveFailures).toBe(0);
  });
});
