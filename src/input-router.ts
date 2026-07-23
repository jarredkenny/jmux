import type { FrameLayout } from "./frame-layout";

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

export function translateMouse(
  seq: string,
  xOffset: number,
  yOffset = 0,
): string | null {
  const match = seq.match(SGR_MOUSE_RE);
  if (!match) return null;
  const newX = parseInt(match[2], 10) - xOffset;
  const newY = parseInt(match[3], 10) - yOffset;
  if (newX <= 0 || newY <= 0) return null;
  return `\x1b[<${match[1]};${newX};${newY}${match[4]}`;
}

export interface InputRouterOptions {
  onPtyData: (data: string) => void;
  onSidebarClick: (row: number) => void;
  onSidebarScroll?: (delta: number) => void;
  onToolbarClick?: (col: number) => void;
  // Chrome footer row — see classifyRow. col is the 0-indexed absolute grid
  // column (the footer band spans the full terminal width, joining the
  // sidebar divider, so it is not relative to layout.main.x).
  onFooterClick?: (col: number) => void;
  onHover?: (target: { area: "sidebar"; row: number } | { area: "toolbar"; col: number } | null) => void;
  onModalInput?: (data: string) => void;
  onModalToggle?: () => void;
  onNewSession?: () => void;
  onSettings?: () => void;
  onSettingsScreen?: () => void;  // Ctrl-a I (uppercase) — full settings screen
  onSessionPrev?: () => void;
  onSessionNext?: () => void;
  // Pane-of-glass (Overview) additions
  glassActive?: () => boolean;                       // true while the glass is shown
  onGlassClick?: (x: number, y: number) => void;     // content-relative click → focus tile
  onGlassMouse?: (x: number, y: number, button: number, release: boolean) => void; // wheel/scroll → tile under cursor
  onGlassFocusMove?: (dir: "left" | "right" | "up" | "down") => void; // Shift+arrows
  onGlassDetach?: () => void;                        // prefix+d in glass → detach jmux, not the focused tile
  onGlassTabSwitch?: (index: number) => void;       // glass-only Ctrl-a <n> → switch tab
  onGlassTabRelative?: (delta: number) => void;     // glass-only Ctrl-a [ / ] → prev/next tab
  glassStripRows?: () => number;                    // tab-strip row count (0 when hidden)
  onGlassTabClick?: (x: number) => void;            // content-relative click on the strip row
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
  onPanelFilterStart?: () => void;
  onPanelFilterInput?: (char: string) => void;
  onPanelFilterBackspace?: () => void;
  onPanelFilterClear?: () => void;
  onPanelRefresh?: () => void;
  // Link clicking — jmux opens links itself rather than relying on the
  // terminal's (fragile, per-terminal) mouse-capture bypass. getLinkAt looks up
  // a rendered cell's URL by absolute 0-indexed grid coords; onOpenLink hands it
  // off to the OS opener.
  getLinkAt?: (x: number, y: number) => string | undefined;
  onOpenLink?: (url: string) => void;
}

export class InputRouter {
  private opts: InputRouterOptions;
  private layout: FrameLayout;
  private modalOpen = false;
  private prefixSeen = false;
  private prefixTimer: ReturnType<typeof setTimeout> | null = null;
  private glassPrefixDeferred = false;
  private diffPanelFocused = false;
  private panelTabsActive = false;
  private panelFilterActive = false;
  constructor(opts: InputRouterOptions, layout: FrameLayout) {
    this.opts = opts;
    this.layout = layout;
  }

  /**
   * Single source of truth for the frame's column/row geometry — see
   * src/frame-layout.ts. Replaces the five geometry setters this router used
   * to expose (setSidebarVisible/setMainCols/setDiffPanel(cols)/setToolbarRows
   * and the constructor's sidebarCols), which could be updated independently
   * of one another and drift out of sync with the actual rendered frame.
   * All hit-testing below reads `this.layout` directly.
   */
  setLayout(layout: FrameLayout): void {
    this.layout = layout;
  }

  setModalOpen(open: boolean): void {
    this.modalOpen = open;
  }

  /**
   * Classifies a 1-indexed SGR mouse row against the frame's chrome bands
   * (see src/frame-layout.ts). Rule and footer rows span the full terminal
   * width — including over the sidebar's column range — so this is a
   * row-only classification; it is checked before any column-based routing
   * (sidebar/toolbar/panel/main) in handleInput. With both chrome flags off
   * (today's production wiring) topRuleRow/footerRuleRow/footerRow are all
   * null, row can never equal null, and every row below toolbarRows falls
   * through to "content" — unchanged from pre-chrome behaviour.
   */
  classifyRow(y1: number): "toolbar" | "rule" | "content" | "footer" {
    const row = y1 - 1;
    const layout = this.layout;
    if (row < layout.toolbarRows) return "toolbar";
    if (row === layout.topRuleRow || row === layout.footerRuleRow) return "rule";
    if (row === layout.footerRow) return "footer";
    return "content";
  }

  /** Diff-panel keyboard focus. Geometry lives in `layout.panel` (setLayout); this is the one piece of diff-panel state that isn't geometry. */
  setPanelFocused(focused: boolean): void {
    this.diffPanelFocused = focused;
  }

  setPanelTabsActive(active: boolean): void {
    this.panelTabsActive = active;
  }

  setPanelFilterActive(active: boolean): void {
    this.panelFilterActive = active;
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

    // Pane-of-glass: Shift+arrows move focus between tiles (intercepted before
    // the diff-panel Shift handling and before reaching tmux).
    if (this.opts.glassActive?.() && !this.modalOpen) {
      if (data === "\x1b[1;2D") { this.opts.onGlassFocusMove?.("left"); return; }
      if (data === "\x1b[1;2C") { this.opts.onGlassFocusMove?.("right"); return; }
      if (data === "\x1b[1;2A") { this.opts.onGlassFocusMove?.("up"); return; }
      if (data === "\x1b[1;2B") { this.opts.onGlassFocusMove?.("down"); return; }
    }

    // Shift+Right/Left pane navigation integrating with diff panel
    if (this.layout.panel !== null && !this.modalOpen) {
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

        // Glass owns the post-prefix byte: digits switch tabs, jmux chords
        // intercept, everything else flushes the deferred prefix to the tile.
        if (this.opts.glassActive?.()) {
          const deferred = this.glassPrefixDeferred;
          this.glassPrefixDeferred = false;
          if (data >= "1" && data <= "9") {
            this.opts.onGlassTabSwitch?.(parseInt(data, 10));
            return;
          }
          if (data === "[") { this.opts.onGlassTabRelative?.(-1); return; }
          if (data === "]") { this.opts.onGlassTabRelative?.(1); return; }
          if (data === "d") { this.opts.onGlassDetach?.(); return; }
          if (data === "p") { this.opts.onModalToggle?.(); return; }
          if (data === "n") { this.opts.onNewSession?.(); return; }
          if (data === "i") { this.opts.onSettings?.(); return; }
          if (data === "I") { this.opts.onSettingsScreen?.(); return; }
          // Not a jmux chord — flush the buffered prefix, then the key, to the tile.
          if (deferred) this.opts.onPtyData("\x01");
          this.opts.onPtyData(data);
          return;
        }

        // Non-glass: existing intercepts.
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
        if (data === "z" && this.diffPanelFocused && this.layout.panel !== null) {
          this.opts.onDiffZoom?.();
          return;
        }
        if (data === "\t" && this.layout.panel !== null) {
          this.opts.onDiffPanelFocusToggle?.();
          return;
        }
        // When diff panel is focused, swallow unrecognized post-prefix keys
        if (this.diffPanelFocused && this.layout.panel !== null) {
          return;
        }
        // Not intercepted — forward to PTY normally (tmux handles its prefix binding)
      } else if (data === "\x01") {
        this.prefixSeen = true;
        this.prefixTimer = setTimeout(() => { this.prefixSeen = false; this.prefixTimer = null; this.glassPrefixDeferred = false; }, 2000);
        if (this.opts.glassActive?.()) {
          // In glass, defer the prefix: the next byte decides whether it's a
          // jmux action, a tab digit, or a real in-tile prefix chord.
          this.glassPrefixDeferred = true;
        } else if (!this.diffPanelFocused || this.layout.panel === null) {
          this.opts.onPtyData(data);
        }
        return;
      }
    }

    // Check for SGR mouse events. Grid-space conversion happens exactly once,
    // here — `gridX`/`gridY` are 0-indexed and every hit-test below reads
    // spans off `this.layout` rather than recomputing offsets from scattered
    // fields (see src/frame-layout.ts). `layout.sidebar` doubles as the gate
    // that used to be `sidebarVisible`: it's null exactly when the terminal
    // is too narrow for jmux's chrome, in which case mouse sequences fall
    // through to the default PTY passthrough below, same as before.
    const mouse = parseSgrMouse(data);
    const layout = this.layout;
    if (mouse && layout.sidebar) {
      const sidebar = layout.sidebar;
      const gridX = mouse.x - 1;
      const gridY = mouse.y - 1;
      const isMotion = (mouse.button & 32) !== 0;
      const isWheel = (mouse.button & 64) !== 0;

      // Chrome rule/footer rows span the full terminal width (they join the
      // sidebar divider — see docs/superpowers/plans/2026-07-23-chrome-frame.md
      // Tasks 5-6), so they're classified and routed here, before any
      // column-based routing (sidebar/toolbar/panel/main) gets a look. Rule
      // rows are purely decorative chrome: inert, swallowed outright. The
      // footer row dispatches a bare click to onFooterClick with the
      // absolute grid column, then is likewise consumed. With both chrome
      // flags off (today's production wiring) these rows are never present,
      // so classifyRow always returns "toolbar" or "content" here and this
      // block never fires — no behaviour change yet.
      const rowKind = this.classifyRow(mouse.y);
      if (rowKind === "rule") return;
      if (rowKind === "footer") {
        if (!mouse.release && !isMotion && !isWheel) {
          this.opts.onFooterClick?.(gridX);
        }
        return;
      }

      // Dispatch hover on any motion event
      if (isMotion && this.opts.onHover) {
        if (gridX < sidebar.w) {
          this.opts.onHover({ area: "sidebar", row: gridY });
        } else if (!this.modalOpen) {
          if (gridY < layout.toolbarRows) {
            this.opts.onHover({ area: "toolbar", col: gridX - layout.main.x });
          } else {
            this.opts.onHover(null);
          }
        }
      }

      // Link click: a clean left-click on a rendered link cell opens the URL
      // directly. jmux owns this rather than depending on the terminal's
      // mouse-capture bypass (which varies per terminal and has historically
      // drifted out of working). Checked before area routing so it works in the
      // main pane, glass tiles, diff and panels alike — getLinkAt reads the
      // composited grid by absolute coords. Only a bare left button event (no
      // motion/drag, not wheel) over the content area qualifies, so drag-to-
      // select and sidebar/toolbar clicks are untouched. The press opens; the
      // matching release over the same link cell is swallowed so tmux never
      // sees a stray event.
      if (
        !this.modalOpen &&
        gridX >= sidebar.w &&
        !isMotion &&
        !isWheel &&
        (mouse.button & 0x03) === 0
      ) {
        const url = this.opts.getLinkAt?.(gridX, gridY);
        if (url) {
          if (!mouse.release) this.opts.onOpenLink?.(url);
          return;
        }
      }

      if (gridX < sidebar.w) {
        // Wheel events: button 64 = up, 65 = down
        if (isWheel) {
          const delta = (mouse.button & 1) ? 3 : -3;
          this.opts.onSidebarScroll?.(delta);
          return;
        }
        // Click in sidebar region (ignore drags/motion)
        if (!mouse.release && !isMotion) {
          this.opts.onSidebarClick(gridY); // 0-indexed row
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

      // Pane-of-glass: forward mouse to the tile under the cursor so wheel
      // scrollback, copy-mode text selection (press→drag→release), and app
      // mouse interaction all work. A fresh press also focuses that tile.
      // Checked before toolbar so that glass strip row 1 isn't eaten by the
      // toolbar handler (there is no toolbar visible in glass mode).
      if (this.opts.glassActive?.()) {
        const stripRows = this.opts.glassStripRows?.() ?? 0;
        const cx = gridX - layout.main.x;
        const yInContent = gridY; // 0-indexed within the content column
        const bareMotion = isMotion && (mouse.button & 0x03) === 3;
        if (bareMotion) return; // ignore hover motion (no button held)

        // Strip row: a button-down switches tabs; ignore wheel/release/motion here.
        if (yInContent < stripRows) {
          if (!mouse.release && !isMotion && !isWheel) {
            this.opts.onGlassTabClick?.(cx);
          }
          return;
        }

        const cy = yInContent - stripRows; // tile-area row
        if (!mouse.release && !isMotion && !isWheel) {
          this.opts.onGlassClick?.(cx, cy); // focus on button-down
        }
        this.opts.onGlassMouse?.(cx, cy, mouse.button, mouse.release);
        return;
      }

      // Toolbar click — rows within layout.toolbarRows, anywhere in the main area
      if (gridY < layout.toolbarRows && !mouse.release && !isMotion && !isWheel) {
        const mainCol = gridX - layout.main.x; // 0-indexed in main area
        this.opts.onToolbarClick?.(mainCol);
        return;
      }

      // Diff panel mouse handling. `layout.panel` is set in both split and
      // full mode; full mode has no divider and `panel.x === main.x` (the
      // panel overlaps main rather than sitting after it), so the single
      // `gridX >= layout.panel.x` test below unifies both modes — a
      // content-area click in full mode routes to the panel, not to main.
      if (layout.panel) {
        // Divider click — toggle focus (split mode only; full mode has no divider)
        if (layout.divider !== null && gridX === layout.divider && !mouse.release && !isMotion && !isWheel) {
          this.opts.onDiffPanelFocusToggle?.();
          return;
        }

        if (gridX >= layout.panel.x) {
          const panelCol = gridX - layout.panel.x; // 0-indexed in panel

          // Panel tab bar — first row of the panel area (toolbar row)
          if (gridY === 0) {
            if (isMotion) {
              this.opts.onPanelTabHover?.(panelCol);
            } else if (!mouse.release && !isWheel) {
              this.opts.onPanelTabClick?.(panelCol);
            }
            return;
          }

          // Click in panel acquires keyboard focus
          if (!mouse.release && !isMotion && !isWheel && !this.diffPanelFocused) {
            this.opts.onDiffPanelFocusToggle?.();
          }

          // Non-diff tab: wheel scrolls the view
          if (this.panelTabsActive && isWheel) {
            const delta = (mouse.button & 1) ? 3 : -3;
            const panelRow = gridY - layout.contentTop;
            this.opts.onPanelScroll?.(delta, panelRow);
            return;
          }

          // Non-diff tab: clicks in list area select items
          if (this.panelTabsActive && !mouse.release && !isMotion && !isWheel) {
            const panelRow = gridY - layout.contentTop;
            if (panelRow >= 0) {
              this.opts.onPanelItemClick?.(panelRow); // main.ts bounds-checks against listRows
            }
            return;
          }

          if (isMotion && (mouse.button & 0x03) === 3) return; // bare motion, skip
          const translated = translateMouse(data, layout.panel.x, layout.contentTop);
          if (translated) {
            this.opts.onDiffPanelData?.(translated);
          }
          return;
        }
      }

      // Mouse in main area — translate X coordinate and Y (offset by the
      // first content row, layout.contentTop — not layout.toolbarRows, which
      // undercounts by the top rule row once chrome rules are enabled).
      // Click in main area releases diff panel focus
      if (!mouse.release && !isMotion && !isWheel && this.diffPanelFocused && layout.panel) {
        this.opts.onDiffPanelFocusToggle?.();
      }
      // Don't forward bare motion events to PTY (too noisy)
      if (isMotion && (mouse.button & 0x03) === 3) return;
      const mainTranslated = translateMouse(data, layout.main.x, layout.contentTop);
      if (mainTranslated) {
        this.opts.onPtyData(mainTranslated);
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
    if (this.diffPanelFocused && this.layout.panel !== null) {
      // Tab switching — clear filter mode first
      if (data === "[" && this.opts.onPanelPrevTab) {
        if (this.panelFilterActive) { this.panelFilterActive = false; this.opts.onPanelFilterClear?.(); }
        this.opts.onPanelPrevTab();
        return;
      }
      if (data === "]" && this.opts.onPanelNextTab) {
        if (this.panelFilterActive) { this.panelFilterActive = false; this.opts.onPanelFilterClear?.(); }
        this.opts.onPanelNextTab();
        return;
      }

      // Filter mode — captures all input when active
      if (this.panelTabsActive && this.panelFilterActive) {
        // Arrow navigation still works during filter
        if (data === "\x1b[A" && this.opts.onPanelSelectPrev) { this.opts.onPanelSelectPrev(); return; }
        if (data === "\x1b[B" && this.opts.onPanelSelectNext) { this.opts.onPanelSelectNext(); return; }
        // Enter confirms filter — exit input capture but keep filterQuery
        if (data === "\r") { this.panelFilterActive = false; return; }
        // Esc clears filter and exits filter mode
        if (data === "\x1b") { this.panelFilterActive = false; this.opts.onPanelFilterClear?.(); return; }
        // Backspace removes last char
        if (data === "\x7f") { this.opts.onPanelFilterBackspace?.(); return; }
        // Printable chars append to filter query
        if (data.length === 1 && data.charCodeAt(0) >= 32) { this.opts.onPanelFilterInput?.(data); return; }
        // Everything else consumed
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
        // Esc clears a persisted filter (when not in filter input mode)
        if (data === "\x1b" && this.opts.onPanelFilterClear) { this.opts.onPanelFilterClear(); return; }
        if (data === "g" && this.opts.onPanelCycleGroupBy) { this.opts.onPanelCycleGroupBy(); return; }
        if (data === "G" && this.opts.onPanelCycleSubGroupBy) { this.opts.onPanelCycleSubGroupBy(); return; }
        if (data === "/" && this.opts.onPanelFilterStart) { this.panelFilterActive = true; this.opts.onPanelFilterStart(); return; }
        if (data === "S" && this.opts.onPanelCycleSortBy) { this.opts.onPanelCycleSortBy(); return; }
        if (data === "?" && this.opts.onPanelToggleSortOrder) { this.opts.onPanelToggleSortOrder(); return; }
        if (data === "r" && this.opts.onPanelRefresh) { this.opts.onPanelRefresh(); return; }
        if (data === "\r" && this.opts.onPanelToggleCollapse) { this.opts.onPanelToggleCollapse(); return; }
        if (data === "n" && this.opts.onPanelCreateSession) { this.opts.onPanelCreateSession(); return; }
        if (data === "l" && this.opts.onPanelLinkToSession) { this.opts.onPanelLinkToSession(); return; }
      }
      if (this.panelTabsActive && this.opts.onPanelAction && (data === "o" || data === "a" || data === "s" || data === "c" || data === "C")) {
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
