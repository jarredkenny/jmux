export interface SgrMouseEvent {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export function parseSgrMouse(seq: string): SgrMouseEvent | null {
  const match = seq.match(SGR_MOUSE_RE);
  if (!match) return null;
  return {
    button: parseInt(match[1], 10),
    x: parseInt(match[2], 10),
    y: parseInt(match[3], 10),
    release: match[4] === "m",
  };
}

export function translateMouseX(
  seq: string,
  offset: number,
): string | null {
  const match = seq.match(SGR_MOUSE_RE);
  if (!match) return null;
  const newX = parseInt(match[2], 10) - offset;
  if (newX <= 0) return null;
  return `\x1b[<${match[1]};${newX};${match[3]}${match[4]}`;
}

export interface InputRouterOptions {
  sidebarCols: number;
  onPtyData: (data: string) => void;
  onSidebarClick: (row: number) => void;
  onSidebarScroll?: (delta: number) => void;
  onToolbarClick?: (col: number) => void;
  onHover?: (target: { area: "sidebar"; row: number } | { area: "toolbar"; col: number } | null) => void;
  onPaletteInput?: (data: string) => void;
  onSessionPrev?: () => void;
  onSessionNext?: () => void;
}

export class InputRouter {
  private opts: InputRouterOptions;
  private sidebarVisible: boolean;
  private paletteOpen = false;
  constructor(opts: InputRouterOptions, sidebarVisible: boolean) {
    this.opts = opts;
    this.sidebarVisible = sidebarVisible;
  }

  setSidebarVisible(visible: boolean): void {
    this.sidebarVisible = visible;
  }

  setPaletteOpen(open: boolean): void {
    this.paletteOpen = open;
  }

  handleInput(data: string): void {
    // Always-active hotkeys: Ctrl-Shift-Up/Down for session switching
    if (data === "\x1b[1;6A") {
      this.opts.onSessionPrev?.();
      return;
    }
    if (data === "\x1b[1;6B") {
      this.opts.onSessionNext?.();
      return;
    }

    // Check for SGR mouse events
    const mouse = parseSgrMouse(data);
    if (mouse && this.sidebarVisible) {
      const isMotion = (mouse.button & 32) !== 0;
      const isWheel = (mouse.button & 64) !== 0;

      // Dispatch hover on any motion event
      if (isMotion && this.opts.onHover) {
        if (mouse.x <= this.opts.sidebarCols) {
          this.opts.onHover({ area: "sidebar", row: mouse.y - 1 });
        } else if (!this.paletteOpen) {
          if (mouse.y === 1) {
            this.opts.onHover({ area: "toolbar", col: mouse.x - this.opts.sidebarCols - 1 });
          } else {
            this.opts.onHover(null);
          }
        }
      }

      if (mouse.x <= this.opts.sidebarCols) {
        // Wheel events: button 64 = up, 65 = down
        if (isWheel) {
          const delta = (mouse.button & 1) ? 3 : -3;
          this.opts.onSidebarScroll?.(delta);
          return;
        }
        // Click in sidebar region (ignore drags/motion)
        if (!mouse.release && !isMotion) {
          this.opts.onSidebarClick(mouse.y - 1); // 0-indexed row
        }
        return; // Consume sidebar mouse events
      }

      // When palette is open, ignore all non-sidebar mouse events
      if (this.paletteOpen) return;

      // Toolbar click — row 1 in main area
      if (mouse.y === 1 && !mouse.release && !isMotion && !isWheel) {
        const mainCol = mouse.x - this.opts.sidebarCols - 1; // 0-indexed in main area
        this.opts.onToolbarClick?.(mainCol);
        return;
      }
      // Mouse in main area — translate X coordinate and Y (offset by toolbar)
      // Don't forward bare motion events to PTY (too noisy)
      if (isMotion && (mouse.button & 0x03) === 3) return;
      const offset = this.opts.sidebarCols + 1;
      const yOffset = 1;
      const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
      if (match) {
        const newX = parseInt(match[2], 10) - offset;
        const newY = parseInt(match[3], 10) - yOffset;
        if (newX > 0 && newY > 0) {
          this.opts.onPtyData(`\x1b[<${match[1]};${newX};${newY}${match[4]}`);
        }
      }
      return;
    }

    // When palette is open, route keyboard input to palette callback
    if (this.paletteOpen) {
      this.opts.onPaletteInput?.(data);
      return;
    }

    // Default: pass through to PTY
    this.opts.onPtyData(data);
  }
}
