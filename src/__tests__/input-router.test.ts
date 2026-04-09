import { describe, test, expect } from "bun:test";
import { translateMouseX, parseSgrMouse, InputRouter } from "../input-router";

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

describe("translateMouseX", () => {
  test("translates x coordinate by subtracting sidebar offset", () => {
    const result = translateMouseX("\x1b[<0;30;5M", 25);
    expect(result).toBe("\x1b[<0;5;5M");
  });

  test("preserves release suffix", () => {
    const result = translateMouseX("\x1b[<0;30;5m", 25);
    expect(result).toBe("\x1b[<0;5;5m");
  });

  test("returns null if translated x would be <= 0", () => {
    const result = translateMouseX("\x1b[<0;10;5M", 25);
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
});
