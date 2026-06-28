import { describe, test, expect } from "bun:test";
import { US } from "../../tmux-fields";
import {
  parseStatusLine,
  buildStatusSnapshot,
  type StatusSessionRow,
  type StatusInputs,
} from "../../cli/status";
import type { SessionLink } from "../../session-state";

function row(parts: string[]): string {
  return parts.join(US);
}

describe("parseStatusLine", () => {
  test("parses all eight fields, preserving an empty reason/issue", () => {
    const parsed = parseStatusLine(
      row(["$1", "TRA-123", "running", "1781480000", "1", "ci failed", "", "/repo/wt"]),
    );
    expect(parsed).toEqual({
      id: "$1",
      name: "TRA-123",
      agentState: "running",
      agentSince: "1781480000",
      attention: "1",
      attentionReason: "ci failed",
      linearIssue: "",
      path: "/repo/wt",
    });
  });

  test("returns null on a short line", () => {
    expect(parseStatusLine("$1\x1fname")).toBeNull();
  });

  test("parses tmux 3.4 output where the separator is octal-escaped (issue #7)", () => {
    // tmux 3.4 emits the literal text `\037` in place of the raw 0x1F byte.
    const line = ["$1", "TRA-123", "running", "1781480000", "1", "ci failed", "", "/repo/wt"].join("\\037");
    expect(parseStatusLine(line)).toEqual({
      id: "$1",
      name: "TRA-123",
      agentState: "running",
      agentSince: "1781480000",
      attention: "1",
      attentionReason: "ci failed",
      linearIssue: "",
      path: "/repo/wt",
    });
  });
});

describe("buildStatusSnapshot", () => {
  function inputs(
    rows: StatusSessionRow[],
    over: Partial<StatusInputs> = {},
  ): StatusInputs {
    return {
      rows,
      linksByName: () => [],
      pinnedNames: new Set<string>(),
      branchByPath: () => null,
      nowSeconds: 1781480123,
      ...over,
    };
  }

  const baseRow = (o: Partial<StatusSessionRow>): StatusSessionRow => ({
    id: "$1",
    name: "TRA-123",
    agentState: "",
    agentSince: "",
    attention: "",
    attentionReason: "",
    linearIssue: "",
    path: "/repo/wt",
    ...o,
  });

  test("maps a running agent with age", () => {
    const out = buildStatusSnapshot(
      inputs([baseRow({ agentState: "running", agentSince: "1781480000" })]),
    );
    expect(out.sessions[0].agent).toEqual({
      state: "running",
      since: 1781480000,
      ageSeconds: 123,
    });
  });

  test("agent is null when there is no agent state", () => {
    const out = buildStatusSnapshot(inputs([baseRow({})]));
    expect(out.sessions[0].agent).toBeNull();
  });

  test("attention is read from @jmux-attention with its reason", () => {
    const out = buildStatusSnapshot(
      inputs([baseRow({ attention: "1", attentionReason: "needs review" })]),
    );
    expect(out.sessions[0].attention).toBe(true);
    expect(out.sessions[0].attentionReason).toBe("needs review");
  });

  test("attentionReason is null when attention is not set", () => {
    const out = buildStatusSnapshot(
      inputs([baseRow({ attention: "", attentionReason: "stale" })]),
    );
    expect(out.sessions[0].attention).toBe(false);
    expect(out.sessions[0].attentionReason).toBeNull();
  });

  test("merges SessionState links with the @jmux-linear-issue option, deduped", () => {
    const links: SessionLink[] = [
      { type: "issue", id: "TRA-123" },
      { type: "mr", id: "5812" },
    ];
    const out = buildStatusSnapshot(
      inputs([baseRow({ linearIssue: "TRA-123" })], {
        linksByName: () => links,
      }),
    );
    // TRA-123 appears in both sources but only once in the result.
    expect(out.sessions[0].links).toEqual([
      { type: "issue", id: "TRA-123" },
      { type: "mr", id: "5812" },
    ]);
  });

  test("adds the tmux-option issue link when SessionState has none", () => {
    const out = buildStatusSnapshot(
      inputs([baseRow({ linearIssue: "TRA-999" })]),
    );
    expect(out.sessions[0].links).toEqual([{ type: "issue", id: "TRA-999" }]);
  });

  test("reports pinned and branch from injected sources", () => {
    const out = buildStatusSnapshot(
      inputs([baseRow({ name: "TRA-123", path: "/repo/wt" })], {
        pinnedNames: new Set(["TRA-123"]),
        branchByPath: (p) => (p === "/repo/wt" ? "TRA-123-fix" : null),
      }),
    );
    expect(out.sessions[0].pinned).toBe(true);
    expect(out.sessions[0].branch).toBe("TRA-123-fix");
  });
});
