import { test, expect, describe } from "bun:test";
import { borderAttrsForState, DEFAULT_BORDER_PALETTE } from "../../glass/view";
import { ColorMode } from "../../types";

describe("borderAttrsForState", () => {
  const palette = { running: 6, waiting: 5, complete: 7 };

  test("uses configured palette color, bold when focused", () => {
    expect(borderAttrsForState("running", true, palette)).toEqual({
      fg: 6,
      fgMode: ColorMode.Palette,
      bold: true,
      dim: false,
    });
  });

  test("uses configured palette color, dim when unfocused", () => {
    expect(borderAttrsForState("waiting", false, palette)).toEqual({
      fg: 5,
      fgMode: ColorMode.Palette,
      bold: false,
      dim: true,
    });
  });

  test("falls back to bright-white when focused and no state", () => {
    expect(borderAttrsForState(null, true, palette)).toEqual({
      fg: 15,
      fgMode: ColorMode.Palette,
      bold: false,
      dim: false,
    });
  });

  test("falls back to dark-gray when unfocused and no state", () => {
    expect(borderAttrsForState(undefined, false, palette)).toEqual({
      fg: 8,
      fgMode: ColorMode.Palette,
      bold: false,
      dim: false,
    });
  });

  test("default palette matches original green/yellow/blue", () => {
    expect(DEFAULT_BORDER_PALETTE).toEqual({ running: 2, waiting: 3, complete: 4 });
  });
});
