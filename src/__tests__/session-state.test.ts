import { describe, test, expect } from "bun:test";
import { SessionState } from "../session-state";
import { unlinkSync, existsSync } from "fs";

function tmpPath(): string {
  return `/tmp/jmux-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
}

describe("SessionState", () => {
  test("loads empty state from nonexistent file", () => {
    const state = new SessionState("/tmp/nonexistent-jmux-state.json");
    expect(state.getLinks("test")).toEqual([]);
  });

  test("addLink and getLinks", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("api", { type: "issue", id: "ENG-1234" });
    state.addLink("api", { type: "mr", id: "12345:42" });
    expect(state.getLinks("api")).toEqual([
      { type: "issue", id: "ENG-1234" },
      { type: "mr", id: "12345:42" },
    ]);
    if (existsSync(path)) unlinkSync(path);
  });

  test("addLink deduplicates", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("api", { type: "issue", id: "ENG-1234" });
    state.addLink("api", { type: "issue", id: "ENG-1234" });
    expect(state.getLinks("api")).toHaveLength(1);
    if (existsSync(path)) unlinkSync(path);
  });

  test("removeLink", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("api", { type: "issue", id: "ENG-1234" });
    state.addLink("api", { type: "issue", id: "ENG-1235" });
    state.removeLink("api", { type: "issue", id: "ENG-1234" });
    expect(state.getLinks("api")).toEqual([{ type: "issue", id: "ENG-1235" }]);
    if (existsSync(path)) unlinkSync(path);
  });

  test("removeLink no-op for missing link", () => {
    const state = new SessionState(tmpPath());
    state.removeLink("api", { type: "issue", id: "ENG-9999" });
    expect(state.getLinks("api")).toEqual([]);
  });

  test("renameSession migrates links", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("old-name", { type: "issue", id: "ENG-1234" });
    state.renameSession("old-name", "new-name");
    expect(state.getLinks("old-name")).toEqual([]);
    expect(state.getLinks("new-name")).toEqual([{ type: "issue", id: "ENG-1234" }]);
    if (existsSync(path)) unlinkSync(path);
  });

  test("pruneSessions removes dead sessions", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("alive", { type: "issue", id: "ENG-1" });
    state.addLink("dead", { type: "issue", id: "ENG-2" });
    state.pruneSessions(new Set(["alive"]));
    expect(state.getLinks("alive")).toHaveLength(1);
    expect(state.getLinks("dead")).toEqual([]);
    if (existsSync(path)) unlinkSync(path);
  });

  test("persists to disk and reloads", () => {
    const path = tmpPath();
    const state1 = new SessionState(path);
    state1.addLink("api", { type: "issue", id: "ENG-1234" });
    const state2 = new SessionState(path);
    expect(state2.getLinks("api")).toEqual([{ type: "issue", id: "ENG-1234" }]);
    if (existsSync(path)) unlinkSync(path);
  });

  test("getLinkedIssueIds and getLinkedMrIds", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("api", { type: "issue", id: "ENG-1234" });
    state.addLink("api", { type: "mr", id: "12345:42" });
    state.addLink("api", { type: "issue", id: "ENG-1235" });
    expect(state.getLinkedIssueIds("api")).toEqual(["ENG-1234", "ENG-1235"]);
    expect(state.getLinkedMrIds("api")).toEqual(["12345:42"]);
    if (existsSync(path)) unlinkSync(path);
  });
});
