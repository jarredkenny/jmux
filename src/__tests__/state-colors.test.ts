import { test, expect, describe } from "bun:test";
import {
  STATE_COLOR_NAMES,
  DEFAULT_STATE_COLORS,
  colorNameToPalette,
  resolveStateColors,
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

  test("STATE_COLOR_NAMES are all resolvable", () => {
    for (const name of STATE_COLOR_NAMES) {
      expect(colorNameToPalette(name)).not.toBeNull();
    }
    expect(STATE_COLOR_NAMES.length).toBe(16);
  });
});

describe("resolveStateColors", () => {
  test("returns defaults when config is undefined", () => {
    expect(resolveStateColors(undefined)).toEqual({
      running: 2,   // green
      waiting: 3,   // yellow
      complete: 4,  // blue
    });
  });

  test("defaults match DEFAULT_STATE_COLORS", () => {
    expect(DEFAULT_STATE_COLORS).toEqual({
      running: "green",
      waiting: "yellow",
      complete: "blue",
    });
  });

  test("applies configured names", () => {
    expect(resolveStateColors({ running: "cyan", waiting: "magenta", complete: "white" })).toEqual({
      running: 6,
      waiting: 5,
      complete: 7,
    });
  });

  test("falls back to that state's default for invalid name", () => {
    expect(resolveStateColors({ running: "chartreuse" })).toEqual({
      running: 2,   // fallback to green default
      waiting: 3,
      complete: 4,
    });
  });

  test("falls back per-state when a name is missing", () => {
    expect(resolveStateColors({ waiting: "brightred" })).toEqual({
      running: 2,
      waiting: 9,
      complete: 4,
    });
  });
});
