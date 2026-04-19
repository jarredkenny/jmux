import { describe, test, expect } from "bun:test";
import { translateMouse, parseSgrMouse, InputRouter, type InputRouterOptions } from "../input-router";

describe("parseSgrMouse", () => {
  test("parses SGR mouse button press", () => {
    const result = parseSgrMouse("\x1b[<0;30;5M");
    expect(result).not.toBeNull();
    expect(result!.button).toBe(0);
    expect(result!.x).toBe(30);
    expect(result!.y).toBe(5);
    expect(result!.release).toBe(false);
  });

  test("parses SGR mouse button release", () => {
    const result = parseSgrMouse("\x1b[<0;30;5m");
    expect(result).not.toBeNull();
    expect(result!.release).toBe(true);
  });

  test("parses wheel up event", () => {
    const result = parseSgrMouse("\x1b[<64;10;5M");
    expect(result).not.toBeNull();
    expect(result!.button).toBe(64);
    expect(result!.x).toBe(10);
  });

  test("returns null for non-mouse sequence", () => {
    const result = parseSgrMouse("\x1b[A");
    expect(result).toBeNull();
  });
});

describe("translateMouse", () => {
  test("translates x coordinate by subtracting offset", () => {
    const result = translateMouse("\x1b[<0;30;5M", 25);
    expect(result).toBe("\x1b[<0;5;5M");
  });

  test("preserves release suffix", () => {
    const result = translateMouse("\x1b[<0;30;5m", 25);
    expect(result).toBe("\x1b[<0;5;5m");
  });

  test("returns null if translated x would be <= 0", () => {
    const result = translateMouse("\x1b[<0;10;5M", 25);
    expect(result).toBeNull();
  });

  test("translates both x and y when yOffset provided", () => {
    const result = translateMouse("\x1b[<0;30;10M", 25, 1);
    expect(result).toBe("\x1b[<0;5;9M");
  });

  test("returns null if translated y would be <= 0", () => {
    const result = translateMouse("\x1b[<0;30;1M", 25, 1);
    expect(result).toBeNull();
  });
});

describe("Ctrl-Shift arrow detection", () => {
  test("calls onSessionPrev for Ctrl-Shift-Up", () => {
    let prevCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onSessionPrev: () => { prevCalled = true; },
      },
      true,
    );
    router.handleInput("\x1b[1;6A");
    expect(prevCalled).toBe(true);
  });

  test("calls onSessionNext for Ctrl-Shift-Down", () => {
    let nextCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onSessionNext: () => { nextCalled = true; },
      },
      true,
    );
    router.handleInput("\x1b[1;6B");
    expect(nextCalled).toBe(true);
  });

  test("Ctrl-Shift arrows are not forwarded to PTY", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onSessionPrev: () => {},
        onSessionNext: () => {},
      },
      true,
    );
    router.handleInput("\x1b[1;6A");
    router.handleInput("\x1b[1;6B");
    expect(ptyData).toBe("");
  });
});

describe("passthrough", () => {
  test("forwards regular input to PTY", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
      },
      true,
    );
    router.handleInput("hello");
    expect(ptyData).toBe("hello");
  });
});

describe("modal mode", () => {
  test("routes keyboard input to onModalInput when modal is open", () => {
    let paletteData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onModalInput: (d) => { paletteData += d; },
      },
      true,
    );
    router.setModalOpen(true);
    router.handleInput("hello");
    expect(paletteData).toBe("hello");
    expect(ptyData).toBe("");
  });

  test("still sends Ctrl-Shift arrows to session handlers when palette is open", () => {
    let prevCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onModalInput: () => {},
        onSessionPrev: () => { prevCalled = true; },
      },
      true,
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[1;6A");
    expect(prevCalled).toBe(true);
  });

  test("sidebar clicks still work when palette is open", () => {
    let clickedRow = -1;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: (row) => { clickedRow = row; },
        onModalInput: () => {},
      },
      true,
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[<0;5;3M");
    expect(clickedRow).toBe(2);
  });

  test("toolbar clicks are ignored when palette is open", () => {
    let toolbarClicked = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onModalInput: () => {},
        onToolbarClick: () => { toolbarClicked = true; },
      },
      true,
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[<0;30;1M");
    expect(toolbarClicked).toBe(false);
  });

  test("main area mouse events are ignored when palette is open", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onModalInput: () => {},
      },
      true,
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[<0;30;5M");
    expect(ptyData).toBe("");
  });

  test("routes to PTY when palette is closed", () => {
    let ptyData = "";
    let paletteData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onModalInput: (d) => { paletteData += d; },
      },
      true,
    );
    router.setModalOpen(true);
    router.setModalOpen(false);
    router.handleInput("hello");
    expect(ptyData).toBe("hello");
    expect(paletteData).toBe("");
  });
});

describe("diff panel routing", () => {
  test("mouse click in diff panel region forwards translated SGR to onDiffPanelData", () => {
    let diffData = "";
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      true,
    );
    router.setDiffPanel(10, false);
    router.setMainCols(20);
    // Divider at col 26 (1-indexed). Click at x=28, y=3 → diff col 2, row 2
    router.handleInput("\x1b[<0;28;3M");
    expect(diffData).toBe("\x1b[<0;2;2M");
  });

  test("divider click toggles focus", () => {
    let focusToggled = false;
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      true,
    );
    router.setDiffPanel(10, false);
    router.setMainCols(20);
    // Divider is at col 4+1+20+1 = 26 (1-indexed)
    router.handleInput("\x1b[<0;26;3M");
    expect(focusToggled).toBe(true);
  });

  test("keyboard routes to onDiffPanelData when diff panel is focused", () => {
    let diffData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      true,
    );
    router.setDiffPanel(10, true); // focused
    router.handleInput("jk");
    expect(diffData).toBe("jk");
    expect(ptyData).toBe("");
  });

  test("keyboard routes to PTY when diff panel exists but is not focused", () => {
    let diffData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      true,
    );
    router.setDiffPanel(10, false);
    router.handleInput("jk");
    expect(ptyData).toBe("jk");
    expect(diffData).toBe("");
  });

  test("Ctrl-a Tab toggles diff panel focus", () => {
    let focusToggled = false;
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      true,
    );
    router.setDiffPanel(10, false);
    router.handleInput("\x01");
    router.handleInput("\t");
    expect(focusToggled).toBe(true);
  });

  test("prefix key swallowed when diff panel is focused and key is unrecognized", () => {
    let ptyData = "";
    let diffData = "";
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      true,
    );
    router.setDiffPanel(10, true);
    router.handleInput("\x01");
    expect(ptyData).toBe("");
    expect(diffData).toBe("");
    router.handleInput("x");
    expect(ptyData).toBe("");
    expect(diffData).toBe("");
  });

  test("Ctrl-a g still intercepted when diff panel is focused", () => {
    let toggleCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: () => {},
        onDiffToggle: () => { toggleCalled = true; },
      },
      true,
    );
    router.setDiffPanel(10, true);
    router.handleInput("\x01");
    router.handleInput("g");
    expect(toggleCalled).toBe(true);
  });

  test("Shift+Left from focused diff panel toggles focus back to tmux", () => {
    let focusToggled = false;
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      true,
    );
    router.setDiffPanel(10, true); // focused
    router.handleInput("\x1b[1;2D"); // Shift+Left
    expect(focusToggled).toBe(true);
  });

  test("Shift+Left forwards to tmux when diff panel is not focused", () => {
    let ptyData = "";
    let focusToggled = false;
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      true,
    );
    router.setDiffPanel(10, false); // not focused
    router.handleInput("\x1b[1;2D"); // Shift+Left
    expect(focusToggled).toBe(false);
    expect(ptyData).toBe("\x1b[1;2D");
  });

  test("Shift+Right calls onPaneNavRight when diff panel open and tmux focused", () => {
    let navRightCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPaneNavRight: () => { navRightCalled = true; },
      },
      true,
    );
    router.setDiffPanel(10, false); // tmux focused
    router.handleInput("\x1b[1;2C"); // Shift+Right
    expect(navRightCalled).toBe(true);
  });

  test("Shift+Right forwards to tmux when no diff panel", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onPaneNavRight: () => {},
      },
      true,
    );
    // No setDiffPanel — diffPanelCols is 0
    router.handleInput("\x1b[1;2C"); // Shift+Right
    expect(ptyData).toBe("\x1b[1;2C");
  });
});

describe("InfoPanel tab switching", () => {
  test("[ key triggers onPanelPrevTab when panel focused", () => {
    let prevTabCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelPrevTab: () => { prevTabCalled = true; },
        onPanelNextTab: () => {},
      },
      true,
    );
    router.setDiffPanel(40, true);
    router.handleInput("[");
    expect(prevTabCalled).toBe(true);
  });

  test("] key triggers onPanelNextTab when panel focused", () => {
    let nextTabCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelPrevTab: () => {},
        onPanelNextTab: () => { nextTabCalled = true; },
      },
      true,
    );
    router.setDiffPanel(40, true);
    router.handleInput("]");
    expect(nextTabCalled).toBe(true);
  });

  test("[ key passes through when panel not focused", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: (d) => { ptyData = d; },
        onSidebarClick: () => {},
      },
      true,
    );
    router.handleInput("[");
    expect(ptyData).toBe("[");
  });

  test("action key 'o' triggers onPanelAction when panel focused and tabs active", () => {
    let actionKey = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelAction: (key) => { actionKey = key; },
      },
      true,
    );
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("o");
    expect(actionKey).toBe("o");
  });

  test("action key 'C' triggers onPanelAction when panel focused and tabs active", () => {
    let actionKey = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelAction: (key) => { actionKey = key; },
      },
      true,
    );
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("C");
    expect(actionKey).toBe("C");
  });

  test("action key 's' triggers onPanelAction when panel focused and tabs active", () => {
    let actionKey = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelAction: (key) => { actionKey = key; },
      },
      true,
    );
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("s");
    expect(actionKey).toBe("s");
  });

  test("action keys pass through to diff panel when tabs not active", () => {
    let diffData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData = d; },
        onPanelAction: () => {},
      },
      true,
    );
    router.setDiffPanel(40, true);
    // panelTabsActive defaults to false — diff tab is active
    router.handleInput("o");
    expect(diffData).toBe("o");
  });

  test("up arrow triggers onPanelSelectPrev when panel tabs active", () => {
    let called = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelSelectPrev: () => { called = true; },
      },
      true,
    );
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("\x1b[A");
    expect(called).toBe(true);
  });

  test("down arrow triggers onPanelSelectNext when panel tabs active", () => {
    let called = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelSelectNext: () => { called = true; },
      },
      true,
    );
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("\x1b[B");
    expect(called).toBe(true);
  });

  test("arrows pass through to diff panel when tabs not active", () => {
    let diffData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData = d; },
        onPanelSelectPrev: () => {},
      },
      true,
    );
    router.setDiffPanel(40, true);
    // panelTabsActive defaults to false
    router.handleInput("\x1b[A");
    expect(diffData).toBe("\x1b[A");
  });

  test("g key triggers onPanelCycleGroupBy when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      sidebarCols: 24, onPtyData: () => {}, onSidebarClick: () => {},
      onPanelCycleGroupBy: () => { called = true; },
    }, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("g");
    expect(called).toBe(true);
  });

  test("/ key triggers onPanelFilterStart and activates filter mode when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      sidebarCols: 24, onPtyData: () => {}, onSidebarClick: () => {},
      onPanelFilterStart: () => { called = true; },
    }, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("/");
    expect(called).toBe(true);
  });

  test("S key triggers onPanelCycleSortBy when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      sidebarCols: 24, onPtyData: () => {}, onSidebarClick: () => {},
      onPanelCycleSortBy: () => { called = true; },
    }, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("S");
    expect(called).toBe(true);
  });

  test("r key triggers onPanelRefresh when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      sidebarCols: 24, onPtyData: () => {}, onSidebarClick: () => {},
      onPanelRefresh: () => { called = true; },
    }, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("r");
    expect(called).toBe(true);
  });

  test("Enter triggers onPanelToggleCollapse when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      sidebarCols: 24, onPtyData: () => {}, onSidebarClick: () => {},
      onPanelToggleCollapse: () => { called = true; },
    }, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("\r");
    expect(called).toBe(true);
  });

  test("n key triggers onPanelCreateSession when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      sidebarCols: 24, onPtyData: () => {}, onSidebarClick: () => {},
      onPanelCreateSession: () => { called = true; },
    }, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("n");
    expect(called).toBe(true);
  });

  test("l key triggers onPanelLinkToSession when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      sidebarCols: 24, onPtyData: () => {}, onSidebarClick: () => {},
      onPanelLinkToSession: () => { called = true; },
    }, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("l");
    expect(called).toBe(true);
  });
});

describe("panel filter mode", () => {
  function makeFilterRouter(overrides: Partial<InputRouterOptions> = {}) {
    const calls: string[] = [];
    const opts: InputRouterOptions = {
      sidebarCols: 24,
      onPtyData: () => { calls.push("pty"); },
      onSidebarClick: () => {},
      onDiffPanelData: (d) => { calls.push(`diff:${d}`); },
      onPanelFilterStart: () => { calls.push("filterStart"); },
      onPanelFilterInput: (c) => { calls.push(`filterInput:${c}`); },
      onPanelFilterBackspace: () => { calls.push("filterBackspace"); },
      onPanelFilterClear: () => { calls.push("filterClear"); },
      onPanelSelectPrev: () => { calls.push("selectPrev"); },
      onPanelSelectNext: () => { calls.push("selectNext"); },
      onPanelAction: (k) => { calls.push(`action:${k}`); },
      onPanelRefresh: () => { calls.push("refresh"); },
      onPanelCycleSortBy: () => { calls.push("cycleSortBy"); },
      ...overrides,
    };
    const router = new InputRouter(opts, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    return { router, calls };
  }

  test("printable chars append to filter when filter mode is active", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/"); // enter filter mode
    calls.length = 0;
    router.handleInput("a");
    router.handleInput("b");
    router.handleInput("1");
    expect(calls).toEqual(["filterInput:a", "filterInput:b", "filterInput:1"]);
  });

  test("action keys are captured as filter input, not dispatched as actions", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("o"); // normally opens in browser
    router.handleInput("s"); // normally changes status
    router.handleInput("n"); // normally creates session
    expect(calls).toEqual(["filterInput:o", "filterInput:s", "filterInput:n"]);
  });

  test("backspace calls onPanelFilterBackspace in filter mode", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x7f");
    expect(calls).toEqual(["filterBackspace"]);
  });

  test("bare Esc clears filter and exits filter mode", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x1b");
    expect(calls).toEqual(["filterClear"]);
    // After Esc, normal keys should go to action handlers, not filter
    calls.length = 0;
    router.handleInput("o");
    expect(calls).toEqual(["action:o"]);
  });

  test("escape sequences (arrow keys) are not treated as bare Esc", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x1b[A"); // Up arrow — should navigate, not clear
    router.handleInput("\x1b[B"); // Down arrow
    expect(calls).toEqual(["selectPrev", "selectNext"]);
  });

  test("arrow keys navigate the filtered list", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    router.handleInput("a"); // type something
    calls.length = 0;
    router.handleInput("\x1b[A");
    router.handleInput("\x1b[B");
    expect(calls).toEqual(["selectPrev", "selectNext"]);
  });

  test("tab switch clears filter mode", () => {
    const prevTabCalls: string[] = [];
    const { router, calls } = makeFilterRouter({
      onPanelPrevTab: () => { prevTabCalls.push("prevTab"); },
    });
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("[");
    expect(calls).toContain("filterClear");
    expect(prevTabCalls).toEqual(["prevTab"]);
    // After tab switch, should be out of filter mode
    calls.length = 0;
    router.handleInput("o");
    expect(calls).toEqual(["action:o"]);
  });

  test("unrecognized keys are consumed in filter mode, not forwarded", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x1b[1;2C"); // Shift+Right — not handled in filter mode
    expect(calls).toEqual([]); // consumed, not forwarded
  });

  test("r key is captured as filter input when filter active, not refresh", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("r");
    expect(calls).toEqual(["filterInput:r"]);
  });

  test("r key triggers refresh when filter is not active", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("r");
    expect(calls).toEqual(["refresh"]);
  });

  test("Enter confirms filter — exits input mode but keeps filter", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    router.handleInput("a");
    calls.length = 0;
    router.handleInput("\r"); // Enter — confirm filter
    // Should NOT call filterClear
    expect(calls).toEqual([]);
    // After Enter, action keys should work normally (not captured as filter input)
    router.handleInput("o");
    expect(calls).toEqual(["action:o"]);
  });

  test("Esc clears a persisted filter after Enter confirmation", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    router.handleInput("a");
    router.handleInput("\r"); // confirm filter
    calls.length = 0;
    router.handleInput("\x1b"); // Esc — clear the persisted filter
    expect(calls).toEqual(["filterClear"]);
    // After clearing, action keys still work
    calls.length = 0;
    router.handleInput("o");
    expect(calls).toEqual(["action:o"]);
  });
});
