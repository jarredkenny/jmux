import { describe, test, expect } from "bun:test";
import {
  INTERNAL_SESSION_PREFIX,
  INTERNAL_SESSION_FILTER,
  PARK_SESSION,
  tileSessionName,
  isInternalSession,
} from "../../glass/internal-sessions";
import { sanitizeTmuxSessionName } from "../../config";

describe("isInternalSession", () => {
  test("true for the reserved prefix", () => {
    expect(isInternalSession("__jmux_glass")).toBe(true);
    expect(isInternalSession("__jmux_park")).toBe(true);
    expect(isInternalSession("__jmux_tile_3")).toBe(true);
  });

  test("false for ordinary session names", () => {
    expect(isInternalSession("api")).toBe(false);
    expect(isInternalSession("TRA-123")).toBe(false);
    expect(isInternalSession("_jmux_almost")).toBe(false);
  });
});

describe("internal session names", () => {
  test("constants use the reserved prefix", () => {
    expect(PARK_SESSION.startsWith(INTERNAL_SESSION_PREFIX)).toBe(true);
  });

  test("tileSessionName strips the % from a pane id and is internal", () => {
    const name = tileSessionName("%7");
    expect(name).toBe("__jmux_tile_7");
    expect(isInternalSession(name)).toBe(true);
  });
});

describe("INTERNAL_SESSION_FILTER", () => {
  test("is the documented tmux 3.6a conditional form (no #{!:})", () => {
    expect(INTERNAL_SESSION_FILTER).toBe(
      "#{?#{m:__jmux_*,#{session_name}},0,1}",
    );
    expect(INTERNAL_SESSION_FILTER).not.toContain("#{!:");
  });
});

describe("sanitizeTmuxSessionName rejects the reserved prefix", () => {
  test("a user name colliding with the internal prefix is defanged", () => {
    expect(isInternalSession(sanitizeTmuxSessionName("__jmux_glass"))).toBe(false);
    expect(isInternalSession(sanitizeTmuxSessionName("__jmux_evil"))).toBe(false);
  });

  test("ordinary names are unaffected apart from existing . : rules", () => {
    expect(sanitizeTmuxSessionName("api")).toBe("api");
    expect(sanitizeTmuxSessionName("a.b:c")).toBe("a_b_c");
  });
});
