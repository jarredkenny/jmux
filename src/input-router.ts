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
  tmuxPrefix: string; // raw byte(s) for tmux prefix key, e.g. "\x01"
  prefixTimeout: number; // ms to wait for follow-up key after prefix
  onPtyData: (data: string) => void;
  onSidebarEnter: () => void;
  onSidebarClick: (row: number) => void;
  onSidebarExit?: () => void;
  onSessionPrev?: () => void;
  onSessionNext?: () => void;
  onNewSession?: () => void;
}

export class InputRouter {
  private opts: InputRouterOptions;
  private sidebarMode = false;
  private prefixPending = false;
  private prefixTimer: ReturnType<typeof setTimeout> | null = null;
  private sidebarVisible: boolean;
  private onSidebarKey: ((key: string) => void) | null = null;

  constructor(opts: InputRouterOptions, sidebarVisible: boolean) {
    this.opts = opts;
    this.sidebarVisible = sidebarVisible;
  }

  setSidebarVisible(visible: boolean): void {
    this.sidebarVisible = visible;
  }

  setSidebarKeyHandler(handler: ((key: string) => void) | null): void {
    this.onSidebarKey = handler;
  }

  handleInput(data: string): void {
    // If in sidebar mode, route to sidebar handler
    if (this.sidebarMode) {
      this.handleSidebarModeInput(data);
      return;
    }

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
      if (mouse.x <= this.opts.sidebarCols) {
        // Click in sidebar region
        if (!mouse.release) {
          this.opts.onSidebarClick(mouse.y - 1); // 0-indexed row
        }
        return; // Consume sidebar mouse events
      }
      // Mouse in main area — translate X coordinate
      const translated = translateMouseX(data, this.opts.sidebarCols + 1);
      if (translated) {
        this.opts.onPtyData(translated);
      }
      return;
    }

    // Check for prefix key
    if (data === this.opts.tmuxPrefix && !this.prefixPending) {
      this.prefixPending = true;
      this.prefixTimer = setTimeout(() => {
        // Timeout: forward prefix to PTY
        this.prefixPending = false;
        this.prefixTimer = null;
        this.opts.onPtyData(this.opts.tmuxPrefix);
      }, this.opts.prefixTimeout);
      return;
    }

    // If prefix is pending, check for 'j'
    if (this.prefixPending) {
      this.prefixPending = false;
      if (this.prefixTimer) {
        clearTimeout(this.prefixTimer);
        this.prefixTimer = null;
      }
      if (data === "j") {
        // Enter sidebar mode
        this.sidebarMode = true;
        this.opts.onSidebarEnter();
        return;
      }
      if (data === "n") {
        // Create new session
        this.opts.onNewSession?.();
        return;
      }
      // Not 'j' or 'n' — forward prefix + this key to PTY
      this.opts.onPtyData(this.opts.tmuxPrefix + data);
      return;
    }

    // Default: pass through to PTY
    this.opts.onPtyData(data);
  }

  exitSidebarMode(): void {
    this.sidebarMode = false;
  }

  isInSidebarMode(): boolean {
    return this.sidebarMode;
  }

  private handleSidebarModeInput(data: string): void {
    if (data === "\x1b") {
      // Escape — exit sidebar mode
      this.sidebarMode = false;
      this.opts.onSidebarExit?.();
      return;
    }
    if (this.onSidebarKey) {
      this.onSidebarKey(data);
    }
  }
}
