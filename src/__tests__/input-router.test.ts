import { describe, test, expect } from "bun:test";
import { translateMouseX, parseSgrMouse, InputRouter } from "../input-router";

describe("parseSgrMouse", () => {
  test("parses SGR mouse button press", () => {
    // ESC [ < 0 ; 30 ; 5 M  (button 1 press at col 30, row 5)
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
        tmuxPrefix: "\x01",
        prefixTimeout: 50,
        onPtyData: () => {},
        onSidebarEnter: () => {},
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
        tmuxPrefix: "\x01",
        prefixTimeout: 50,
        onPtyData: () => {},
        onSidebarEnter: () => {},
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
        tmuxPrefix: "\x01",
        prefixTimeout: 50,
        onPtyData: (d) => { ptyData += d; },
        onSidebarEnter: () => {},
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

describe("prefix + n for new session", () => {
  test("calls onNewSession after prefix + n", () => {
    let newCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        tmuxPrefix: "\x01",
        prefixTimeout: 50,
        onPtyData: () => {},
        onSidebarEnter: () => {},
        onSidebarClick: () => {},
        onNewSession: () => { newCalled = true; },
      },
      true,
    );
    router.handleInput("\x01");
    router.handleInput("n");
    expect(newCalled).toBe(true);
  });
});
