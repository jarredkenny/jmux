import { describe, test, expect } from "bun:test";
import { packChips, chipAtCol, type PlacedChip } from "../band-layout";

describe("packChips — left align", () => {
  test("packs chips left to right starting at start, with no gap by default", () => {
    const chips = packChips(
      [{ id: "a", width: 3 }, { id: "b", width: 4 }],
      { start: 0, budget: 100, align: "left" },
    );
    expect(chips).toEqual([
      { id: "a", x: 0, width: 3 },
      { id: "b", x: 3, width: 4 },
    ]);
  });

  test("start offsets the whole run", () => {
    const chips = packChips(
      [{ id: "a", width: 3 }, { id: "b", width: 4 }],
      { start: 1, budget: 100, align: "left" },
    );
    expect(chips[0]).toEqual({ id: "a", x: 1, width: 3 });
    expect(chips[1]).toEqual({ id: "b", x: 4, width: 4 });
  });

  test("gap inserts blank columns between adjacent chips", () => {
    const chips = packChips(
      [{ id: "a", width: 3 }, { id: "b", width: 4 }, { id: "c", width: 2 }],
      { start: 0, budget: 100, align: "left", gap: 2 },
    );
    // a: x=0..2, gap 2 cols (3,4), b starts at 5
    expect(chips[0]).toEqual({ id: "a", x: 0, width: 3 });
    expect(chips[1]).toEqual({ id: "b", x: 5, width: 4 });
    // b ends at 8, gap 2 cols (9,10), c starts at 11
    expect(chips[2]).toEqual({ id: "c", x: 11, width: 2 });
  });

  test("sepWidth is additional separator width, additive with gap", () => {
    const chips = packChips(
      [{ id: "a", width: 3 }, { id: "b", width: 4 }],
      { start: 0, budget: 100, align: "left", gap: 1, sepWidth: 3 },
    );
    // a: x=0..2, then gap(1) + sepWidth(3) = 4 blank cols, b starts at 3+4=7
    expect(chips[0]).toEqual({ id: "a", x: 0, width: 3 });
    expect(chips[1]).toEqual({ id: "b", x: 7, width: 4 });
  });

  test("a chip that would only partially fit is dropped, not clipped", () => {
    const chips = packChips(
      [{ id: "a", width: 5 }, { id: "b", width: 5 }],
      { start: 0, budget: 8, align: "left" },
    );
    // a fits (0..4). b would need 5..9 but budget is 8 (col+width>budget => 5+5=10>8) — dropped whole.
    expect(chips.length).toBe(1);
    expect(chips[0]).toEqual({ id: "a", x: 0, width: 5 });
  });

  test("overflow stops packing — a later chip that would fit on its own is still dropped", () => {
    const chips = packChips(
      [{ id: "a", width: 5 }, { id: "b", width: 5 }, { id: "c", width: 1 }],
      { start: 0, budget: 8, align: "left" },
    );
    // b overflows at index 1 and packing stops there; c (which would fit in
    // isolation) must NOT be placed out of order — whole-chip, contiguous
    // packing only, not best-fit.
    expect(chips.length).toBe(1);
    expect(chips.map((c) => c.id)).toEqual(["a"]);
  });

  test("budget exactly at the boundary keeps the chip (col+width === budget)", () => {
    const chips = packChips(
      [{ id: "a", width: 5 }],
      { start: 0, budget: 5, align: "left" },
    );
    expect(chips).toEqual([{ id: "a", x: 0, width: 5 }]);
  });

  test("empty items yields empty placement", () => {
    expect(packChips([], { start: 0, budget: 100, align: "left" })).toEqual([]);
  });
});

describe("packChips — right align", () => {
  test("packs chips from the right edge (start) leftward, last item anchored to start", () => {
    const chips = packChips(
      [{ id: "a", width: 3 }, { id: "b", width: 4 }],
      { start: 10, budget: -Infinity, align: "right" },
    );
    // b is the last item — it anchors to the right edge: x = start - width = 6
    // a sits to its left: x = 6 - 3 = 3
    expect(chips).toEqual([
      { id: "a", x: 3, width: 3 },
      { id: "b", x: 6, width: 4 },
    ]);
  });

  test("gap inserts blank columns between adjacent chips, right-aligned", () => {
    const chips = packChips(
      [{ id: "a", width: 3 }, { id: "b", width: 4 }],
      { start: 10, budget: -Infinity, align: "right", gap: 2 },
    );
    // b anchors at x=6 (10-4). a is placed at 6 - 2(gap) - 3(width) = 1
    expect(chips[1]).toEqual({ id: "b", x: 6, width: 4 });
    expect(chips[0]).toEqual({ id: "a", x: 1, width: 3 });
  });

  test("a chip that would cross budget going left is dropped, not clipped", () => {
    // b anchors at x=5 (10-5), which is >= budget(2), kept.
    // a would need x=0 (5-5), which is < budget(2) — dropped whole.
    const chips = packChips(
      [{ id: "a", width: 5 }, { id: "b", width: 5 }],
      { start: 10, budget: 2, align: "right" },
    );
    expect(chips.length).toBe(1);
    expect(chips[0].id).toBe("b");
  });

  test("empty items yields empty placement", () => {
    expect(packChips([], { start: 0, budget: 0, align: "right" })).toEqual([]);
  });
});

describe("chipAtCol", () => {
  const chips: PlacedChip[] = [
    { id: "a", x: 0, width: 3 },   // cols 0,1,2
    { id: "b", x: 5, width: 4 },   // cols 5,6,7,8 (gap at 3,4)
  ];

  test("first column of a chip hits it", () => {
    expect(chipAtCol(chips, 0)).toBe("a");
    expect(chipAtCol(chips, 5)).toBe("b");
  });

  test("last column of a chip hits it", () => {
    expect(chipAtCol(chips, 2)).toBe("a");
    expect(chipAtCol(chips, 8)).toBe("b");
  });

  test("one column past a chip's last column misses", () => {
    expect(chipAtCol(chips, 3)).toBeNull();
    expect(chipAtCol(chips, 9)).toBeNull();
  });

  test("the gap between two chips returns null", () => {
    expect(chipAtCol(chips, 3)).toBeNull();
    expect(chipAtCol(chips, 4)).toBeNull();
  });

  test("a column before the first chip returns null", () => {
    const offsetChips: PlacedChip[] = [{ id: "a", x: 2, width: 3 }];
    expect(chipAtCol(offsetChips, 0)).toBeNull();
    expect(chipAtCol(offsetChips, 1)).toBeNull();
  });

  test("empty chip list always misses", () => {
    expect(chipAtCol([], 0)).toBeNull();
  });
});
