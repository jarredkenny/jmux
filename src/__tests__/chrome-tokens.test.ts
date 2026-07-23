import { describe, test, expect } from "bun:test";
import { tokens, rebuildChromeTokens, ACCENT_BASE, space, frame } from "../chrome-tokens";
import { setTheme, deriveTheme, DEFAULT_THEME } from "../theme";
import { ColorMode } from "../types";

describe("chrome tokens", () => {
  test("accent is the spec accent on a dark theme", () => {
    setTheme({ ...DEFAULT_THEME });
    rebuildChromeTokens();
    expect(tokens.accent.fg).toBe(ACCENT_BASE);
    expect(tokens.accent.fgMode).toBe(ColorMode.RGB);
  });
  test("accent darkens on a light background", () => {
    setTheme(deriveTheme({ r: 251, g: 251, b: 249 }));
    rebuildChromeTokens();
    expect(tokens.accent.fg).not.toBe(ACCENT_BASE);           // accentFor darkened it
    setTheme({ ...DEFAULT_THEME }); rebuildChromeTokens();
  });
  test("rebuild preserves object identity for live re-theming", () => {
    const ref = tokens.accent;
    rebuildChromeTokens();
    expect(tokens.accent).toBe(ref);
  });
  test("spacing scale and frame glyphs are the spec values", () => {
    expect(space).toEqual({ inset:1, modalInset:2, glyphGutter:1, groupGutter:2, blockGap:1, measure:64 });
    expect(frame.ruleHeavy).toBe("━");
    expect(frame.crossDown).toBe("┼");
    expect(frame.crossUp).toBe("┴");
  });
});
