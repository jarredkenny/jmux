import { test, expect, describe } from "bun:test";
import {
  STATE_COLOR_NAMES,
  STATE_COLOR_CHOICES,
  DEFAULT_STATE_COLORS,
  colorNameToPalette,
  resolveStateColors,
  stateAttrs,
} from "../state-colors";
import { ColorMode } from "../types";
import { tokens } from "../chrome-tokens";

describe("colorNameToPalette", () => {
  test("maps all 16 ANSI names to palette indices 0-15", () => {
    const expected: Record<string, number> = {
      black: 0, red: 1, green: 2, yellow: 3,
      blue: 4, magenta: 5, cyan: 6, white: 7,
      brightblack: 8, brightred: 9, brightgreen: 10, brightyellow: 11,
      brightblue: 12, brightmagenta: 13, brightcyan: 14, brightwhite: 15,
    };
    for (const [name, idx] of Object.entries(expected)) {
      expect(colorNameToPalette(name)).toBe(idx);
    }
  });

  test("is case-insensitive", () => {
    expect(colorNameToPalette("Green")).toBe(2);
    expect(colorNameToPalette("BRIGHTBLUE")).toBe(12);
  });

  test("returns null for unknown names", () => {
    expect(colorNameToPalette("chartreuse")).toBeNull();
    expect(colorNameToPalette("")).toBeNull();
    expect(colorNameToPalette("#ff0000")).toBeNull();
  });

  test("returns null for Object.prototype property names", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(colorNameToPalette(name)).toBeNull();
    }
  });

  test("STATE_COLOR_NAMES are all resolvable", () => {
    for (const name of STATE_COLOR_NAMES) {
      expect(colorNameToPalette(name)).not.toBeNull();
    }
    expect(STATE_COLOR_NAMES.length).toBe(16);
  });
});

describe("resolveStateColors", () => {
  test("returns defaults when config is undefined — complete is neutral", () => {
    expect(resolveStateColors(undefined)).toEqual({
      running: { kind: "palette", index: 2 },   // green
      waiting: { kind: "palette", index: 3 },   // yellow
      complete: { kind: "neutral" },
    });
  });

  test("defaults match DEFAULT_STATE_COLORS — complete defaults to neutral", () => {
    expect(DEFAULT_STATE_COLORS).toEqual({
      running: "green",
      waiting: "yellow",
      complete: "neutral",
    });
  });

  test("applies configured names", () => {
    expect(resolveStateColors({ running: "cyan", waiting: "magenta", complete: "white" })).toEqual({
      running: { kind: "palette", index: 6 },
      waiting: { kind: "palette", index: 5 },
      complete: { kind: "palette", index: 7 },
    });
  });

  test("an explicit complete: blue still resolves to palette index 4", () => {
    expect(resolveStateColors({ complete: "blue" })).toEqual({
      running: { kind: "palette", index: 2 },
      waiting: { kind: "palette", index: 3 },
      complete: { kind: "palette", index: 4 },
    });
  });

  test("explicit complete: neutral resolves to the neutral kind", () => {
    expect(resolveStateColors({ complete: "neutral" })).toEqual({
      running: { kind: "palette", index: 2 },
      waiting: { kind: "palette", index: 3 },
      complete: { kind: "neutral" },
    });
  });

  test("falls back to that state's default for invalid name", () => {
    expect(resolveStateColors({ running: "chartreuse" })).toEqual({
      running: { kind: "palette", index: 2 },   // fallback to green default
      waiting: { kind: "palette", index: 3 },
      complete: { kind: "neutral" },
    });
  });

  test("falls back per-state when a name is missing", () => {
    expect(resolveStateColors({ waiting: "brightred" })).toEqual({
      running: { kind: "palette", index: 2 },
      waiting: { kind: "palette", index: 9 },
      complete: { kind: "neutral" },
    });
  });

  test("neutral is never emitted as a palette index, and never index 16", () => {
    const resolved = resolveStateColors({ running: "neutral", waiting: "neutral", complete: "neutral" });
    for (const state of ["running", "waiting", "complete"] as const) {
      expect(resolved[state]).toEqual({ kind: "neutral" });
      if (resolved[state].kind === "palette") {
        expect((resolved[state] as { kind: "palette"; index: number }).index).not.toBe(16);
      }
    }
  });
});

describe("STATE_COLOR_CHOICES", () => {
  test("is the 16 ANSI names plus neutral, without disturbing STATE_COLOR_NAMES", () => {
    expect(STATE_COLOR_NAMES.length).toBe(16);
    expect(STATE_COLOR_CHOICES).toEqual([...STATE_COLOR_NAMES, "neutral"]);
    expect(STATE_COLOR_CHOICES.length).toBe(17);
  });
});

describe("stateAttrs", () => {
  test("palette kind resolves to a palette fg with no emphasis", () => {
    expect(stateAttrs({ kind: "palette", index: 2 }, {})).toEqual({
      fg: 2,
      fgMode: ColorMode.Palette,
    });
  });

  test("palette kind applies emphasis flags", () => {
    expect(stateAttrs({ kind: "palette", index: 3 }, { bold: true })).toEqual({
      fg: 3,
      fgMode: ColorMode.Palette,
      bold: true,
    });
  });

  test("neutral kind sources fg/fgMode from tokens.textTertiary (not a hardcoded palette 8)", () => {
    const result = stateAttrs({ kind: "neutral" }, { dim: true });
    // Reads live from the token object rather than a magic number, so a
    // re-theme (rebuildChromeTokens) changes this without touching stateAttrs.
    expect(result.fg).toBe(tokens.textTertiary.fg);
    expect(result.fgMode).toBe(tokens.textTertiary.fgMode);
    expect(result.dim).toBe(true);
  });

  test("neutral kind tracks a live token change rather than a frozen literal", () => {
    const before = stateAttrs({ kind: "neutral" }, {});
    const originalFg = tokens.textTertiary.fg;
    const originalMode = tokens.textTertiary.fgMode;
    try {
      // Mutate the token in place, the same way rebuildChromeTokens() does on
      // a re-theme, and confirm stateAttrs picks up the new value rather than
      // a value captured once at import time.
      tokens.textTertiary.fg = 99;
      tokens.textTertiary.fgMode = ColorMode.RGB;
      const after = stateAttrs({ kind: "neutral" }, {});
      expect(after.fg).toBe(99);
      expect(after.fgMode).toBe(ColorMode.RGB);
      expect(after.fg).not.toBe(before.fg);
    } finally {
      tokens.textTertiary.fg = originalFg;
      tokens.textTertiary.fgMode = originalMode;
    }
  });

  test("neutral kind applies emphasis flags", () => {
    const result = stateAttrs({ kind: "neutral" }, { bold: true });
    expect(result.bold).toBe(true);
    expect(result.fg).toBe(tokens.textTertiary.fg);
    expect(result.fgMode).toBe(tokens.textTertiary.fgMode);
  });

  test("no emphasis yields no bold/dim keys set", () => {
    const result = stateAttrs({ kind: "palette", index: 2 }, {});
    expect(result.bold).toBeUndefined();
    expect(result.dim).toBeUndefined();
  });

  test("is exhaustive over the StateColor union (compile-time via a runtime switch)", () => {
    // Every branch of the union must produce a result — this loop, combined
    // with stateAttrs' internal `never` check, catches an unhandled variant
    // at compile time if the union ever grows.
    const variants: Array<Parameters<typeof stateAttrs>[0]> = [
      { kind: "palette", index: 5 },
      { kind: "neutral" },
    ];
    for (const v of variants) {
      expect(() => stateAttrs(v, {})).not.toThrow();
    }
  });
});
