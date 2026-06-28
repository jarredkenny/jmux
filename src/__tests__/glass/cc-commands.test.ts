import { describe, test, expect } from "bun:test";
import { buildCcCommands, NEW_TAB_OPTION_ID, type CcCommandInput } from "../../glass/cc-commands";
import type { TabEntry } from "../../glass/tabs";

const tabs: TabEntry[] = [
  { id: "default", name: "Main" },
  { id: "backend", name: "Backend" },
];
const counts = new Map([["default", 1], ["backend", 2]]);

const base: CcCommandInput = {
  inGlass: false, tabs, activeTabId: "default", tabCounts: counts,
  focusedPaneId: null, focusedTabId: null, focusedIsAuto: false,
  sessionActivePinned: false,
};

const ids = (cmds: { id: string }[]) => cmds.map((c) => c.id);

describe("buildCcCommands — session context", () => {
  test("offers a fused pin picker (tabs + new) when the active pane is unpinned", () => {
    const cmds = buildCcCommands(base);
    const pin = cmds.find((c) => c.id === "pin-pane")!;
    expect(pin).toBeTruthy();
    expect(pin.sublist!.map((o) => o.label)).toContain("Main (1)");
    expect(pin.sublist!.map((o) => o.label)).toContain("Backend (2)");
    expect(pin.sublist!.at(-1)).toEqual({ id: NEW_TAB_OPTION_ID, label: "+ New tab…" });
    expect(ids(cmds)).not.toContain("unpin-pane");
  });

  test("offers unpin when the active pane is already pinned", () => {
    const cmds = buildCcCommands({ ...base, sessionActivePinned: true });
    expect(ids(cmds)).toContain("unpin-pane");
    expect(ids(cmds)).not.toContain("pin-pane");
  });

  test("does not offer tile-targeted commands outside glass", () => {
    expect(ids(buildCcCommands(base))).not.toContain("move-tile");
    expect(ids(buildCcCommands(base))).not.toContain("unpin-tile");
  });
});

describe("buildCcCommands — glass context", () => {
  const glass: CcCommandInput = {
    ...base, inGlass: true, activeTabId: "backend",
    focusedPaneId: "%5", focusedTabId: "backend", focusedIsAuto: false,
  };

  test("move-tile excludes the current tab and ends with + New tab…", () => {
    const cmds = buildCcCommands(glass);
    const move = cmds.find((c) => c.id === "move-tile")!;
    expect(move.sublist!.map((o) => o.id)).not.toContain("backend"); // current tab excluded
    expect(move.sublist!.map((o) => o.id)).toContain("default");
    expect(move.sublist!.at(-1)!.id).toBe(NEW_TAB_OPTION_ID);
  });

  test("unpin-tile is enabled for a manual pin", () => {
    const cmd = buildCcCommands(glass).find((c) => c.id === "unpin-tile")!;
    expect(cmd.disabled).toBeFalsy();
  });

  test("unpin-tile is a disabled hinted row for an auto-pinned tile", () => {
    const cmd = buildCcCommands({ ...glass, focusedIsAuto: true }).find((c) => c.id === "unpin-tile")!;
    expect(cmd.disabled).toBe(true);
    expect(cmd.hint).toMatch(/auto-pinned/i);
  });

  test("tile-targeted commands are hidden when there is no focused tile", () => {
    const cmds = buildCcCommands({ ...glass, focusedPaneId: null });
    expect(ids(cmds)).not.toContain("move-tile");
    expect(ids(cmds)).not.toContain("unpin-tile");
  });

  test("move-tab-left is hidden for the first non-default tab; right offered when room", () => {
    // active = backend (index 1, the only non-default) → left would cross default
    const cmds = buildCcCommands(glass);
    expect(ids(cmds)).not.toContain("move-tab-left");
    expect(ids(cmds)).not.toContain("move-tab-right"); // no tab to the right
  });

  test("switch-cc-tab lists all tabs", () => {
    const cmd = buildCcCommands(glass).find((c) => c.id === "switch-cc-tab")!;
    expect(cmd.sublist!.map((o) => o.id)).toEqual(["default", "backend"]);
  });
});
