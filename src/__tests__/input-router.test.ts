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
