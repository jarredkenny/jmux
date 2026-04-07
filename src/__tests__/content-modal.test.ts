import { describe, test, expect } from "bun:test";
import { ContentModal, type StyledLine } from "../content-modal";

// 20 lines: mix of plain and styled segments
const testLines: StyledLine[] = [
  [{ text: "Line one plain" }],
  [{ text: "Bold line", attrs: { bold: true } }, { text: " normal" }],
  [{ text: "Line three" }],
  [{ text: "Line four" }],
  [{ text: "Line five" }],
  [{ text: "Line six" }],
  [{ text: "Line seven" }],
  [{ text: "Line eight" }],
  [{ text: "Line nine" }],
  [{ text: "Line ten" }],
  [{ text: "Line eleven" }],
  [{ text: "Line twelve" }],
  [{ text: "Line thirteen" }],
  [{ text: "Line fourteen" }],
  [{ text: "Line fifteen" }],
  [{ text: "Line sixteen" }],
  [{ text: "Line seventeen" }],
  [{ text: "Line eighteen" }],
  [{ text: "Line nineteen" }],
  [{ text: "Line twenty" }],
];

function makeModal(lines: StyledLine[] = testLines, title = "Test Title") {
  const modal = new ContentModal({ lines, title });
  modal.open();
  return modal;
}

describe("ContentModal", () => {
  test("opens and renders title + content lines", () => {
    const modal = makeModal();
    expect(modal.isOpen()).toBe(true);

    const grid = modal.getGrid(60);
    // Row 0: title at col 2 — bold
    expect(grid.cells[0][2].char).toBe("T");
    expect(grid.cells[0][2].bold).toBe(true);
    // Row 1: separator dashes
    expect(grid.cells[1][0].char).toBe("-");
    // Row 2: first content line "Line one plain"
    expect(grid.cells[2][2].char).toBe("L");
  });

  // termRows=14: headerRows=2, contentArea=14-2-7=5, maxScroll=20-5=15
  test("j scrolls down one line", () => {
    const modal = makeModal();
    modal.setTermRows(14);

    const before = modal.getGrid(60);
    expect(before.cells[2][2].char).toBe("L"); // "Line one plain"

    const action = modal.handleInput("j");
    expect(action.type).toBe("consumed");

    const after = modal.getGrid(60);
    expect(after.cells[2][2].char).toBe("B"); // "Bold line" (line two)
  });

  test("k scrolls up one line", () => {
    const modal = makeModal();
    modal.setTermRows(14);

    modal.handleInput("j");
    const action = modal.handleInput("k");
    expect(action.type).toBe("consumed");

    const grid = modal.getGrid(60);
    expect(grid.cells[2][2].char).toBe("L"); // back to "Line one plain"
  });

  test("k at top does nothing (stays at 0)", () => {
    const modal = makeModal();
    modal.setTermRows(14);

    modal.handleInput("k");
    const grid = modal.getGrid(60);
    expect(grid.cells[2][2].char).toBe("L"); // still "Line one plain"
  });

  test("down arrow scrolls down one line", () => {
    const modal = makeModal();
    modal.setTermRows(14);

    modal.handleInput("\x1b[B");
    const grid = modal.getGrid(60);
    expect(grid.cells[2][2].char).toBe("B"); // "Bold line"
  });

  test("up arrow scrolls up one line", () => {
    const modal = makeModal();
    modal.setTermRows(14);

    modal.handleInput("j");
    modal.handleInput("\x1b[A");
    const grid = modal.getGrid(60);
    expect(grid.cells[2][2].char).toBe("L"); // back to "Line one plain"
  });

  test("q closes (returns { type: 'closed' })", () => {
    const modal = makeModal();
    const action = modal.handleInput("q");
    expect(action.type).toBe("closed");
    expect(modal.isOpen()).toBe(false);
  });

  test("Escape closes", () => {
    const modal = makeModal();
    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
    expect(modal.isOpen()).toBe(false);
  });

  test("getCursorPosition returns null (no text cursor)", () => {
    const modal = makeModal();
    expect(modal.getCursorPosition()).toBeNull();
  });

  test("preferredWidth returns Math.min(Math.max(50, Math.round(termCols * 0.7)), 90)", () => {
    const modal = makeModal();

    expect(modal.preferredWidth(80)).toBe(Math.min(Math.max(50, Math.round(80 * 0.7)), 90));
    expect(modal.preferredWidth(200)).toBe(90);
    expect(modal.preferredWidth(60)).toBe(Math.min(Math.max(50, Math.round(60 * 0.7)), 90));
    expect(modal.preferredWidth(30)).toBe(50); // clamps to min 50
  });

  test("renders styled segments (bold text on correct cells)", () => {
    const modal = makeModal();
    modal.setTermRows(14);

    const grid = modal.getGrid(60);
    // Row 2 = "Line one plain" — not bold
    expect(grid.cells[2][2].bold).toBe(false);

    // Scroll down to show line two: "Bold line" (bold) + " normal" (not bold)
    modal.handleInput("j");
    const grid2 = modal.getGrid(60);
    // "Bold line" starts at col 2 — bold
    expect(grid2.cells[2][2].bold).toBe(true);
    // " normal" starts at col 11 (2 + 9 chars for "Bold line") — not bold
    expect(grid2.cells[2][11].bold).toBe(false);
  });

  // termRows=14: contentArea=5, maxScroll=15
  test("g scrolls to top (after scrolling down)", () => {
    const modal = makeModal();
    modal.setTermRows(14);

    modal.handleInput("j");
    modal.handleInput("j");
    modal.handleInput("j");
    modal.handleInput("g");

    const grid = modal.getGrid(60);
    expect(grid.cells[2][2].char).toBe("L"); // back to "Line one plain"
  });

  test("G scrolls to bottom", () => {
    const modal = makeModal();
    modal.setTermRows(14); // contentArea=5, maxScroll=15

    modal.handleInput("G");
    const grid = modal.getGrid(60);
    // scrollOffset=15, visible lines: 15..19 (0-indexed)
    // testLines[15] = "Line sixteen"
    expect(grid.cells[2][2].char).toBe("L"); // "Line sixteen" starts with "L"
    // Last content row shows testLines[19] = "Line twenty"
    const lastContentRow = grid.rows - 2; // row before status bar
    expect(grid.cells[lastContentRow][2].char).toBe("L"); // "Line twenty"
    // Verify it's specifically "Line twenty" by checking col 7
    expect(grid.cells[lastContentRow][7].char).toBe("t"); // "Line twenty" -> 't' at index 5 + col offset 2 = col 7
  });

  // termRows=18: headerRows=2, contentArea=9, maxScroll=11, half=floor(9/2)=4
  test("d scrolls half page down", () => {
    const modal = makeModal();
    modal.setTermRows(18);

    modal.handleInput("d");
    const grid = modal.getGrid(60);
    // scrollOffset=4, row 2 shows testLines[4] = "Line five"
    // "Line five": L(2)i(3)n(4)e(5) (6)f(7)i(8)v(9)e(10)
    expect(grid.cells[2][2].char).toBe("L");
    expect(grid.cells[2][7].char).toBe("f"); // 'f' from "five"
  });

  test("u scrolls half page up", () => {
    const modal = makeModal();
    modal.setTermRows(18); // half=4

    modal.handleInput("d"); // offset=4
    modal.handleInput("d"); // offset=8
    modal.handleInput("u"); // offset=4
    const grid = modal.getGrid(60);
    // row 2 shows testLines[4] = "Line five"
    expect(grid.cells[2][7].char).toBe("f");
  });

  test("space scrolls half page down (same as d)", () => {
    const modal = makeModal();
    modal.setTermRows(18);

    modal.handleInput(" ");
    const grid = modal.getGrid(60);
    // offset=4, row 2 shows "Line five"
    expect(grid.cells[2][7].char).toBe("f");
  });

  test("status bar is rendered on last row", () => {
    const modal = makeModal();
    modal.setTermRows(26);

    const grid = modal.getGrid(60);
    const lastRow = grid.rows - 1;
    const rowChars = grid.cells[lastRow].map((c) => c.char).join("");
    expect(rowChars).toMatch(/q/);
  });

  test("close sets isOpen to false", () => {
    const modal = makeModal();
    modal.close();
    expect(modal.isOpen()).toBe(false);
  });

  test("no title: content starts at row 0, no separator", () => {
    const modal = new ContentModal({ lines: testLines });
    modal.open();
    const grid = modal.getGrid(60);
    // Row 0 should have first content line directly
    expect(grid.cells[0][2].char).toBe("L"); // "Line one plain"
  });
});
