import { test, expect, describe } from "bun:test";
import { borderAttrsForState, DEFAULT_BORDER_PALETTE } from "../../glass/view";
import { ColorMode } from "../../types";
import type { StateColor } from "../../state-colors";
import { tokens } from "../../chrome-tokens";

describe("borderAttrsForState", () => {
  const palette: Record<"running" | "waiting" | "complete", StateColor> = {
    running: { kind: "palette", index: 6 },
    waiting: { kind: "palette", index: 5 },
    complete: { kind: "palette", index: 7 },
  };

  // Focus outranks state: the focused tile is always the shared accent, so
  // exactly one accent border exists on screen. Unfocused tiles keep state.
  test("focused border is the accent regardless of state", () => {
    for (const state of ["running", "waiting", "complete"] as const) {
      expect(borderAttrsForState(state, true, palette)).toEqual({
        fg: tokens.accent.fg,
        fgMode: tokens.accent.fgMode,
        bold: true,
        dim: false,
      });
    }
  });

  test("focused accent does not leak the configured state palette", () => {
    // Guards the precedence direction: a configured state colour must not win
    // over focus, which would put two "focus-looking" borders on screen.
    const focused = borderAttrsForState("running", true, palette);
    expect(focused.fg).not.toBe(6);
  });

  test("uses configured palette color, dim when unfocused", () => {
    expect(borderAttrsForState("waiting", false, palette)).toEqual({
      fg: 5,
      fgMode: ColorMode.Palette,
      bold: false,
      dim: true,
    });
  });

  test("neutral kind resolves through stateAttrs to the tokens.textTertiary tone", () => {
    const neutralPalette: Record<"running" | "waiting" | "complete", StateColor> = {
      running: { kind: "palette", index: 6 },
      waiting: { kind: "palette", index: 5 },
      complete: { kind: "neutral" },
    };
    expect(borderAttrsForState("complete", false, neutralPalette)).toEqual({
      fg: tokens.textTertiary.fg,
      fgMode: tokens.textTertiary.fgMode,
      bold: false,
      dim: true,
    });
  });

  test("a stateless focused tile still gets the accent", () => {
    expect(borderAttrsForState(null, true, palette)).toEqual({
      fg: tokens.accent.fg,
      fgMode: tokens.accent.fgMode,
      bold: true,
      dim: false,
    });
  });

  test("a stateless unfocused tile falls back to the frame rule tone", () => {
    expect(borderAttrsForState(undefined, false, palette)).toEqual({
      fg: tokens.ruleFrame.fg,
      fgMode: tokens.ruleFrame.fgMode,
      bold: false,
      dim: true,
    });
  });

  test("default palette matches original green/yellow/blue", () => {
    expect(DEFAULT_BORDER_PALETTE).toEqual({
      running: { kind: "palette", index: 2 },
      waiting: { kind: "palette", index: 3 },
      complete: { kind: "palette", index: 4 },
    });
  });
});
