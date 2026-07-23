import { test, expect, describe, afterEach } from "bun:test";
import { labelChipAttrs } from "../../glass/view";
import { ColorMode } from "../../types";
import { theme, setTheme, deriveTheme, DEFAULT_THEME } from "../../theme";
import { tokens, rebuildChromeTokens } from "../../chrome-tokens";

const STALE_FOCUSED = 0x1e2a35; // old hardcoded CHIP_BG_FOCUSED
const STALE_DIM = 0x262b33;     // old hardcoded CHIP_BG_DIM

afterEach(() => setTheme(DEFAULT_THEME));

describe("labelChipAttrs — glass tile label chip tracks the theme", () => {
  test("under the default (dark) theme, backgrounds match selection/hover", () => {
    setTheme(DEFAULT_THEME);
    expect(labelChipAttrs(true).bg).toBe(theme.selected);
    expect(labelChipAttrs(false).bg).toBe(theme.hover);
    expect(labelChipAttrs(true).bgMode).toBe(ColorMode.RGB);
  });

  test("under a light theme, chip backgrounds follow the theme, not the old dark constants", () => {
    setTheme(deriveTheme({ r: 0xfa, g: 0xfa, b: 0xfa }));
    expect(labelChipAttrs(true).bg).toBe(theme.selected);
    expect(labelChipAttrs(false).bg).toBe(theme.hover);
    expect(labelChipAttrs(true).bg).not.toBe(STALE_FOCUSED);
    expect(labelChipAttrs(false).bg).not.toBe(STALE_DIM);
  });

  test("focused reads as bold, unfocused as dim, so focus is legible on any theme", () => {
    setTheme(deriveTheme({ r: 0xfa, g: 0xfa, b: 0xfa }));
    expect(labelChipAttrs(true).bold).toBe(true);
    expect(labelChipAttrs(false).dim).toBe(true);
  });

  // The focused label is a FOCUS cue, so it wears the shared accent — the same
  // one the focused border and the active window tab use. It was palette-2
  // green before, which read as "running" (a state) rather than "focused".
  test("focused label is the accent, not green", () => {
    setTheme(DEFAULT_THEME);
    rebuildChromeTokens();
    expect(labelChipAttrs(true).fg).toBe(tokens.accent.fg);
    expect(labelChipAttrs(true).fgMode).toBe(tokens.accent.fgMode);
    expect(labelChipAttrs(true).fg).not.toBe(2);
  });

  test("unfocused label is secondary text, not palette-8 by number", () => {
    setTheme(DEFAULT_THEME);
    rebuildChromeTokens();
    expect(labelChipAttrs(false).fg).toBe(tokens.textSecondary.fg);
    expect(labelChipAttrs(false).fgMode).toBe(tokens.textSecondary.fgMode);
  });
});
