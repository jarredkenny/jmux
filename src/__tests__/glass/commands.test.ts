import { describe, test, expect } from "bun:test";
import {
  captureLayoutCommand,
  breakPaneCommand,
  buildRestoreCommands,
} from "../../glass/commands";
import type { PinnedPaneRecord, RestorePlan } from "../../glass/types";

const REC: PinnedPaneRecord = {
  paneId: "%7",
  homeSessionId: "$2",
  homeWindowId: "@5",
  homeLayout: "savedlayout",
};

describe("checkout commands", () => {
  test("captureLayoutCommand reads the home window layout", () => {
    expect(captureLayoutCommand("@5")).toEqual([
      "display-message", "-p", "-t", "@5", "#{window_layout}",
    ]);
  });

  test("breakPaneCommand breaks the pane into the holding session, printing the new window id", () => {
    expect(breakPaneCommand("%7", "__jmux_glass")).toEqual([
      "break-pane", "-d", "-P", "-F", "#{window_id}", "-s", "%7", "-t", "__jmux_glass:",
    ]);
  });
});

describe("buildRestoreCommands", () => {
  test("rejoinWindow → join-pane + select-layout", () => {
    const plan: RestorePlan = { mode: "rejoinWindow", windowId: "@5", layout: "savedlayout" };
    expect(buildRestoreCommands(REC, plan, { holdingWindowId: "@99", newSessionName: "api" })).toEqual([
      ["join-pane", "-s", "%7", "-t", "@5"],
      ["select-layout", "-t", "@5", "savedlayout"],
    ]);
  });

  test("newWindowInSession → break the pane back as a new window of the home session", () => {
    const plan: RestorePlan = { mode: "newWindowInSession", sessionId: "$2" };
    expect(buildRestoreCommands(REC, plan, { holdingWindowId: "@99", newSessionName: "api" })).toEqual([
      ["break-pane", "-d", "-s", "%7", "-t", "$2:"],
    ]);
  });

  test("newSession → new placeholder session, move the holding window in, kill placeholder", () => {
    const plan: RestorePlan = { mode: "newSession" };
    expect(buildRestoreCommands(REC, plan, { holdingWindowId: "@99", newSessionName: "api" })).toEqual([
      ["new-session", "-d", "-s", "api", "-n", "__placeholder"],
      ["move-window", "-s", "@99", "-t", "api:"],
      ["kill-window", "-t", "api:__placeholder"],
    ]);
  });
});
