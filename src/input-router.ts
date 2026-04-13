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
  onModalInput?: (data: string) => void;
  onModalToggle?: () => void;
  onNewSession?: () => void;
  onSettings?: () => void;
  onSettingsScreen?: () => void;  // Ctrl-a I (uppercase) — full settings screen
  onSessionPrev?: () => void;
  onSessionNext?: () => void;
  // Diff panel additions
  onDiffPanelData?: (data: string) => void;
  onDiffPanelFocusToggle?: () => void;
  onDiffToggle?: () => void;
  onDiffZoom?: () => void;  // Ctrl-a z when diff panel is focused — toggles split/full
  onPaneNavRight?: () => void;  // Shift+Right when diff panel is open — main.ts queries pane_at_right
  // Info panel tab / action callbacks
  onPanelPrevTab?: () => void;
  onPanelNextTab?: () => void;
  onPanelAction?: (key: string) => void;
  onPanelTabClick?: (col: number) => void; // col relative to panel start
  onPanelItemClick?: (row: number) => void; // row relative to panel content start (after toolbar)
  onPanelTabHover?: (col: number) => void; // col relative to panel start, for hover detection
  onPanelScroll?: (delta: number, row: number) => void; // wheel scroll in panel area, row relative to content
  onPanelSelectPrev?: () => void;
  onPanelSelectNext?: () => void;
  onPanelCycleGroupBy?: () => void;
  onPanelCycleSubGroupBy?: () => void;
  onPanelCycleSortBy?: () => void;
  onPanelToggleSortOrder?: () => void;
  onPanelToggleCollapse?: () => void;
  onPanelCreateSession?: () => void;  // 'n' key
  onPanelLinkToSession?: () => void;  // 'l' key
}

export class InputRouter {
  private opts: InputRouterOptions;
  private sidebarVisible: boolean;
  private modalOpen = false;
  private prefixSeen = false;
  private prefixTimer: ReturnType<typeof setTimeout> | null = null;
  private diffPanelCols = 0;
  private diffPanelFocused = false;
  private mainCols = 0;
  private panelTabsActive = false;
  constructor(opts: InputRouterOptions, sidebarVisible: boolean) {
    this.opts = opts;
    this.sidebarVisible = sidebarVisible;
  }

  setSidebarVisible(visible: boolean): void {
    this.sidebarVisible = visible;
  }

  setModalOpen(open: boolean): void {
    this.modalOpen = open;
  }

  setDiffPanel(cols: number, focused: boolean): void {
    this.diffPanelCols = cols;
    this.diffPanelFocused = focused;
  }

  setPanelTabsActive(active: boolean): void {
    this.panelTabsActive = active;
  }

  setMainCols(cols: number): void {
    this.mainCols = cols;
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

    // Shift+Right/Left pane navigation integrating with diff panel
    if (this.diffPanelCols > 0 && !this.modalOpen) {
      // Shift+Left from diff panel: unfocus back to tmux
      if (data === "\x1b[1;2D" && this.diffPanelFocused) {
        this.opts.onDiffPanelFocusToggle?.();
        return;
      }
      // Shift+Right when tmux focused: let main.ts check pane_at_right
      if (data === "\x1b[1;2C" && !this.diffPanelFocused) {
        this.opts.onPaneNavRight?.();
        return;
      }
    }

    // Ctrl-a p interception: detect prefix + p to toggle palette
    // Ctrl-a is forwarded to tmux (so other prefix bindings work),
    // but if next byte is "p" we intercept it before tmux sees it.
    if (!this.modalOpen) {
      if (this.prefixSeen) {
        this.prefixSeen = false;
        if (this.prefixTimer) { clearTimeout(this.prefixTimer); this.prefixTimer = null; }
        if (data === "p") {
          this.opts.onModalToggle?.();
          return;
        }
        if (data === "n") {
          this.opts.onNewSession?.();
          return;
        }
        if (data === "i") {
          this.opts.onSettings?.();
          return;
        }
        if (data === "I") {
          this.opts.onSettingsScreen?.();
          return;
        }
        if (data === "g") {
          this.opts.onDiffToggle?.();
          return;
        }
        if (data === "z" && this.diffPanelFocused && this.diffPanelCols > 0) {
          this.opts.onDiffZoom?.();
          return;
        }
        if (data === "\t" && this.diffPanelCols > 0) {
          this.opts.onDiffPanelFocusToggle?.();
          return;
        }
        // When diff panel is focused, swallow unrecognized post-prefix keys
        if (this.diffPanelFocused && this.diffPanelCols > 0) {
          return;
        }
        // Not intercepted — forward to PTY normally (tmux handles its prefix binding)
      } else if (data === "\x01") {
        this.prefixSeen = true;
        this.prefixTimer = setTimeout(() => { this.prefixSeen = false; this.prefixTimer = null; }, 2000);
        // Only forward Ctrl-a to PTY when tmux is focused (not when diff panel is focused)
        if (!this.diffPanelFocused || this.diffPanelCols === 0) {
          this.opts.onPtyData(data);
        }
        return;
      }
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
        } else if (!this.modalOpen) {
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

      // When modal is open, forward wheel events as arrow keys, ignore other mouse events
      if (this.modalOpen) {
        if (isWheel) {
          this.opts.onModalInput?.((mouse.button & 1) ? "\x1b[B" : "\x1b[A");
        }
        return;
      }

      // Toolbar click — row 1 in main area
      if (mouse.y === 1 && !mouse.release && !isMotion && !isWheel) {
        const mainCol = mouse.x - this.opts.sidebarCols - 1; // 0-indexed in main area
        this.opts.onToolbarClick?.(mainCol);
        return;
      }

      // Diff panel mouse handling
      if (this.diffPanelCols > 0) {
        const dividerX = this.opts.sidebarCols + 1 + this.mainCols + 1; // 1-indexed

        // Divider click — toggle focus
        if (mouse.x === dividerX && !mouse.release && !isMotion && !isWheel) {
          this.opts.onDiffPanelFocusToggle?.();
          return;
        }

        // Panel tab bar — row 1 in the panel area (toolbar row)
        if (mouse.y === 1 && mouse.x > dividerX) {
          const panelCol = mouse.x - dividerX - 1; // 0-indexed in panel
          if (isMotion) {
            this.opts.onPanelTabHover?.(panelCol);
          } else if (!mouse.release && !isWheel) {
            this.opts.onPanelTabClick?.(panelCol);
          }
          return;
        }

        // Diff panel region
        if (mouse.x > dividerX) {
          // Click in panel acquires keyboard focus
          if (!mouse.release && !isMotion && !isWheel && !this.diffPanelFocused) {
            this.opts.onDiffPanelFocusToggle?.();
          }

          // Non-diff tab: wheel scrolls the view
          if (this.panelTabsActive && isWheel) {
            const delta = (mouse.button & 1) ? 3 : -3;
            const panelRow = mouse.y - 2; // -1 for 1-indexed, -1 for toolbar
            this.opts.onPanelScroll?.(delta, panelRow);
            return;
          }

          // Non-diff tab: clicks in list area select items
          if (this.panelTabsActive && !mouse.release && !isMotion && !isWheel) {
            const panelRow = mouse.y - 2; // -1 for 1-indexed, -1 for toolbar row
            if (panelRow >= 0) {
              this.opts.onPanelItemClick?.(panelRow); // main.ts bounds-checks against listRows
            }
            return;
          }

          if (isMotion && (mouse.button & 0x03) === 3) return; // bare motion, skip
          const diffOffset = dividerX;
          const yOffset = 1; // toolbar row
          const m = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
          if (m) {
            const newX = parseInt(m[2], 10) - diffOffset;
            const newY = parseInt(m[3], 10) - yOffset;
            if (newX > 0 && newY > 0) {
              this.opts.onDiffPanelData?.(`\x1b[<${m[1]};${newX};${newY}${m[4]}`);
            }
          }
          return;
        }
      }

      // Mouse in main area — translate X coordinate and Y (offset by toolbar)
      // Click in main area releases diff panel focus
      if (!mouse.release && !isMotion && !isWheel && this.diffPanelFocused && this.diffPanelCols > 0) {
        this.opts.onDiffPanelFocusToggle?.();
      }
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
    if (this.modalOpen) {
      this.opts.onModalInput?.(data);
      return;
    }

    // When diff panel is focused, intercept tab-switching and action keys before
    // forwarding to the diff panel's underlying process
    if (this.diffPanelFocused && this.diffPanelCols > 0) {
      if (data === "[" && this.opts.onPanelPrevTab) {
        this.opts.onPanelPrevTab();
        return;
      }
      if (data === "]" && this.opts.onPanelNextTab) {
        this.opts.onPanelNextTab();
        return;
      }
      // Up/Down arrow for item selection within a tab (only on MR/Issues tabs)
      if (this.panelTabsActive) {
        if (data === "\x1b[A" && this.opts.onPanelSelectPrev) {
          this.opts.onPanelSelectPrev();
          return;
        }
        if (data === "\x1b[B" && this.opts.onPanelSelectNext) {
          this.opts.onPanelSelectNext();
          return;
        }
      }
      if (this.panelTabsActive) {
        if (data === "g" && this.opts.onPanelCycleGroupBy) { this.opts.onPanelCycleGroupBy(); return; }
        if (data === "G" && this.opts.onPanelCycleSubGroupBy) { this.opts.onPanelCycleSubGroupBy(); return; }
        if (data === "/" && this.opts.onPanelCycleSortBy) { this.opts.onPanelCycleSortBy(); return; }
        if (data === "?" && this.opts.onPanelToggleSortOrder) { this.opts.onPanelToggleSortOrder(); return; }
        if (data === "\r" && this.opts.onPanelToggleCollapse) { this.opts.onPanelToggleCollapse(); return; }
        if (data === "n" && this.opts.onPanelCreateSession) { this.opts.onPanelCreateSession(); return; }
        if (data === "l" && this.opts.onPanelLinkToSession) { this.opts.onPanelLinkToSession(); return; }
      }
      if (this.panelTabsActive && this.opts.onPanelAction && (data === "o" || data === "r" || data === "a" || data === "s" || data === "c")) {
        this.opts.onPanelAction(data);
        return;
      }
      this.opts.onDiffPanelData?.(data);
      return;
    }

    // Default: pass through to PTY
    this.opts.onPtyData(data);
  }
}
