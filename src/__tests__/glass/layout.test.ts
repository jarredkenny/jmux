import { describe, test, expect } from "bun:test";
import { computeTileLayout } from "../../glass/layout";

const BASE = { minTileWidth: 80, minTileHeight: 10, focusedIndex: 0, scrollRow: 0 };

describe("computeTileLayout", () => {
  test("narrow terminal → single full-width column", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 3, mainWidth: 100, mainHeight: 90 });
    expect(l.columns).toBe(1);
    expect(l.tiles.every((t) => t.width === 100)).toBe(true);
  });

  test("wide terminal → multiple columns, never below the width floor", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 4, mainWidth: 250, mainHeight: 60 });
    expect(l.columns).toBe(3); // floor(250/80)=3
    expect(l.tiles.every((t) => t.width >= 80)).toBe(true);
  });

  test("columns clamp to tile count (no 3 columns for 1 tile)", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 1, mainWidth: 250, mainHeight: 60 });
    expect(l.columns).toBe(1);
  });

  test("rows pack after columns fill", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 5, mainWidth: 250, mainHeight: 60 });
    expect(l.columns).toBe(3);
    expect(l.rows).toBe(2); // ceil(5/3)
  });

  test("overflow scrolls and keeps the focused tile visible", () => {
    // 6 tiles, 1 column, each min height 10, screen height 25 → 2 rows visible.
    const l = computeTileLayout({
      ...BASE,
      tileCount: 6,
      mainWidth: 100,
      mainHeight: 25,
      focusedIndex: 5,
      scrollRow: 0,
    });
    expect(l.columns).toBe(1);
    const focused = l.tiles[5];
    expect(focused.visible).toBe(true); // scrolled into view
    expect(l.tiles[0].visible).toBe(false); // first row scrolled off
  });

  test("tiles fill the height when everything fits (no scroll)", () => {
    const l = computeTileLayout({ ...BASE, tileCount: 2, mainWidth: 100, mainHeight: 40 });
    expect(l.scrollRow).toBe(0);
    expect(l.tiles.every((t) => t.visible)).toBe(true);
  });
});
