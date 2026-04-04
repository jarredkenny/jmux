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
    const prefix = this.opts.tmuxPrefix;
    if (data.startsWith(prefix) && !this.prefixPending) {
      const rest = data.slice(prefix.length);
      if (rest.length === 0) {
        // Just the prefix byte alone — wait for follow-up
        this.prefixPending = true;
        this.prefixTimer = setTimeout(() => {
          this.prefixPending = false;
          this.prefixTimer = null;
          this.opts.onPtyData(prefix);
        }, this.opts.prefixTimeout);
        return;
      }
      // Prefix + follow-up arrived in same chunk
      if (this.handlePrefixFollowUp(rest)) return;
      // Not intercepted — forward entire chunk to PTY
      this.opts.onPtyData(data);
      return;
    }

    // If prefix is pending, check follow-up key
    if (this.prefixPending) {
      this.prefixPending = false;
      if (this.prefixTimer) {
        clearTimeout(this.prefixTimer);
        this.prefixTimer = null;
      }
      if (this.handlePrefixFollowUp(data)) return;
      // Not intercepted — forward prefix + this key to PTY
      this.opts.onPtyData(prefix + data);
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

  private handlePrefixFollowUp(key: string): boolean {
    if (key === "j") {
      this.sidebarMode = true;
      this.opts.onSidebarEnter();
      return true;
    }
    return false;
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
