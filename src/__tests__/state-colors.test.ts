import { test, expect, describe } from "bun:test";
import {
  STATE_COLOR_NAMES,
  STATE_COLOR_CHOICES,
  DEFAULT_STATE_COLORS,
  colorNameToPalette,
  resolveStateColors,
  stateColorToPalette,
} from "../state-colors";

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

describe("stateColorToPalette", () => {
  test("maps neutral to palette 8 (the grey the old dim complete approximated)", () => {
    expect(stateColorToPalette({ kind: "neutral" })).toBe(8);
  });

  test("maps palette kind through unchanged", () => {
    expect(stateColorToPalette({ kind: "palette", index: 2 })).toBe(2);
    expect(stateColorToPalette({ kind: "palette", index: 4 })).toBe(4);
  });
});
