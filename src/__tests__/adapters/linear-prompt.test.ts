import { describe, test, expect } from "bun:test";
import { buildLinearPrompt } from "../../adapters/linear-prompt";
import type { Issue } from "../../adapters/types";

describe("buildLinearPrompt", () => {
  test("matches Linear's copy-prompt format for a fully-populated issue", () => {
    const description =
      "![image.png](https://uploads.linear.app/a.png)\n\n" +
      "![image.png](https://uploads.linear.app/b.png)\n\n" +
      "![image.png](https://uploads.linear.app/c.png)";

    const longBody =
      "**ISSUE**:\n\n" +
      "Unable to reset password through login screen.\n\n" +
      "**DESCRIPTION**:\n\n" +
      "Currently testing the Password Reset flow and it appears my password reset request is not generating an email to my inbox.";

    const issue: Issue = {
      id: "issue-tra-521",
      identifier: "TRA-521",
      title: "Login Password Reset",
      status: "In Progress",
      assignee: null,
      linkedMrUrls: [],
      webUrl: "https://linear.app/x/issue/TRA-521",
      team: "Core Engineering",
      project: "Login Screen Redesign",
      description,
      labels: [
        { name: "Improvement", group: "Type" },
        { name: "Blocks Feature Flag Release", group: "Blocker" },
        { name: "Matt", group: "QA" },
      ],
      comments: [
        {
          id: "c216ffc4-6857-44fc-ad09-984b388a1e15",
          author: "Matt Savidant",
          createdAt: "2026-04-22T17:18:07.981Z",
          body: longBody,
        },
        {
          id: "62395d32-a43b-417f-ba35-17cca513d762",
          author: "Matt Savidant",
          createdAt: "2026-04-22T17:20:18.673Z",
          body: "Switched to a higher priority since this is affecting production.",
        },
      ],
    };

    const expected =
      `Work on Linear issue TRA-521:\n` +
      `\n` +
      `<issue identifier="TRA-521">\n` +
      `<title>Login Password Reset</title>\n` +
      `<description>\n` +
      `${description}\n` +
      `</description>\n` +
      `<team name="Core Engineering"/>\n` +
      `<label>Type › Improvement</label>\n` +
      `<label>Blocker › Blocks Feature Flag Release</label>\n` +
      `<label>QA › Matt</label>\n` +
      `<project name="Login Screen Redesign"/>\n` +
      `</issue>\n` +
      `\n` +
      `<comment-thread comment-id="c216ffc4-6857-44fc-ad09-984b388a1e15">\n` +
      `<comment author="Matt Savidant" created-at="2026-04-22T17:18:07.981Z">\n` +
      `${longBody}\n` +
      `</comment>\n` +
      `</comment-thread>\n` +
      `\n` +
      `<comment-thread comment-id="62395d32-a43b-417f-ba35-17cca513d762"><comment author="Matt Savidant" created-at="2026-04-22T17:20:18.673Z">Switched to a higher priority since this is affecting production.</comment></comment-thread>`;

    expect(buildLinearPrompt(issue)).toBe(expected);
  });

  test("nests replies inside their root thread", () => {
    const issue: Issue = {
      id: "i1",
      identifier: "ENG-1",
      title: "T",
      status: "Todo",
      assignee: null,
      linkedMrUrls: [],
      webUrl: "",
      comments: [
        { id: "root-1", author: "alice", createdAt: "t1", body: "first" },
        { id: "reply-1", parentId: "root-1", author: "bob", createdAt: "t2", body: "reply to first" },
        { id: "root-2", author: "carol", createdAt: "t3", body: "second" },
        { id: "reply-2", parentId: "reply-1", author: "dan", createdAt: "t4", body: "reply to reply" },
      ],
    };
    const out = buildLinearPrompt(issue);
    expect(out).toContain(
      `<comment-thread comment-id="root-1">\n` +
        `<comment author="alice" created-at="t1">first</comment>\n` +
        `<comment author="bob" created-at="t2">reply to first</comment>\n` +
        `<comment author="dan" created-at="t4">reply to reply</comment>\n` +
        `</comment-thread>`,
    );
    expect(out).toContain(
      `<comment-thread comment-id="root-2"><comment author="carol" created-at="t3">second</comment></comment-thread>`,
    );
  });

  test("omits description, team, project, labels, and comments when missing", () => {
    const issue: Issue = {
      id: "i1",
      identifier: "ENG-2",
      title: "Bare issue",
      status: "Todo",
      assignee: null,
      linkedMrUrls: [],
      webUrl: "",
    };
    expect(buildLinearPrompt(issue)).toBe(
      `Work on Linear issue ENG-2:\n` +
        `\n` +
        `<issue identifier="ENG-2">\n` +
        `<title>Bare issue</title>\n` +
        `</issue>`,
    );
  });

  test("omits group prefix for ungrouped labels", () => {
    const issue: Issue = {
      id: "i1",
      identifier: "ENG-3",
      title: "T",
      status: "Todo",
      assignee: null,
      linkedMrUrls: [],
      webUrl: "",
      labels: [{ name: "bug" }, { name: "P0", group: "Priority" }],
    };
    const out = buildLinearPrompt(issue);
    expect(out).toContain(`<label>bug</label>`);
    expect(out).toContain(`<label>Priority › P0</label>`);
  });

  test("treats comments without ids as separate threads with no comment-id attribute", () => {
    const issue: Issue = {
      id: "i1",
      identifier: "ENG-4",
      title: "T",
      status: "Todo",
      assignee: null,
      linkedMrUrls: [],
      webUrl: "",
      comments: [
        { author: "x", createdAt: "t1", body: "one" },
        { author: "y", createdAt: "t2", body: "two" },
      ],
    };
    const out = buildLinearPrompt(issue);
    expect(out).toContain(`<comment-thread><comment author="x" created-at="t1">one</comment></comment-thread>`);
    expect(out).toContain(`<comment-thread><comment author="y" created-at="t2">two</comment></comment-thread>`);
  });

  test("treats whitespace-only description as empty", () => {
    const issue: Issue = {
      id: "i1",
      identifier: "ENG-5",
      title: "T",
      status: "Todo",
      assignee: null,
      linkedMrUrls: [],
      webUrl: "",
      description: "   \n  \n",
    };
    expect(buildLinearPrompt(issue)).not.toContain("<description>");
  });
});
