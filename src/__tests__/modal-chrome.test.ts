import { describe, test, expect } from "bun:test";
import { modalContentRect, drawModalChrome, type ModalChrome } from "../modal";
import { createGrid } from "../cell-grid";
import { tokens } from "../chrome-tokens";

describe("modalContentRect (Task 6 chrome primitive)", () => {
  const baseChrome: ModalChrome = {
    title: "Commands",
    count: "3 results",
    hints: [{ key: "↑↓", label: "move" }, { key: "↵", label: "run" }],
    hairlineAfterInput: true,
  };

  test("reserves title(1) + input/hairline(2) + hint(1) rows, returning the rest for content", () => {
    // outer.rows = 10: 1 title + 2 input/hairline + 1 hint = 4 chrome rows -> 6 content rows.
    const rect = modalContentRect(baseChrome, { cols: 40, rows: 10 });
    expect(rect.top).toBe(3);
    expect(rect.rows).toBe(6);
    expect(rect.left).toBe(0);
    expect(rect.cols).toBe(40);
  });

  test("without hairlineAfterInput, only title + hint are reserved", () => {
    const chrome: ModalChrome = { ...baseChrome, hairlineAfterInput: false };
    const rect = modalContentRect(chrome, { cols: 40, rows: 10 });
    expect(rect.top).toBe(1);
    expect(rect.rows).toBe(8);
  });

  test("degrades: drops the hint footer first when too short for full chrome + 1 content row", () => {
    // 1 title + 2 input/hairline + 1 hint = 4; +1 content row = 5. rows=4 can't fit that.
    // Dropping the hint (1 title + 2 = 3) leaves exactly 1 content row.
    const rect = modalContentRect(baseChrome, { cols: 40, rows: 4 });
    expect(rect.top).toBe(3);
    expect(rect.rows).toBe(1);
  });

  test("degrades further: drops the title too when even that leaves no content row", () => {
    // No hairline here — the hairline's 2-row reservation is fixed by
    // hairlineAfterInput and isn't part of this ladder (see planChrome).
    const chrome: ModalChrome = {
      title: "Commands", count: "3 results",
      hints: [{ key: "↵", label: "run" }],
      hairlineAfterInput: false,
    };
    // rows=1: title(1)+hint(1)=2 > 1 -> drop hint -> title(1) alone leaves 0
    // content rows -> drop title too -> the lone row goes entirely to content.
    const rect = modalContentRect(chrome, { cols: 40, rows: 1 });
    expect(rect.top).toBe(0);
    expect(rect.rows).toBe(1);
  });

  test("never returns negative rows", () => {
    const rect = modalContentRect(baseChrome, { cols: 40, rows: 0 });
    expect(rect.rows).toBeGreaterThanOrEqual(0);
  });
});

describe("drawModalChrome (Task 6 chrome primitive)", () => {
  test("paints the title in tokens.textPrimary bold at row 0", () => {
    const grid = createGrid(40, 8);
    const chrome: ModalChrome = { title: "Commands", hints: [], hairlineAfterInput: false };
    drawModalChrome(grid, chrome);
    const titleRow = grid.cells[0].map((c) => c.char).join("");
    expect(titleRow).toContain("Commands");
    const titleCell = grid.cells[0].find((c) => c.char === "C")!;
    expect(titleCell.fg).toBe(tokens.textPrimary.fg!);
    expect(titleCell.bold).toBe(true);
  });

  test("paints the count right-aligned in tokens.textSecondary", () => {
    const grid = createGrid(40, 8);
    const chrome: ModalChrome = { title: "Commands", count: "3 results", hints: [], hairlineAfterInput: false };
    drawModalChrome(grid, chrome);
    const titleRow = grid.cells[0].map((c) => c.char).join("");
    expect(titleRow).toContain("3 results");
    // Count sits near the right edge, not glued to the title.
    const countStart = titleRow.indexOf("3 results");
    expect(countStart).toBeGreaterThan("Commands".length + 1);
  });

  test("paints a full-width hairline when hairlineAfterInput is set", () => {
    const grid = createGrid(20, 8);
    const chrome: ModalChrome = { title: "Commands", hints: [], hairlineAfterInput: true };
    drawModalChrome(grid, chrome);
    // title(0) + input(1) + hairline(2)
    const hairlineRow = grid.cells[2].map((c) => c.char).join("");
    expect(hairlineRow.trim().length).toBeGreaterThan(0);
    expect(new Set(hairlineRow.split(""))).toEqual(new Set(["─"]));
  });

  test("does not paint a hairline row when hairlineAfterInput is false", () => {
    const grid = createGrid(20, 8);
    const chrome: ModalChrome = { title: "Commands", hints: [], hairlineAfterInput: false };
    drawModalChrome(grid, chrome);
    const row1 = grid.cells[1].map((c) => c.char).join("");
    expect(row1.trim()).toBe("");
  });

  test("paints the hint footer on the last row in the shared dialect (· separator)", () => {
    const grid = createGrid(40, 8);
    const chrome: ModalChrome = {
      title: "Commands", hints: [{ key: "↑↓", label: "move" }, { key: "↵", label: "run" }],
      hairlineAfterInput: false,
    };
    drawModalChrome(grid, chrome);
    const lastRow = grid.cells[7].map((c) => c.char).join("");
    expect(lastRow).toContain("↑↓ move");
    expect(lastRow).toContain("↵ run");
    expect(lastRow).toContain("·");
  });
});
