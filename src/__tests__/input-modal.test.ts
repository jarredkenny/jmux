import { describe, test, expect } from "bun:test";
import { InputModal } from "../input-modal";

describe("InputModal", () => {
  test("opens with pre-filled value, grid shows header (bold) and input line with value", () => {
    const modal = new InputModal({ header: "Rename Session", value: "my-session" });
    modal.open();
    expect(modal.isOpen()).toBe(true);

    const grid = modal.getGrid(50);
    // Row 0: header at col 2
    expect(grid.cells[0][2].char).toBe("R");
    expect(grid.cells[0][2].bold).toBe(true);
    // Row 1: prompt then value
    expect(grid.cells[1][2].char).toBe("▷");
    expect(grid.cells[1][4].char).toBe("m");
    expect(grid.cells[1][5].char).toBe("y");
  });

  test("opens with subheader — grid row 1 is subheader (dim), input row moves to row 2", () => {
    const modal = new InputModal({
      header: "Rename Session",
      subheader: "Current: my-session",
      value: "my-session",
    });
    modal.open();

    const grid = modal.getGrid(50);
    // Row 0: header
    expect(grid.cells[0][2].char).toBe("R");
    // Row 1: subheader — first char at col 2, uses palette color 8 (dim gray)
    expect(grid.cells[1][2].char).toBe("C");
    expect(grid.cells[1][2].fg).toBe(8);
    // Row 2: prompt
    expect(grid.cells[2][2].char).toBe("▷");
    // Grid should have 3 rows
    expect(grid.rows).toBe(3);
  });

  test("typing appends characters to value", () => {
    const modal = new InputModal({ header: "Rename Session", value: "" });
    modal.open();

    modal.handleInput("f");
    modal.handleInput("o");
    modal.handleInput("o");

    const grid = modal.getGrid(50);
    expect(grid.cells[1][4].char).toBe("f");
    expect(grid.cells[1][5].char).toBe("o");
    expect(grid.cells[1][6].char).toBe("o");
  });

  test("backspace removes last character", () => {
    const modal = new InputModal({ header: "Rename Session", value: "abc" });
    modal.open();

    modal.handleInput("\x7f"); // backspace
    const grid = modal.getGrid(50);
    // value is now "ab"
    expect(grid.cells[1][4].char).toBe("a");
    expect(grid.cells[1][5].char).toBe("b");
    // col 6 should be space (no char)
    expect(grid.cells[1][6].char).toBe(" ");
  });

  test("Enter returns { type: 'result', value: 'the-text' }", () => {
    const modal = new InputModal({ header: "Rename Session", value: "hello" });
    modal.open();

    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    if (action.type === "result") {
      expect(action.value).toBe("hello");
    }
  });

  test("Enter on empty value returns { type: 'consumed' }", () => {
    const modal = new InputModal({ header: "Rename Session", value: "" });
    modal.open();

    const action = modal.handleInput("\r");
    expect(action.type).toBe("consumed");
  });

  test("Escape returns { type: 'closed' }", () => {
    const modal = new InputModal({ header: "Rename Session", value: "hello" });
    modal.open();

    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
  });

  test("getCursorPosition returns correct { row, col } without subheader", () => {
    const modal = new InputModal({ header: "Rename Session", value: "abc" });
    modal.open();

    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
    expect(pos!.row).toBe(1);
    expect(pos!.col).toBe(4 + 3); // "  ▷ " prefix (4) + value length (3)
  });

  test("getCursorPosition returns correct { row, col } with subheader", () => {
    const modal = new InputModal({
      header: "Rename Session",
      subheader: "Current: my-session",
      value: "hello",
    });
    modal.open();

    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
    expect(pos!.row).toBe(2);
    expect(pos!.col).toBe(4 + 5); // 4 + "hello".length
  });

  test("preferredWidth returns Math.min(Math.max(40, Math.round(termCols * 0.45)), 60)", () => {
    const modal = new InputModal({ header: "Rename Session" });

    expect(modal.preferredWidth(80)).toBe(Math.min(Math.max(40, Math.round(80 * 0.45)), 60));
    expect(modal.preferredWidth(200)).toBe(60);
    expect(modal.preferredWidth(50)).toBe(Math.min(Math.max(40, Math.round(50 * 0.45)), 60));
    expect(modal.preferredWidth(20)).toBe(40); // clamps to min 40
  });

  test("close() sets isOpen to false", () => {
    const modal = new InputModal({ header: "Rename Session" });
    modal.open();
    expect(modal.isOpen()).toBe(true);
    modal.close();
    expect(modal.isOpen()).toBe(false);
  });
});
