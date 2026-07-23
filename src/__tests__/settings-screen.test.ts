import { describe, expect, test } from "bun:test";
import { SettingsScreen } from "../settings-screen";

// Coverage for the self-close path that main.ts's applyChromeLayout() re-sync
// depends on. SettingsAction has no distinct "closed" variant (handleInput
// always returns {type: "none"} on Escape/q), so the only observable signal
// of a self-close is the `isOpen` getter flipping across the handleInput
// call — which is exactly what handleSettingsInput() in main.ts now checks
// (capture isOpen before, compare after). These tests pin that seam.
describe("SettingsScreen self-close", () => {
  test("Escape closes an open screen (isOpen flips true -> false)", () => {
    const screen = new SettingsScreen();
    screen.open([]);
    expect(screen.isOpen).toBe(true);

    const action = screen.handleInput("\x1b");

    expect(screen.isOpen).toBe(false);
    expect(action).toEqual({ type: "none" });
  });

  test("'q' closes an open screen (isOpen flips true -> false)", () => {
    const screen = new SettingsScreen();
    screen.open([]);
    expect(screen.isOpen).toBe(true);

    const action = screen.handleInput("q");

    expect(screen.isOpen).toBe(false);
    expect(action).toEqual({ type: "none" });
  });

  test("navigation input does not close the screen", () => {
    const screen = new SettingsScreen();
    screen.open([]);

    screen.handleInput("\x1b[A"); // up arrow
    expect(screen.isOpen).toBe(true);

    screen.handleInput("\x1b[B"); // down arrow
    expect(screen.isOpen).toBe(true);
  });
});
