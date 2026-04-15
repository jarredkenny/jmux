import { describe, test, expect } from "bun:test";
import { TextAreaModal } from "../textarea-modal";

describe("TextAreaModal", () => {
  test("opens with header and empty content, grid shows header + prompt row + status bar", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();
    expect(modal.isOpen()).toBe(true);

    const grid = modal.getGrid(50, 10);
    // Row 0: header at col 2
    expect(grid.cells[0][2].char).toBe("D");
    expect(grid.cells[0][2].bold).toBe(true);
  });

  test("typing inserts characters on the current line", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("h");
    modal.handleInput("i");

    const grid = modal.getGrid(50, 10);
    // No subheader, so header=row0, content starts at row 1, col 2
    expect(grid.cells[1][2].char).toBe("h");
    expect(grid.cells[1][3].char).toBe("i");
  });

  test("Enter inserts a new line", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("\r"); // Enter = newline
    modal.handleInput("b");

    expect(modal.getValue()).toBe("a\nb");
  });

  test("Ctrl-S submits with result", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();
    modal.handleInput("h");
    modal.handleInput("i");

    const action = modal.handleInput("\x13"); // Ctrl-S
    expect(action.type).toBe("result");
    if (action.type === "result") {
      expect(action.value).toBe("hi");
    }
  });

  test("Ctrl-S on empty content returns consumed (no empty submit)", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    const action = modal.handleInput("\x13"); // Ctrl-S
    expect(action.type).toBe("consumed");
  });

  test("Escape returns closed", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
  });

  test("backspace removes character before cursor", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("b");
    modal.handleInput("c");
    modal.handleInput("\x7f"); // backspace

    expect(modal.getValue()).toBe("ab");
  });

  test("backspace at start of line joins with previous line", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("\r"); // newline
    modal.handleInput("b");
    // cursor is at line 1, col 1
    // move cursor to start of line 1
    modal.handleInput("\x01"); // Ctrl-A = home
    modal.handleInput("\x7f"); // backspace joins lines

    expect(modal.getValue()).toBe("ab");
  });

  test("arrow keys move cursor", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("b");
    modal.handleInput("c");
    // cursor at col 3
    modal.handleInput("\x1b[D"); // left
    modal.handleInput("\x1b[D"); // left
    // cursor at col 1
    modal.handleInput("X");

    expect(modal.getValue()).toBe("aXbc");
  });

  test("Ctrl-A moves to start of line", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("b");
    modal.handleInput("c");
    modal.handleInput("\x01"); // Ctrl-A
    modal.handleInput("X");

    expect(modal.getValue()).toBe("Xabc");
  });

  test("Ctrl-E moves to end of line", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("b");
    modal.handleInput("c");
    modal.handleInput("\x01"); // Ctrl-A (go to start)
    modal.handleInput("\x05"); // Ctrl-E (go to end)
    modal.handleInput("X");

    expect(modal.getValue()).toBe("abcX");
  });

  test("Ctrl-K kills from cursor to end of line", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("b");
    modal.handleInput("c");
    modal.handleInput("\x01"); // Ctrl-A
    modal.handleInput("\x1b[C"); // right once (cursor after 'a')
    modal.handleInput("\x0b"); // Ctrl-K

    expect(modal.getValue()).toBe("a");
  });

  test("getCursorPosition returns correct row and col without subheader", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("\r");
    modal.handleInput("b");
    modal.handleInput("c");

    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
    // Row: header(0) + line index 1 = row 2 (no subheader)
    expect(pos!.row).toBe(2);
    // Col: 2 (left margin) + 2 (cursor after "bc")
    expect(pos!.col).toBe(2 + 2);
  });

  test("getCursorPosition with subheader offsets rows by 1", () => {
    const modal = new TextAreaModal({ header: "Description", subheader: "Enter text" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("\r");
    modal.handleInput("b");

    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
    // Row: header(0) + subheader(1) + line index 1 = row 3
    expect(pos!.row).toBe(3);
    expect(pos!.col).toBe(2 + 1);
  });

  test("up/down arrow moves between lines", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("b");
    modal.handleInput("\r");
    modal.handleInput("c");
    modal.handleInput("d");
    modal.handleInput("\r");
    modal.handleInput("e");

    // cursor is on line 2, col 1
    modal.handleInput("\x1b[A"); // up to line 1
    modal.handleInput("X");

    expect(modal.getValue()).toBe("ab\ncXd\ne");
  });

  test("preferredWidth returns sensible width", () => {
    const modal = new TextAreaModal({ header: "Description" });
    expect(modal.preferredWidth(120)).toBeLessThanOrEqual(80);
    expect(modal.preferredWidth(30)).toBeGreaterThanOrEqual(40);
  });

  test("Delete key removes character at cursor and joins next line at end", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    // Type "abc", move left twice (cursor after "a"), press Delete — should remove "b"
    modal.handleInput("a");
    modal.handleInput("b");
    modal.handleInput("c");
    modal.handleInput("\x1b[D"); // left (after "b")
    modal.handleInput("\x1b[D"); // left (after "a")
    modal.handleInput("\x1b[3~"); // Delete

    expect(modal.getValue()).toBe("ac");

    // Reset: type "a", Enter, "b" — then arrow up, End, Delete to join lines
    const modal2 = new TextAreaModal({ header: "Description" });
    modal2.open();
    modal2.handleInput("a");
    modal2.handleInput("\r"); // newline → ["a", ""]
    modal2.handleInput("b");  // → ["a", "b"]
    modal2.handleInput("\x1b[A"); // up to line 0
    modal2.handleInput("\x1b[F"); // End — cursor at col 1 (end of "a")
    modal2.handleInput("\x1b[3~"); // Delete — should join: "ab"

    expect(modal2.getValue()).toBe("ab");
  });

  test("Ctrl-U clears current line; Alt-Backspace clears current line", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("b");
    modal.handleInput("c");
    modal.handleInput("\x15"); // Ctrl-U

    expect(modal.getValue()).toBe("");

    modal.handleInput("x");
    modal.handleInput("y");
    modal.handleInput("z");
    modal.handleInput("\x1b\x7f"); // Alt-Backspace

    expect(modal.getValue()).toBe("");
  });

  test("left arrow wraps from start of line to end of previous line", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("b");
    modal.handleInput("\r"); // newline → ["ab", ""]
    modal.handleInput("c");
    modal.handleInput("d");
    // cursor is at line 1, col 2

    modal.handleInput("\x1b[D"); // left → col 1
    modal.handleInput("\x1b[D"); // left → col 0
    modal.handleInput("\x1b[D"); // left → wraps to line 0, col 2 (end of "ab")
    modal.handleInput("X");

    expect(modal.getValue()).toBe("abX\ncd");
  });

  test("getGrid with small maxHeight doesn't crash and getCursorPosition is valid", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    // Type 6 lines: "a\nb\nc\nd\ne\nf"
    const letters = ["a", "b", "c", "d", "e", "f"];
    for (let i = 0; i < letters.length; i++) {
      modal.handleInput(letters[i]);
      if (i < letters.length - 1) modal.handleInput("\r");
    }

    // maxHeight=4: headerRows(1) + statusRows(1) = 2 overhead, 2 visible lines
    const grid = modal.getGrid(50, 4);
    expect(grid).toBeTruthy();
    expect(grid.cells.length).toBeGreaterThan(0);

    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
    expect(typeof pos!.row).toBe("number");
    expect(typeof pos!.col).toBe("number");
  });

  test("Home/End keys move to start/end of line", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("b");
    modal.handleInput("c");
    modal.handleInput("\x1b[H"); // Home
    modal.handleInput("X");
    expect(modal.getValue()).toBe("Xabc");

    modal.handleInput("\x1b[F"); // End
    modal.handleInput("Y");
    expect(modal.getValue()).toBe("XabcY");
  });

  test("pasting multi-character string inserts all characters", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("hello world");

    expect(modal.getValue()).toBe("hello world");
  });

  test("pasting multi-line string inserts with line breaks", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("line one\nline two\nline three");

    expect(modal.getValue()).toBe("line one\nline two\nline three");
  });

  test("pasting into existing content inserts at cursor position", () => {
    const modal = new TextAreaModal({ header: "Description" });
    modal.open();

    modal.handleInput("ac");
    modal.handleInput("\x1b[D"); // left once, cursor between a and c
    modal.handleInput("b");

    expect(modal.getValue()).toBe("abc");

    modal.handleInput("\x01"); // Ctrl-A to start
    modal.handleInput("PASTED ");

    expect(modal.getValue()).toBe("PASTED abc");
  });
});
