import { describe, test, expect } from "bun:test";
import {
  AGENT_DETECT_FORMAT,
  parseAgentDetectLines,
  detectAgentPanes,
} from "../../glass/auto-detect";

describe("parseAgentDetectLines", () => {
  test("parses the four US-separated fields", () => {
    const rows = parseAgentDetectLines([
      "%1\x1frunning\x1f1\x1f2.1.177",
      "%2\x1f\x1f0\x1fzsh",
    ]);
    expect(rows).toEqual([
      { paneId: "%1", agentState: "running", active: true, command: "2.1.177" },
      { paneId: "%2", agentState: "", active: false, command: "zsh" },
    ]);
  });

  test("AGENT_DETECT_FORMAT requests the four fields", () => {
    expect(AGENT_DETECT_FORMAT).toBe(
      "#{pane_id}\x1f#{@jmux-agent-state}\x1f#{pane_active}\x1f#{pane_current_command}",
    );
  });
});

describe("detectAgentPanes", () => {
  const rows = [
    { paneId: "%1", agentState: "running", active: true, command: "2.1.177" },  // Claude (active agent session)
    { paneId: "%2", agentState: "running", active: false, command: "zsh" },     // agent session but not active pane
    { paneId: "%3", agentState: "", active: true, command: "codex" },           // Codex via command match
    { paneId: "%4", agentState: "", active: true, command: "vim" },             // unrelated
  ];

  test("detects active panes of agent sessions + command matches", () => {
    const got = detectAgentPanes(rows, "codex");
    expect([...got].sort()).toEqual(["%1", "%3"]);
  });

  test("non-active pane of an agent session is not auto-detected", () => {
    expect(detectAgentPanes(rows, "codex").has("%2")).toBe(false);
  });

  test("null/empty regex disables the command signal (Claude still detected)", () => {
    expect([...detectAgentPanes(rows, null)]).toEqual(["%1"]);
    expect([...detectAgentPanes(rows, "")]).toEqual(["%1"]);
  });

  test("invalid regex is ignored, not thrown", () => {
    expect(() => detectAgentPanes(rows, "(")).not.toThrow();
    expect([...detectAgentPanes(rows, "(")]).toEqual(["%1"]);
  });

  test("regex is case-insensitive", () => {
    const got = detectAgentPanes([{ paneId: "%9", agentState: "", active: true, command: "CODEX" }], "codex");
    expect(got.has("%9")).toBe(true);
  });
});
