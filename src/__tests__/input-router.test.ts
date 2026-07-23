import { describe, test, expect } from "bun:test";
import { translateMouse, parseSgrMouse, InputRouter, type InputRouterOptions } from "../input-router";
import { computeFrameLayout, SIDEBAR_MIN_TERM_COLS, type FrameLayout } from "../frame-layout";

// Shared FrameLayout fixtures. Tests build real layouts via computeFrameLayout
// (rather than hand-rolled Span objects) so the geometry fed to InputRouter is
// internally consistent — the same guarantee relayout() gives production code.

// A layout with no diff panel (mode "off"), given a sidebar width. termCols is
// generous (120) so main always has plenty of room regardless of sidebarWidth.
function baseLayout(sidebarWidth: number, diffState: "off" | "split" | "full" = "off", requestedPanelCols = 0): FrameLayout {
  return computeFrameLayout({
    termCols: 120,
    termRows: 40,
    sidebarWidth,
    borderWidth: 1,
    toolbarRows: 1,
    diffState,
    requestedPanelCols,
    frameRulesEnabled: false,
    footerEnabled: false,
  });
}

// A split-mode layout with exact main/panel widths (rather than "big enough"),
// for tests that assert precise translated mouse coordinates. sidebarWidth is
// widened (keeping mainCols/panelCols exact) if needed to clear
// SIDEBAR_MIN_TERM_COLS — computeFrameLayout returns sidebar: null below that,
// which would make the router skip the whole mouse block.
function diffPanelLayout(sidebarWidth: number, mainCols: number, panelCols: number): FrameLayout {
  const available = mainCols + panelCols + 1; // + borderWidth between main and panel
  let termCols = sidebarWidth + 1 + available; // + borderWidth between sidebar and main
  let effectiveSidebarWidth = sidebarWidth;
  if (termCols < SIDEBAR_MIN_TERM_COLS) {
    effectiveSidebarWidth += SIDEBAR_MIN_TERM_COLS - termCols;
    termCols = SIDEBAR_MIN_TERM_COLS;
  }
  return computeFrameLayout({
    termCols,
    termRows: 40,
    sidebarWidth: effectiveSidebarWidth,
    borderWidth: 1,
    toolbarRows: 1,
    diffState: "split",
    requestedPanelCols: panelCols,
    frameRulesEnabled: false,
    footerEnabled: false,
  });
}

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
        onPtyData: () => {},
        onSidebarClick: () => {},
        onSessionPrev: () => { prevCalled = true; },
      },
      baseLayout(24),
    );
    router.handleInput("\x1b[1;6A");
    expect(prevCalled).toBe(true);
  });

  test("calls onSessionNext for Ctrl-Shift-Down", () => {
    let nextCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onSessionNext: () => { nextCalled = true; },
      },
      baseLayout(24),
    );
    router.handleInput("\x1b[1;6B");
    expect(nextCalled).toBe(true);
  });

  test("Ctrl-Shift arrows are not forwarded to PTY", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onSessionPrev: () => {},
        onSessionNext: () => {},
      },
      baseLayout(24),
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
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
      },
      baseLayout(24),
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
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onModalInput: (d) => { paletteData += d; },
      },
      baseLayout(24),
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
        onPtyData: () => {},
        onSidebarClick: () => {},
        onModalInput: () => {},
        onSessionPrev: () => { prevCalled = true; },
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[1;6A");
    expect(prevCalled).toBe(true);
  });

  test("sidebar clicks still work when palette is open", () => {
    let clickedRow = -1;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: (row) => { clickedRow = row; },
        onModalInput: () => {},
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[<0;5;3M");
    expect(clickedRow).toBe(2);
  });

  test("toolbar clicks are ignored when palette is open", () => {
    let toolbarClicked = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onModalInput: () => {},
        onToolbarClick: () => { toolbarClicked = true; },
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.handleInput("\x1b[<0;30;1M");
    expect(toolbarClicked).toBe(false);
  });

  test("main area mouse events are ignored when palette is open", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onModalInput: () => {},
      },
      baseLayout(24),
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
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onModalInput: (d) => { paletteData += d; },
      },
      baseLayout(24),
    );
    router.setModalOpen(true);
    router.setModalOpen(false);
    router.handleInput("hello");
    expect(ptyData).toBe("hello");
    expect(paletteData).toBe("");
  });
});

describe("link click", () => {
  // getLinkAt is queried with 0-indexed grid coords (mouse.x-1, mouse.y-1).
  // The link cell here is the main-area cell at absolute mouse (30, 5).
  const makeRouter = (sink: { pty: string; opened: string[] }) =>
    new InputRouter(
      {
        onPtyData: (d) => { sink.pty += d; },
        onSidebarClick: () => {},
        getLinkAt: (x, y) => (x === 29 && y === 4 ? "https://example.com" : undefined),
        onOpenLink: (url) => { sink.opened.push(url); },
      },
      baseLayout(24),
    );

  test("clean left-click on a link cell opens the URL and is not forwarded to tmux", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.handleInput("\x1b[<0;30;5M");
    expect(sink.opened).toEqual(["https://example.com"]);
    expect(sink.pty).toBe("");
  });

  test("the matching release over the link cell is also consumed", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.handleInput("\x1b[<0;30;5M"); // press → opens
    router.handleInput("\x1b[<0;30;5m"); // release → swallowed
    expect(sink.opened).toEqual(["https://example.com"]); // opened exactly once
    expect(sink.pty).toBe("");
  });

  test("left-click on a non-link cell forwards to tmux and does not open", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.handleInput("\x1b[<0;40;5M"); // not the link cell
    expect(sink.opened).toEqual([]);
    expect(sink.pty.length).toBeGreaterThan(0); // translated event forwarded
  });

  test("wheel over a link cell does not open the link", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.handleInput("\x1b[<64;30;5M"); // wheel up at the link cell
    expect(sink.opened).toEqual([]);
  });

  test("motion (drag) over a link cell does not open the link", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.handleInput("\x1b[<32;30;5M"); // button 0 + motion bit (drag)
    expect(sink.opened).toEqual([]);
  });

  test("link click is not intercepted while a modal is open", () => {
    const sink = { pty: "", opened: [] as string[] };
    const router = makeRouter(sink);
    router.setModalOpen(true);
    router.handleInput("\x1b[<0;30;5M");
    expect(sink.opened).toEqual([]);
  });
});

describe("diff panel routing", () => {
  test("mouse click in diff panel region forwards translated SGR to onDiffPanelData", () => {
    let diffData = "";
    const layout = diffPanelLayout(4, 20, 10);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      layout,
    );
    // A click 2 (1-indexed) columns into the panel, row 2 into content:
    // mouse.x = panel.x + 2, mouse.y = toolbarRows + 2.
    const mouseX = layout.panel!.x + 2;
    const mouseY = layout.toolbarRows + 2;
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    expect(diffData).toBe("\x1b[<0;2;2M");
  });

  test("divider click toggles focus", () => {
    let focusToggled = false;
    const layout = diffPanelLayout(4, 20, 10);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      layout,
    );
    // Divider click is 1-indexed mouse.x = divider (0-indexed) + 1.
    const mouseX = layout.divider! + 1;
    router.handleInput(`\x1b[<0;${mouseX};3M`);
    expect(focusToggled).toBe(true);
  });

  test("keyboard routes to onDiffPanelData when diff panel is focused", () => {
    let diffData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(true);
    router.handleInput("jk");
    expect(diffData).toBe("jk");
    expect(ptyData).toBe("");
  });

  test("keyboard routes to PTY when diff panel exists but is not focused", () => {
    let diffData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(false);
    router.handleInput("jk");
    expect(ptyData).toBe("jk");
    expect(diffData).toBe("");
  });

  test("Ctrl-a Tab toggles diff panel focus", () => {
    let focusToggled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(false);
    router.handleInput("\x01");
    router.handleInput("\t");
    expect(focusToggled).toBe(true);
  });

  test("prefix key swallowed when diff panel is focused and key is unrecognized", () => {
    let ptyData = "";
    let diffData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(true);
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
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: () => {},
        onDiffToggle: () => { toggleCalled = true; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(true);
    router.handleInput("\x01");
    router.handleInput("g");
    expect(toggleCalled).toBe(true);
  });

  test("prefix+d detaches jmux when the Command Center is active", () => {
    let detachCalled = false;
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        glassActive: () => true,
        onGlassDetach: () => { detachCalled = true; },
      },
      baseLayout(4),
    );
    router.handleInput("\x01"); // prefix is buffered (not forwarded) in glass
    router.handleInput("d");
    expect(detachCalled).toBe(true);
    expect(ptyData).toBe(""); // buffered prefix dropped, not forwarded
  });

  test("prefix+d is a normal passthrough when not in the Command Center", () => {
    let detachCalled = false;
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        glassActive: () => false,
        onGlassDetach: () => { detachCalled = true; },
      },
      baseLayout(4),
    );
    router.handleInput("\x01");
    router.handleInput("d");
    expect(detachCalled).toBe(false);
    expect(ptyData).toBe("\x01d"); // tmux receives prefix+d → its own detach binding
  });

  test("Shift+Left from focused diff panel toggles focus back to tmux", () => {
    let focusToggled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(true); // focused
    router.handleInput("\x1b[1;2D"); // Shift+Left
    expect(focusToggled).toBe(true);
  });

  test("Shift+Left forwards to tmux when diff panel is not focused", () => {
    let ptyData = "";
    let focusToggled = false;
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(false); // not focused
    router.handleInput("\x1b[1;2D"); // Shift+Left
    expect(focusToggled).toBe(false);
    expect(ptyData).toBe("\x1b[1;2D");
  });

  test("Shift+Right calls onPaneNavRight when diff panel open and tmux focused", () => {
    let navRightCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPaneNavRight: () => { navRightCalled = true; },
      },
      baseLayout(4, "split", 10),
    );
    router.setPanelFocused(false); // tmux focused
    router.handleInput("\x1b[1;2C"); // Shift+Right
    expect(navRightCalled).toBe(true);
  });

  test("Shift+Right forwards to tmux when no diff panel", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onPaneNavRight: () => {},
      },
      baseLayout(4), // No diff panel — layout.panel is null
    );
    router.handleInput("\x1b[1;2C"); // Shift+Right
    expect(ptyData).toBe("\x1b[1;2C");
  });

  // Full mode: panel.x === main.x (the panel overlaps main rather than
  // sitting after a divider) and divider is null. The setMainCols(0) deletion
  // in main.ts rests on this routing actually sending content-area clicks to
  // the panel instead of tmux's main pane.
  test("full mode: content-area click routes to panel, not main, translated by panel.x", () => {
    let diffData = "";
    let ptyData = "";
    const layout = baseLayout(4, "full", 10);
    // Sanity-check the geometry this test (and the setMainCols(0) deletion)
    // depends on before asserting router behavior against it.
    expect(layout.divider).toBeNull();
    expect(layout.panel!.x).toBe(layout.main.x);

    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      layout,
    );
    // A click 5 (1-indexed) columns into the panel, row 2 into content —
    // same convention as the split-mode panel test above.
    const mouseX = layout.panel!.x + 5;
    const mouseY = layout.toolbarRows + 2;
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    expect(diffData).toBe("\x1b[<0;5;2M");
    expect(ptyData).toBe("");
  });

  test("full mode: no divider exists, so no column is ever classified as a divider drag", () => {
    let diffData = "";
    let focusToggled = false;
    const layout = baseLayout(4, "full", 10);
    expect(layout.divider).toBeNull();

    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      layout,
    );
    // Pre-focus the panel so the (unrelated) "click acquires focus" branch
    // can't fire and confound this assertion — isolates the divider check.
    router.setPanelFocused(true);
    // Click at the column that would have been the divider in a
    // comparably-sized split layout (main.x + main.w). With layout.divider
    // === null this must still route to the panel as ordinary content, never
    // trigger the divider-toggle branch.
    const mouseX = layout.main.x + layout.main.w; // 1-indexed grid col
    const mouseY = layout.toolbarRows + 3;
    router.handleInput(`\x1b[<0;${mouseX};${mouseY}M`);
    expect(focusToggled).toBe(false);
    expect(diffData.length).toBeGreaterThan(0);
  });
});

describe("toolbar column routing", () => {
  // gridX - layout.main.x is the corrected formula (replacing the old
  // `mouse.x - sidebarCols - 1`, which was off by one — see the
  // "glass strip mouse routing" comment above for the corroborating trace).
  test("onToolbarClick receives gridX - layout.main.x for a click in the toolbar row", () => {
    let clickedCol = -1;
    const layout = baseLayout(24);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onToolbarClick: (col) => { clickedCol = col; },
      },
      layout,
    );
    const gridX = layout.main.x + 5;
    const mouseX = gridX + 1; // SGR mouse x is 1-indexed
    router.handleInput(`\x1b[<0;${mouseX};1M`); // row 1 → gridY 0, within toolbarRows
    expect(clickedCol).toBe(5);
  });

  test("onHover reports the same column for a motion event in the toolbar row", () => {
    const hovers: Array<{ area: "sidebar"; row: number } | { area: "toolbar"; col: number } | null> = [];
    const layout = baseLayout(24);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onHover: (target) => { hovers.push(target); },
      },
      layout,
    );
    const gridX = layout.main.x + 5;
    const mouseX = gridX + 1;
    router.handleInput(`\x1b[<32;${mouseX};1M`); // button 32 = plain motion
    expect(hovers).toEqual([{ area: "toolbar", col: 5 }]);
  });

  test("a click at gridX === layout.main.x yields column 0 (the boundary the old -1 offset got wrong)", () => {
    let clickedCol = -1;
    const layout = baseLayout(24);
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onToolbarClick: (col) => { clickedCol = col; },
      },
      layout,
    );
    const mouseX = layout.main.x + 1; // gridX === layout.main.x
    router.handleInput(`\x1b[<0;${mouseX};1M`);
    expect(clickedCol).toBe(0);
  });
});

describe("InfoPanel tab switching", () => {
  test("[ key triggers onPanelPrevTab when panel focused", () => {
    let prevTabCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelPrevTab: () => { prevTabCalled = true; },
        onPanelNextTab: () => {},
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.handleInput("[");
    expect(prevTabCalled).toBe(true);
  });

  test("] key triggers onPanelNextTab when panel focused", () => {
    let nextTabCalled = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelPrevTab: () => {},
        onPanelNextTab: () => { nextTabCalled = true; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.handleInput("]");
    expect(nextTabCalled).toBe(true);
  });

  test("[ key passes through when panel not focused", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData = d; },
        onSidebarClick: () => {},
      },
      baseLayout(24),
    );
    router.handleInput("[");
    expect(ptyData).toBe("[");
  });

  test("action key 'o' triggers onPanelAction when panel focused and tabs active", () => {
    let actionKey = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelAction: (key) => { actionKey = key; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("o");
    expect(actionKey).toBe("o");
  });

  test("action key 'C' triggers onPanelAction when panel focused and tabs active", () => {
    let actionKey = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelAction: (key) => { actionKey = key; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("C");
    expect(actionKey).toBe("C");
  });

  test("action key 's' triggers onPanelAction when panel focused and tabs active", () => {
    let actionKey = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelAction: (key) => { actionKey = key; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("s");
    expect(actionKey).toBe("s");
  });

  test("action keys pass through to diff panel when tabs not active", () => {
    let diffData = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData = d; },
        onPanelAction: () => {},
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    // panelTabsActive defaults to false — diff tab is active
    router.handleInput("o");
    expect(diffData).toBe("o");
  });

  test("up arrow triggers onPanelSelectPrev when panel tabs active", () => {
    let called = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelSelectPrev: () => { called = true; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("\x1b[A");
    expect(called).toBe(true);
  });

  test("down arrow triggers onPanelSelectNext when panel tabs active", () => {
    let called = false;
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelSelectNext: () => { called = true; },
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("\x1b[B");
    expect(called).toBe(true);
  });

  test("arrows pass through to diff panel when tabs not active", () => {
    let diffData = "";
    const router = new InputRouter(
      {
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData = d; },
        onPanelSelectPrev: () => {},
      },
      baseLayout(24, "split", 40),
    );
    router.setPanelFocused(true);
    // panelTabsActive defaults to false
    router.handleInput("\x1b[A");
    expect(diffData).toBe("\x1b[A");
  });

  test("g key triggers onPanelCycleGroupBy when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelCycleGroupBy: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("g");
    expect(called).toBe(true);
  });

  test("/ key triggers onPanelFilterStart and activates filter mode when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelFilterStart: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("/");
    expect(called).toBe(true);
  });

  test("S key triggers onPanelCycleSortBy when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelCycleSortBy: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("S");
    expect(called).toBe(true);
  });

  test("r key triggers onPanelRefresh when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelRefresh: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("r");
    expect(called).toBe(true);
  });

  test("Enter triggers onPanelToggleCollapse when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelToggleCollapse: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("\r");
    expect(called).toBe(true);
  });

  test("n key triggers onPanelCreateSession when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelCreateSession: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("n");
    expect(called).toBe(true);
  });

  test("l key triggers onPanelLinkToSession when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      onPtyData: () => {}, onSidebarClick: () => {},
      onPanelLinkToSession: () => { called = true; },
    }, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
    router.setPanelTabsActive(true);
    router.handleInput("l");
    expect(called).toBe(true);
  });
});

describe("panel filter mode", () => {
  function makeFilterRouter(overrides: Partial<InputRouterOptions> = {}) {
    const calls: string[] = [];
    const opts: InputRouterOptions = {
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
    const router = new InputRouter(opts, baseLayout(24, "split", 40));
    router.setPanelFocused(true);
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

describe("glass-buffered prefix + Ctrl-a <n>", () => {
  test("Ctrl-a then digit switches tabs and forwards nothing to the tile", () => {
    const sent: string[] = [];
    const switched: number[] = [];
    const router = new InputRouter({
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
      onGlassTabSwitch: (n) => switched.push(n),
    }, baseLayout(26));
    router.handleInput("\x01");
    router.handleInput("2");
    expect(switched).toEqual([2]);
    expect(sent).toEqual([]); // neither byte reached the tile
  });

  test("Ctrl-a then an unrecognized key flushes prefix + key to the tile", () => {
    const sent: string[] = [];
    const router = new InputRouter({
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
    }, baseLayout(26));
    router.handleInput("\x01");
    router.handleInput("k"); // not a glass chord → flushed to the tile
    expect(sent).toEqual(["\x01", "k"]);
  });

  test("Ctrl-a then [ / ] switch to prev/next tab and forward nothing", () => {
    const sent: string[] = [];
    const deltas: number[] = [];
    const router = new InputRouter({
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
      onGlassTabRelative: (delta) => deltas.push(delta),
    }, baseLayout(26));
    router.handleInput("\x01");
    router.handleInput("[");
    router.handleInput("\x01");
    router.handleInput("]");
    expect(deltas).toEqual([-1, 1]);
    expect(sent).toEqual([]); // nothing leaked to the tile
  });

  test("Ctrl-a then d detaches jmux and forwards nothing", () => {
    const sent: string[] = [];
    let detached = 0;
    const router = new InputRouter({
      onPtyData: (d) => sent.push(d),
      onSidebarClick: () => {},
      glassActive: () => true,
      onGlassDetach: () => detached++,
    }, baseLayout(26));
    router.handleInput("\x01");
    router.handleInput("d");
    expect(detached).toBe(1);
    expect(sent).toEqual([]); // buffered prefix dropped, not forwarded
  });
});

describe("glass strip mouse routing", () => {
  // SGR press at row 1 (top), col 30, sidebarWidth 26 → main.x (0-indexed) is
  // 27, gridX is 29, so content x = gridX - main.x = 2. (Pre-Task-3 this used
  // to be computed as `mouse.x - sidebarCols - 1` = 3 — one column off from
  // where glass/view.ts's own 0-indexed tile rects place column 0; see the
  // task report for the corroborating renderer.ts trace.)
  const press = (col: number, row: number) => `\x1b[<0;${col};${row}M`;

  test("a click on the strip row routes to onGlassTabClick", () => {
    const tabClicks: number[] = [];
    const tileClicks: Array<[number, number]> = [];
    const router = new InputRouter({
      onPtyData: () => {},
      onSidebarClick: () => {},
      glassActive: () => true,
      glassStripRows: () => 1,
      onGlassTabClick: (x) => tabClicks.push(x),
      onGlassClick: (x, y) => tileClicks.push([x, y]),
    }, baseLayout(26));
    router.handleInput(press(30, 1)); // row 1 = strip
    expect(tabClicks).toEqual([2]);
    expect(tileClicks).toEqual([]);
  });

  test("a click below the strip routes to the tile with cy offset by strip rows", () => {
    const tileClicks: Array<[number, number]> = [];
    const router = new InputRouter({
      onPtyData: () => {},
      onSidebarClick: () => {},
      glassActive: () => true,
      glassStripRows: () => 1,
      onGlassClick: (x, y) => tileClicks.push([x, y]),
      onGlassTabClick: () => {},
    }, baseLayout(26));
    router.handleInput(press(30, 5)); // row 5: cy = (5-1) - 1 stripRow = 3
    expect(tileClicks).toEqual([[2, 3]]);
  });
});

// Regression test for the stale-geometry bug: main.ts's relayout() updates
// five separate InputRouter setters, and used to be able to leave one out of
// sync after a runtime sidebarWidth change, so the router kept routing
// clicks against the old boundary. setLayout(layout) makes that impossible —
// there is exactly one geometry object, replaced atomically.
describe("setLayout — sidebar/main boundary follows layout, not stale geometry", () => {
  test("a runtime sidebarWidth change moves the sidebar/main click boundary", () => {
    let clickedRow = -1;
    let ptyData = "";
    const router = new InputRouter(
      {
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: (row) => { clickedRow = row; },
      },
      baseLayout(26),
    );

    // 26-wide sidebar: boundary is at 0-indexed grid col 26 (1-indexed x=27).
    // x=26 (grid col 25) → sidebar; x=28 (grid col 27) → main.
    router.handleInput("\x1b[<0;26;3M");
    expect(clickedRow).toBe(2);
    clickedRow = -1;
    router.handleInput("\x1b[<0;28;3M");
    expect(clickedRow).toBe(-1);
    expect(ptyData.length).toBeGreaterThan(0);

    // Now widen the sidebar to 40 at runtime via setLayout — the boundary
    // must move with it, not stay pinned at the old 26/27 split.
    ptyData = "";
    router.setLayout(baseLayout(40));

    // x=28 (grid col 27) is now inside the wider sidebar.
    router.handleInput("\x1b[<0;28;3M");
    expect(clickedRow).toBe(2);
    clickedRow = -1;
    ptyData = "";

    // x=42 (grid col 41) is now inside main.
    router.handleInput("\x1b[<0;42;3M");
    expect(clickedRow).toBe(-1);
    expect(ptyData.length).toBeGreaterThan(0);
  });
});
