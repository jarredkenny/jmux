import { describe, test, expect } from "bun:test";
import {
  PROMPT_ATTRS, MATCH_ATTRS, SELECTED_MATCH_ATTRS,
  CURRENT_TAG_ATTRS, SELECTED_CURRENT_TAG_ATTRS,
} from "../modal";
import { tokens } from "../chrome-tokens";

describe("modal shared attrs — accent migration (Task 6)", () => {
  test("PROMPT_ATTRS resolves to tokens.accent's fg (not green palette 2)", () => {
    expect(PROMPT_ATTRS.fg).toBe(tokens.accent.fg);
    expect(PROMPT_ATTRS.fgMode).toBe(tokens.accent.fgMode);
  });

  test("MATCH_ATTRS resolves to tokens.accent's fg (not green palette 2)", () => {
    expect(MATCH_ATTRS.fg).toBe(tokens.accent.fg);
    expect(MATCH_ATTRS.fgMode).toBe(tokens.accent.fgMode);
  });

  test("SELECTED_MATCH_ATTRS resolves to tokens.accent's fg, bold, on the selected bg", () => {
    expect(SELECTED_MATCH_ATTRS.fg).toBe(tokens.accent.fg);
    expect(SELECTED_MATCH_ATTRS.fgMode).toBe(tokens.accent.fgMode);
    expect(SELECTED_MATCH_ATTRS.bold).toBe(true);
  });

  test("CURRENT_TAG_ATTRS resolves to tokens.textPrimary's fg, bold (not yellow palette 3)", () => {
    expect(CURRENT_TAG_ATTRS.fg).toBe(tokens.textPrimary.fg);
    expect(CURRENT_TAG_ATTRS.fgMode).toBe(tokens.textPrimary.fgMode);
    expect(CURRENT_TAG_ATTRS.bold).toBe(true);
  });

  test("SELECTED_CURRENT_TAG_ATTRS resolves to tokens.textPrimary's fg, bold, on the selected bg", () => {
    expect(SELECTED_CURRENT_TAG_ATTRS.fg).toBe(tokens.textPrimary.fg);
    expect(SELECTED_CURRENT_TAG_ATTRS.fgMode).toBe(tokens.textPrimary.fgMode);
    expect(SELECTED_CURRENT_TAG_ATTRS.bold).toBe(true);
  });
});
