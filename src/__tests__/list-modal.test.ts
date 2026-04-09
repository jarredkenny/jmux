import { describe, test, expect } from "bun:test";
import { ListModal, type ListItem } from "../list-modal";

const testItems: ListItem[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Charlie" },
  { id: "d", label: "Delta" },
];

describe("ListModal", () => {
  test("opens with items, renders header + query line + results", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();
    expect(modal.isOpen()).toBe(true);

    const grid = modal.getGrid(50);
    // Row 0: header at col 2
    expect(grid.cells[0][2].char).toBe("P");
    expect(grid.cells[0][2].bold).toBe(true);
    // Row 1: query line — "  ▷ " prefix
    expect(grid.cells[1][2].char).toBe("▷");
    // Rows 2..5: 4 result items
    expect(grid.rows).toBe(2 + testItems.length);
  });

  test("opens with subheader — subheader on row 1 (dim), query moves to row 2", () => {
    const modal = new ListModal({
      header: "Pick One",
      subheader: "Choose a session",
      items: testItems,
    });
    modal.open();

    const grid = modal.getGrid(50);
    // Row 0: header
    expect(grid.cells[0][2].char).toBe("P");
    // Row 1: subheader — dim (fg=8)
    expect(grid.cells[1][2].char).toBe("C");
    expect(grid.cells[1][2].fg).toBe(8);
    // Row 2: query line
    expect(grid.cells[2][2].char).toBe("▷");
    // Rows 3..6: 4 result items
    expect(grid.rows).toBe(3 + testItems.length);
  });

  test("typing filters results via fuzzy matching", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("l"); // "al" matches Alpha (a,l) and Charlie (a,l)
    const grid = modal.getGrid(50);
    // header + query + results (Alpha and Charlie match "al")
    expect(grid.rows).toBe(2 + 2);
  });

  test("arrow down moves selection (wraps)", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();

    const grid0 = modal.getGrid(50);
    // First result row should have selection indicator at col 1
    const queryRow = 1;
    const firstResultRow = queryRow + 1;
    expect(grid0.cells[firstResultRow][1].char).toBe("▸");

    // Move down once
    modal.handleInput("\x1b[B");
    const grid1 = modal.getGrid(50);
    expect(grid1.cells[firstResultRow][1].char).not.toBe("▸");
    expect(grid1.cells[firstResultRow + 1][1].char).toBe("▸");

    // Move down to last, then wrap
    modal.handleInput("\x1b[B");
    modal.handleInput("\x1b[B");
    modal.handleInput("\x1b[B"); // wrap around
    const grid2 = modal.getGrid(50);
    expect(grid2.cells[firstResultRow][1].char).toBe("▸");
  });

  test("Enter returns { type: 'result', value: selectedItem }", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();

    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    if (action.type === "result") {
      const item = action.value as ListItem;
      expect(item.id).toBe("a");
      expect(item.label).toBe("Alpha");
    }
  });

  test("alt+backspace clears entire query", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("l");
    modal.handleInput("\x1b\x7f"); // alt+backspace
    const grid = modal.getGrid(50);
    // All items visible again: header + query + 4 items
    expect(grid.rows).toBe(2 + testItems.length);
  });

  test("ctrl-u clears entire query", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();

    modal.handleInput("a");
    modal.handleInput("l");
    modal.handleInput("\x15"); // ctrl-u
    const grid = modal.getGrid(50);
    expect(grid.rows).toBe(2 + testItems.length);
  });

  test("Enter with no filtered results returns { type: 'consumed' }", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();

    // Type something that matches nothing
    modal.handleInput("z");
    modal.handleInput("z");
    modal.handleInput("z");

    const action = modal.handleInput("\r");
    expect(action.type).toBe("consumed");
  });

  test("Escape returns { type: 'closed' }", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();

    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
    expect(modal.isOpen()).toBe(false);
  });

  test("getCursorPosition returns { row: queryRow, col: 4 + query.length }", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();

    // No subheader: queryRow = 1
    let pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
    expect(pos!.row).toBe(1);
    expect(pos!.col).toBe(4); // 4 + 0

    modal.handleInput("a");
    modal.handleInput("b");
    pos = modal.getCursorPosition();
    expect(pos!.col).toBe(6); // 4 + 2
  });

  test("getCursorPosition with subheader has queryRow = 2", () => {
    const modal = new ListModal({
      header: "Pick One",
      subheader: "Sub",
      items: testItems,
    });
    modal.open();

    modal.handleInput("x");
    const pos = modal.getCursorPosition();
    expect(pos!.row).toBe(2);
    expect(pos!.col).toBe(5); // 4 + 1
  });

  test("preferredWidth returns Math.min(Math.max(40, Math.round(termCols * 0.55)), 80)", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });

    expect(modal.preferredWidth(80)).toBe(Math.min(Math.max(40, Math.round(80 * 0.55)), 80));
    expect(modal.preferredWidth(200)).toBe(80);
    expect(modal.preferredWidth(50)).toBe(Math.min(Math.max(40, Math.round(50 * 0.55)), 80));
    expect(modal.preferredWidth(20)).toBe(40); // clamps to min 40
  });

  test("defaultQuery pre-fills the filter", () => {
    const modal = new ListModal({
      header: "Pick One",
      items: testItems,
      defaultQuery: "al",
    });
    modal.open();

    // "al" matches Alpha (and possibly Charlie)
    const pos = modal.getCursorPosition();
    expect(pos!.col).toBe(4 + 2); // 4 + "al".length

    // Grid should show filtered results
    const grid = modal.getGrid(50);
    // Alpha matches "al"; "al" in Charlie: c-h-a-r-l-i-e -> a at 2, l at 4, yes
    // Actually let's just verify the query was applied by checking cursor col
    expect(grid.cells[1][4].char).toBe("a");
    expect(grid.cells[1][5].char).toBe("l");
  });

  test("updateItems replaces the items and refilters with current query", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();
    modal.handleInput("a"); // query = "a" — matches Alpha, Charlie, Delta

    // Replace items with a new set that includes a match and a non-match
    modal.updateItems([
      { id: "x", label: "Aardvark" },
      { id: "y", label: "Zebra" },
      { id: "z", label: "Apple" },
    ]);

    const grid = modal.getGrid(50);
    // Query row still shows "a" (query preserved)
    expect(grid.cells[1][4].char).toBe("a");
    // First result row should now be Aardvark (matches "a") — selected
    expect(grid.cells[2][1].char).toBe("▸");
    expect(grid.cells[2][3].char).toBe("A");
    expect(grid.cells[2][4].char).toBe("a");
    expect(grid.cells[2][5].char).toBe("r");
  });

  test("updateItems while modal is closed does not crash", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    // Don't open
    expect(() => {
      modal.updateItems([{ id: "new", label: "New" }]);
    }).not.toThrow();
  });

  test("updateItems clamps selectedIndex when new list is smaller", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();
    modal.handleInput("\x1b[B"); // selectedIndex = 1
    modal.handleInput("\x1b[B"); // selectedIndex = 2
    modal.handleInput("\x1b[B"); // selectedIndex = 3

    modal.updateItems([{ id: "only", label: "Only" }]);

    const grid = modal.getGrid(50);
    // Selection indicator should be on the single item (row 2)
    expect(grid.cells[2][1].char).toBe("▸");
  });

  test("close() resets state", () => {
    const modal = new ListModal({ header: "Pick One", items: testItems });
    modal.open();
    modal.handleInput("a");
    modal.handleInput("\x1b[B");

    modal.close();
    expect(modal.isOpen()).toBe(false);

    // Re-open should start fresh
    modal.open();
    const pos = modal.getCursorPosition();
    expect(pos!.col).toBe(4); // no query
    const grid = modal.getGrid(50);
    // Selection back at first item
    expect(grid.cells[2][1].char).toBe("▸");
  });
});
