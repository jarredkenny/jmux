import { test, expect, describe, afterEach } from "bun:test";
import { labelChipAttrs } from "../../glass/view";
import { ColorMode } from "../../types";
import { theme, setTheme, deriveTheme, DEFAULT_THEME } from "../../theme";

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
});
