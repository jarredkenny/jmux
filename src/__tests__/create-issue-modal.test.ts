import { describe, test, expect } from "bun:test";
import { CreateIssueModal } from "../create-issue-modal";

describe("CreateIssueModal", () => {
  const teams = [
    { id: "team-1", name: "Engineering" },
    { id: "team-2", name: "Platform" },
  ];

  test("opens with team picker, pre-selects team when preselectedTeamId is provided", () => {
    const modal = new CreateIssueModal({ teams, preselectedTeamId: "team-1" });
    modal.open();
    expect(modal.isOpen()).toBe(true);
    const grid = modal.getGrid(60);
    expect(grid.rows).toBeGreaterThan(0);
  });

  test("opens with team picker, no pre-selection when preselectedTeamId is null", () => {
    const modal = new CreateIssueModal({ teams, preselectedTeamId: null });
    modal.open();
    expect(modal.isOpen()).toBe(true);
  });

  test("selecting a team advances to title step", () => {
    const modal = new CreateIssueModal({ teams, preselectedTeamId: null });
    modal.open();
    const action = modal.handleInput("\r"); // Enter on first team
    expect(action.type).toBe("consumed");
    expect(modal.isOpen()).toBe(true);
  });

  test("full wizard flow: team → title → description → result", () => {
    const modal = new CreateIssueModal({ teams, preselectedTeamId: null });
    modal.open();

    // Step 1: select team (first one is highlighted by default)
    modal.handleInput("\r");

    // Step 2: type title and submit
    for (const ch of "Fix bug") modal.handleInput(ch);
    modal.handleInput("\r"); // submit title

    // Step 3: type description and submit with Ctrl-S
    for (const ch of "Desc") modal.handleInput(ch);
    const action = modal.handleInput("\x13"); // Ctrl-S

    expect(action.type).toBe("result");
    if (action.type === "result") {
      const result = action.value as { teamId: string; title: string; description: string };
      expect(result.teamId).toBe("team-1");
      expect(result.title).toBe("Fix bug");
      expect(result.description).toBe("Desc");
    }
  });

  test("Escape on team step closes modal", () => {
    const modal = new CreateIssueModal({ teams, preselectedTeamId: null });
    modal.open();
    const action = modal.handleInput("\x1b");
    expect(action.type).toBe("closed");
    expect(modal.isOpen()).toBe(false);
  });

  test("Escape on title step goes back to team step", () => {
    const modal = new CreateIssueModal({ teams, preselectedTeamId: null });
    modal.open();
    modal.handleInput("\r"); // select team
    const action = modal.handleInput("\x1b"); // back
    expect(action.type).toBe("consumed");
    expect(modal.isOpen()).toBe(true);
  });

  test("Escape on description step goes back to title step", () => {
    const modal = new CreateIssueModal({ teams, preselectedTeamId: null });
    modal.open();
    modal.handleInput("\r"); // team
    modal.handleInput("T");
    modal.handleInput("\r"); // title
    const action = modal.handleInput("\x1b"); // back
    expect(action.type).toBe("consumed");
    expect(modal.isOpen()).toBe(true);
  });

  test("getCursorPosition delegates to inner modal", () => {
    const modal = new CreateIssueModal({ teams, preselectedTeamId: null });
    modal.open();
    const pos = modal.getCursorPosition();
    expect(pos).not.toBeNull();
  });
});
