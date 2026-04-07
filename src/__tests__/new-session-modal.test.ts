import { describe, test, expect } from "bun:test";
import { NewSessionModal, type NewSessionProviders, type NewSessionResult } from "../new-session-modal";

function makeProviders(overrides?: Partial<NewSessionProviders>): NewSessionProviders {
  return {
    scanProjectDirs: () => ["/home/user/project-a", "/home/user/project-b", "/home/user/bare-repo"],
    isBareRepo: (dir) => dir === "/home/user/bare-repo",
    getWorktrees: () => [
      { name: "main", path: "/home/user/bare-repo/main" },
      { name: "feature", path: "/home/user/bare-repo/feature" },
    ],
    getRemoteBranches: () => ["main", "develop", "release/v1"],
    getDefaultBranch: () => "main",
    ...overrides,
  };
}

describe("NewSessionModal", () => {
  test("opens on directory picker step — grid shows 'New Session' header", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();
    expect(modal.isOpen()).toBe(true);

    const grid = modal.getGrid(60);
    // Row 0: header "New Session"
    expect(grid.cells[0][2].char).toBe("N");
    expect(grid.cells[0][2].bold).toBe(true);
    // Should show directory items as list results
    // header + subheader (breadcrumb) + query + 3 dirs = 6 rows
    expect(grid.rows).toBeGreaterThanOrEqual(5);
  });

  test("selecting non-bare directory advances to name input", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();

    // First item is project-a (non-bare). Press Enter to select.
    const action = modal.handleInput("\r");
    expect(action.type).toBe("consumed");

    // Now we should be on the name input step
    const grid = modal.getGrid(60);
    // Header should still say "New Session"
    expect(grid.cells[0][2].char).toBe("N");
    // Should have a subheader breadcrumb with the selected dir
    expect(grid.cells[1][2].fg).toBe(8); // dim subheader
    // Input row should have the prompt
    const inputRow = 2;
    expect(grid.cells[inputRow][2].char).toBe("▷");
  });

  test("standard flow: select dir → enter name → result with type 'standard'", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();

    // Select first dir (project-a)
    modal.handleInput("\r");

    // Now on name input — default should be "project-a" (basename)
    // Type a custom name instead: clear default and type "my-proj"
    // First clear the default by backspacing
    for (let i = 0; i < "project-a".length; i++) {
      modal.handleInput("\x7f");
    }
    modal.handleInput("m");
    modal.handleInput("y");

    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    if (action.type === "result") {
      const result = action.value as NewSessionResult;
      expect(result.type).toBe("standard");
      if (result.type === "standard") {
        expect(result.dir).toBe("/home/user/project-a");
        expect(result.name).toBe("my");
      }
    }
  });

  test("bare repo flow: select bare-repo → worktree picker → select existing → result", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();

    // Navigate to bare-repo (3rd item, index 2)
    modal.handleInput("\x1b[B"); // down to project-b
    modal.handleInput("\x1b[B"); // down to bare-repo
    modal.handleInput("\r"); // select bare-repo

    // Now on worktree picker — first item should be "+ new worktree", then "main", "feature"
    const grid = modal.getGrid(60);
    // Should show worktree items
    expect(modal.isOpen()).toBe(true);

    // Select "main" (second item — skip "+ new worktree")
    modal.handleInput("\x1b[B"); // down to "main"
    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    if (action.type === "result") {
      const result = action.value as NewSessionResult;
      expect(result.type).toBe("existing_worktree");
      if (result.type === "existing_worktree") {
        expect(result.dir).toBe("/home/user/bare-repo");
        expect(result.path).toBe("/home/user/bare-repo/main");
        expect(result.branch).toBe("main");
      }
    }
  });

  test("new worktree flow: bare-repo → + new worktree → branch picker → name input → result", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();

    // Navigate to bare-repo
    modal.handleInput("\x1b[B");
    modal.handleInput("\x1b[B");
    modal.handleInput("\r");

    // Select "+ new worktree" (first item)
    modal.handleInput("\r");

    // Now on branch picker — should show remote branches with default branch pre-filled as query
    // "main" should be the default query. Select "develop" instead.
    // Clear query first
    for (let i = 0; i < "main".length; i++) {
      modal.handleInput("\x7f");
    }
    modal.handleInput("d"); // filter to "develop"
    modal.handleInput("\r"); // select develop

    // Now on name input
    // Should have some default value. Type a name.
    const cursorBefore = modal.getCursorPosition();
    // Clear any default
    for (let i = 0; i < 20; i++) modal.handleInput("\x7f");
    modal.handleInput("f");
    modal.handleInput("i");
    modal.handleInput("x");

    const action = modal.handleInput("\r");
    expect(action.type).toBe("result");
    if (action.type === "result") {
      const result = action.value as NewSessionResult;
      expect(result.type).toBe("new_worktree");
      if (result.type === "new_worktree") {
        expect(result.dir).toBe("/home/user/bare-repo");
        expect(result.baseBranch).toBe("develop");
        expect(result.name).toBe("fix");
      }
    }
  });

  test("Esc at step 1 closes wizard (returns 'closed')", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();

    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
    expect(modal.isOpen()).toBe(false);
  });

  test("Esc at step 2 goes back to step 1 (returns 'consumed', still open)", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();

    // Select first dir to advance to name input
    modal.handleInput("\r");

    // Now press Esc — should go back, not close
    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("consumed");
    expect(modal.isOpen()).toBe(true);

    // Should be back on directory picker
    const grid = modal.getGrid(60);
    // Directory picker should show list items (3 dirs + header + query = at least 5 rows)
    expect(grid.rows).toBeGreaterThanOrEqual(5);
  });

  test("Esc at step 3 goes back to step 2", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();

    // Navigate to bare-repo and select
    modal.handleInput("\x1b[B");
    modal.handleInput("\x1b[B");
    modal.handleInput("\r");

    // Select "+ new worktree"
    modal.handleInput("\r");

    // Now on branch picker (step 3). Press Esc.
    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("consumed");
    expect(modal.isOpen()).toBe(true);

    // Should be back on worktree picker — first item should be "+ new worktree"
    const grid = modal.getGrid(60);
    // Verify we're showing worktree items (the list should include "+ new worktree")
    expect(grid.rows).toBeGreaterThanOrEqual(4);
  });

  test("back-navigation preserves previous modal state (query text is intact)", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();

    // Type a query in the dir picker
    modal.handleInput("p");
    modal.handleInput("r");
    modal.handleInput("o");

    // Verify query is visible
    let cursor = modal.getCursorPosition();
    expect(cursor!.col).toBe(4 + 3); // "pro" = 3 chars

    // Select a result
    modal.handleInput("\r");

    // Now on name step. Go back.
    modal.handleInput("\x1b");

    // Should restore the dir picker with "pro" still in query
    cursor = modal.getCursorPosition();
    expect(cursor!.col).toBe(4 + 3); // "pro" still there
  });

  test("close() clears all state", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();

    // Advance a step
    modal.handleInput("\r");
    expect(modal.isOpen()).toBe(true);

    modal.close();
    expect(modal.isOpen()).toBe(false);

    // Re-open should start fresh at step 1
    modal.open();
    const grid = modal.getGrid(60);
    // Should show all 3 dirs (not the name input)
    expect(grid.rows).toBeGreaterThanOrEqual(5);
  });

  test("getCursorPosition delegates to inner modal", () => {
    const modal = new NewSessionModal(makeProviders());
    modal.open();

    // Dir picker cursor position (list modal with subheader: row 2, col 4)
    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
    expect(pos!.row).toBeGreaterThanOrEqual(1);
    expect(pos!.col).toBe(4); // no query typed yet

    // Type something
    modal.handleInput("a");
    const pos2 = modal.getCursorPosition();
    expect(pos2!.col).toBe(5); // 4 + 1
  });

  test("preferredWidth returns ListModal-compatible width", () => {
    const modal = new NewSessionModal(makeProviders());
    // Should match ListModal's formula
    expect(modal.preferredWidth(80)).toBe(Math.min(Math.max(40, Math.round(80 * 0.55)), 80));
    expect(modal.preferredWidth(200)).toBe(80);
    expect(modal.preferredWidth(20)).toBe(40);
  });
});
