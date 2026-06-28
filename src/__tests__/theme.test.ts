import { describe, test, expect } from "bun:test";
import {
  pack,
  unpack,
  mix,
  isDark,
  deriveTheme,
  parseOsc11,
  neutralFg,
  setTheme,
  scanForOsc11,
  DEFAULT_THEME,
  OSC11_RESPONSE_RE,
} from "../theme";
import { ColorMode } from "../types";

describe("pack/unpack", () => {
  test("round-trips a color", () => {
    const c = { r: 0x16, g: 0x1b, b: 0x22 };
    expect(pack(c)).toBe(0x161b22);
    expect(unpack(0x161b22)).toEqual(c);
  });
});

describe("mix", () => {
  test("t=0 returns a, t=1 returns b", () => {
    const a = { r: 0, g: 0, b: 0 };
    const b = { r: 100, g: 200, b: 50 };
    expect(mix(a, b, 0)).toEqual(a);
    expect(mix(a, b, 1)).toEqual(b);
  });

  test("blends and rounds per channel", () => {
    expect(mix({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5)).toEqual({
      r: 128,
      g: 128,
      b: 128,
    });
  });
});

describe("isDark", () => {
  test("classifies dark and light backgrounds", () => {
    expect(isDark({ r: 0x16, g: 0x1b, b: 0x22 })).toBe(true);
    expect(isDark({ r: 0xff, g: 0xff, b: 0xff })).toBe(false);
    expect(isDark({ r: 0xfa, g: 0xf8, b: 0xf0 })).toBe(false); // warm light
  });
});

describe("deriveTheme", () => {
  test("dark theme: selection/hover are lighter than the surface", () => {
    const t = deriveTheme({ r: 0x16, g: 0x1b, b: 0x22 });
    expect(t.surface).toBe(0x161b22);
    expect(unpack(t.selected).r).toBeGreaterThan(unpack(t.surface).r);
    expect(unpack(t.hover).r).toBeGreaterThan(unpack(t.surface).r);
    // hover is a subtler lift than selection
    expect(unpack(t.hover).r).toBeLessThan(unpack(t.selected).r);
    // shadow is darker than the surface
    expect(unpack(t.shadow).r).toBeLessThan(unpack(t.surface).r);
    expect(t.useDefaultFg).toBe(true);
  });

  test("light theme: selection/hover are darker than the surface", () => {
    const t = deriveTheme({ r: 0xfa, g: 0xfa, b: 0xfa });
    expect(t.surface).toBe(0xfafafa);
    expect(unpack(t.selected).r).toBeLessThan(unpack(t.surface).r);
    expect(unpack(t.hover).r).toBeLessThan(unpack(t.surface).r);
    expect(t.useDefaultFg).toBe(true);
  });
});

describe("parseOsc11", () => {
  test("parses a BEL-terminated 16-bit response", () => {
    expect(parseOsc11("\x1b]11;rgb:1616/1b1b/2222\x07")).toEqual({
      r: 0x16,
      g: 0x1b,
      b: 0x22,
    });
  });

  test("parses an ST-terminated response", () => {
    expect(parseOsc11("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
  });

  test("parses an 8-bit (2 hex digit) response", () => {
    expect(parseOsc11("\x1b]11;rgb:28/2c/34\x07")).toEqual({
      r: 0x28,
      g: 0x2c,
      b: 0x34,
    });
  });

  test("ignores the alpha channel of an rgba response", () => {
    expect(parseOsc11("\x1b]11;rgba:0000/0000/0000/ffff\x07")).toEqual({
      r: 0,
      g: 0,
      b: 0,
    });
  });

  test("finds the response embedded among other bytes", () => {
    const chunk = "abc\x1b]11;rgb:1212/3434/5656\x07def";
    expect(parseOsc11(chunk)).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
    const m = chunk.match(OSC11_RESPONSE_RE);
    expect(m).not.toBeNull();
    expect(m![0]).toBe("\x1b]11;rgb:1212/3434/5656\x07");
  });

  test("returns null when no response is present", () => {
    expect(parseOsc11("just some keystrokes")).toBeNull();
  });
});

describe("scanForOsc11", () => {
  test("extracts a complete reply and forwards surrounding bytes", () => {
    const scan = scanForOsc11("", "x\x1b]11;rgb:1212/3434/5656\x07y");
    expect(scan.rgb).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
    expect(scan.forward).toBe("xy");
    expect(scan.pending).toBe("");
  });

  test("holds a reply that splits across chunks, then completes it", () => {
    const first = scanForOsc11("", "\x1b]11;rgb:1616/1b1b/22");
    expect(first.rgb).toBeNull();
    expect(first.forward).toBeNull(); // swallow + wait
    expect(first.pending).toBe("\x1b]11;rgb:1616/1b1b/22");

    const second = scanForOsc11(first.pending, "22\x07");
    expect(second.rgb).toEqual({ r: 0x16, g: 0x1b, b: 0x22 });
    expect(second.forward).toBe("");
    expect(second.pending).toBe("");
  });

  test("forwards ordinary input untouched", () => {
    const scan = scanForOsc11("", "hello");
    expect(scan.rgb).toBeNull();
    expect(scan.forward).toBe("hello");
    expect(scan.pending).toBe("");
  });

  test("gives up (flushes) a started reply that grows implausibly long", () => {
    const huge = "\x1b]11;rgb:" + "a".repeat(200);
    const scan = scanForOsc11("", huge);
    expect(scan.rgb).toBeNull();
    expect(scan.forward).toBe(huge); // flushed, not swallowed forever
    expect(scan.pending).toBe("");
  });
});

describe("neutralFg", () => {
  test("uses palette under the default theme, terminal default once themed", () => {
    setTheme(DEFAULT_THEME);
    expect(neutralFg(7)).toEqual({ fg: 7, fgMode: ColorMode.Palette });

    setTheme(deriveTheme({ r: 0x16, g: 0x1b, b: 0x22 }));
    expect(neutralFg(7)).toEqual({ fg: 0, fgMode: ColorMode.Default });

    // restore for any other suite sharing module state
    setTheme(DEFAULT_THEME);
  });
});
