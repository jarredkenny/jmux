import type { CellGrid, AgentState } from "../types";
import { createGrid, writeString, cellWidth, type CellAttrs } from "../cell-grid";
import { ColorMode } from "../types";

// Border palette by agent state — matches the sidebar's agent-state colors
// (running=green 2, waiting=yellow 3, complete=blue 4).
const AGENT_BORDER_PALETTE: Record<AgentState, number> = {
  running: 2,
  waiting: 3,
  complete: 4,
};

// ─── Tile label chip ─────────────────────────────────────────────────────────
// The label renders as a filled chip on the top border, like the toolbar's
// window tabs. Focused: bold emerald-400 text on a slate background. Unfocused:
// dim gray text on a darker, subtler background — so focus reads at a glance.
const LABEL_ACCENT_RGB = (0x34 << 16) | (0xD3 << 8) | 0x99; // #34D399 emerald-400
const LABEL_DIM_RGB    = (0x6e << 16) | (0x76 << 8) | 0x80; // #6E7680 gray
const CHIP_BG_FOCUSED  = (0x1e << 16) | (0x2a << 8) | 0x35; // #1E2A35 (toolbar activeBg)
const CHIP_BG_DIM      = (0x26 << 16) | (0x2b << 8) | 0x33; // #262B33 subtle slate
import { ScreenBridge } from "../screen-bridge";
import { TmuxPty } from "../tmux-pty";
import { computeTileLayout } from "./layout";
import type { TileRect } from "./layout";

// ─── Box-drawing characters ──────────────────────────────────────────────────
const BOX_H  = "─"; // ─
const BOX_V  = "│"; // │
const BOX_TL = "┌"; // ┌
const BOX_TR = "┐"; // ┐
const BOX_BL = "└"; // └
const BOX_BR = "┘"; // ┘

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GlassTileSpec {
  paneId: string;      // e.g. "%7" — the pinned pane
  sessionId: string;   // its home session id, e.g. "$2"
  windowId: string;    // its home window id, e.g. "@5"
  label: string;       // pre-built display label
  agentState?: AgentState | null; // drives the border color (matches sidebar)
}

export interface GlassViewOptions {
  socketName?: string;
  configFile?: string;
  jmuxDir?: string;
  runner: (args: string[]) => { ok: boolean; lines: string[] }; // sync tmux
  minTileWidth: number;
  minTileHeight: number;
  onFrame: () => void; // call to request a re-render (debounced by caller)
}

// ─── Internal tile state ──────────────────────────────────────────────────────

interface TileState {
  spec: GlassTileSpec;
  pty: TmuxPty;
  bridge: ScreenBridge;
  /** True when WE issued the zoom; teardown must undo it. */
  didZoom: boolean;
  /** Per-tile pending write counter, mirrors the main.ts pattern. */
  writesPending: number;
}

// ─── GlassView ────────────────────────────────────────────────────────────────

export class GlassView {
  private opts: GlassViewOptions;
  private tiles: Map<string, TileState> = new Map(); // keyed by paneId
  private tileOrder: string[] = [];                  // paneId insertion order → index
  private focusedIndex: number = 0;
  private width: number = 80;
  private height: number = 24;
  private scrollRow: number = 0;

  constructor(opts: GlassViewOptions) {
    this.opts = opts;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setTiles(specs: GlassTileSpec[]): void {
    const incoming = new Set(specs.map((s) => s.paneId));

    // Tear down tiles that are no longer in the spec list.
    for (const paneId of [...this.tiles.keys()]) {
      if (!incoming.has(paneId)) {
        this.teardownTile(paneId);
      }
    }

    // Determine stable order: keep existing order for survivors, append new ones.
    const newOrder: string[] = this.tileOrder.filter((id) => incoming.has(id));
    for (const spec of specs) {
      if (!newOrder.includes(spec.paneId)) {
        newOrder.push(spec.paneId);
      }
    }
    this.tileOrder = newOrder;

    // Spawn tiles that are newly added.
    for (const spec of specs) {
      if (!this.tiles.has(spec.paneId)) {
        this.ensureTile(spec);
      } else {
        // Update the label in case it changed.
        this.tiles.get(spec.paneId)!.spec.label = spec.label;
      }
    }

    // Clamp focused index.
    if (this.tileOrder.length > 0) {
      this.focusedIndex = Math.min(this.focusedIndex, this.tileOrder.length - 1);
    } else {
      this.focusedIndex = 0;
    }

    // Resize all tiles to match current geometry.
    this.resizeAllTiles();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.resizeAllTiles();
  }

  getGrid(): CellGrid {
    const grid = createGrid(this.width, this.height);

    if (this.tileOrder.length === 0) {
      // Empty state: show a centered hint.
      const msg = "No pinned panes";
      const col = Math.max(0, Math.floor((this.width - msg.length) / 2));
      const row = Math.max(0, Math.floor(this.height / 2));
      writeString(grid, row, col, msg, {
        fgMode: ColorMode.Palette,
        fg: 8, // dark gray
      });
      return grid;
    }

    const layout = computeTileLayout({
      tileCount: this.tileOrder.length,
      mainWidth: this.width,
      mainHeight: this.height,
      minTileWidth: this.opts.minTileWidth,
      minTileHeight: this.opts.minTileHeight,
      focusedIndex: this.focusedIndex,
      scrollRow: this.scrollRow,
    });

    // Update scrollRow from layout (it may have been clamped/adjusted).
    this.scrollRow = layout.scrollRow;

    for (const rect of layout.tiles) {
      if (!rect.visible) continue;
      const paneId = this.tileOrder[rect.index];
      if (!paneId) continue;
      const tile = this.tiles.get(paneId);
      if (!tile) continue;

      const isFocused = rect.index === this.focusedIndex;
      this.drawTile(grid, rect, tile, isFocused);
    }

    return grid;
  }

  focusAt(x: number, y: number): void {
    if (this.tileOrder.length === 0) return;
    const layout = computeTileLayout({
      tileCount: this.tileOrder.length,
      mainWidth: this.width,
      mainHeight: this.height,
      minTileWidth: this.opts.minTileWidth,
      minTileHeight: this.opts.minTileHeight,
      focusedIndex: this.focusedIndex,
      scrollRow: this.scrollRow,
    });
    for (const rect of layout.tiles) {
      if (!rect.visible) continue;
      if (
        x >= rect.x && x < rect.x + rect.width &&
        y >= rect.y && y < rect.y + rect.height
      ) {
        this.focusedIndex = rect.index;
        return;
      }
    }
  }

  moveFocus(dir: "left" | "right" | "up" | "down"): void {
    if (this.tileOrder.length === 0) return;
    const layout = computeTileLayout({
      tileCount: this.tileOrder.length,
      mainWidth: this.width,
      mainHeight: this.height,
      minTileWidth: this.opts.minTileWidth,
      minTileHeight: this.opts.minTileHeight,
      focusedIndex: this.focusedIndex,
      scrollRow: this.scrollRow,
    });
    const cols = layout.columns;
    const total = this.tileOrder.length;
    let next = this.focusedIndex;

    switch (dir) {
      case "left":
        if (next % cols > 0) next--;
        break;
      case "right":
        if (next % cols < cols - 1 && next + 1 < total) next++;
        break;
      case "up":
        if (next - cols >= 0) next -= cols;
        break;
      case "down":
        if (next + cols < total) next += cols;
        break;
    }

    this.focusedIndex = next;
  }

  writeFocused(data: string): void {
    const paneId = this.tileOrder[this.focusedIndex];
    if (!paneId) return;
    const tile = this.tiles.get(paneId);
    if (!tile) return;
    tile.pty.write(data);
  }

  /**
   * Forward a mouse event (e.g. wheel scroll) to the tile under the cursor,
   * translated into that tile's pane-local 1-indexed coordinates. This makes
   * scrollback / copy-mode work per-tile. x/y are glass-viewport-relative.
   */
  forwardMouse(x: number, y: number, button: number, release: boolean): void {
    if (this.tileOrder.length === 0) return;
    const layout = computeTileLayout({
      tileCount: this.tileOrder.length,
      mainWidth: this.width,
      mainHeight: this.height,
      minTileWidth: this.opts.minTileWidth,
      minTileHeight: this.opts.minTileHeight,
      focusedIndex: this.focusedIndex,
      scrollRow: this.scrollRow,
    });
    for (const rect of layout.tiles) {
      if (!rect.visible) continue;
      if (
        x >= rect.x && x < rect.x + rect.width &&
        y >= rect.y && y < rect.y + rect.height
      ) {
        const paneId = this.tileOrder[rect.index];
        const tile = paneId ? this.tiles.get(paneId) : undefined;
        if (!tile) return;
        // Interior begins after the 1-cell border; tmux mouse coords are 1-indexed.
        const localCol = x - rect.x; // (x - (rect.x + 1)) + 1
        const localRow = y - rect.y;
        if (localCol < 1 || localRow < 1) return;
        tile.pty.write(`\x1b[<${button};${localCol};${localRow}${release ? "m" : "M"}`);
        return;
      }
    }
  }

  focusedPaneId(): string | null {
    if (this.tileOrder.length === 0) return null;
    return this.tileOrder[this.focusedIndex] ?? null;
  }

  /**
   * Cursor position of the focused tile, translated into this view's grid
   * coordinates (accounting for the tile's rect offset + 1-cell border).
   * Returns null when there is no focused tile or it's scrolled off-screen.
   */
  getFocusedCursor(): { x: number; y: number } | null {
    const paneId = this.tileOrder[this.focusedIndex];
    if (!paneId) return null;
    const tile = this.tiles.get(paneId);
    if (!tile) return null;

    const layout = computeTileLayout({
      tileCount: this.tileOrder.length,
      mainWidth: this.width,
      mainHeight: this.height,
      minTileWidth: this.opts.minTileWidth,
      minTileHeight: this.opts.minTileHeight,
      focusedIndex: this.focusedIndex,
      scrollRow: this.scrollRow,
    });
    const rect = layout.tiles[this.focusedIndex];
    if (!rect || !rect.visible) return null;

    const cur = tile.bridge.getCursor();
    const iCols = Math.max(0, rect.width - 2);
    const iRows = Math.max(0, rect.height - 2);
    // Clamp into the tile interior so the cursor never lands on the border.
    const cx = Math.min(Math.max(0, cur.x), Math.max(0, iCols - 1));
    const cy = Math.min(Math.max(0, cur.y), Math.max(0, iRows - 1));
    return { x: rect.x + 1 + cx, y: rect.y + 1 + cy };
  }

  teardown(): void {
    for (const paneId of [...this.tiles.keys()]) {
      this.teardownTile(paneId);
    }
    this.tileOrder = [];
    this.focusedIndex = 0;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private ensureTile(spec: GlassTileSpec): void {
    const { runner, socketName, configFile, jmuxDir, onFrame } = this.opts;

    // 1. Point the home session at the pinned pane's window. We attach the
    //    mirror client DIRECTLY to the home session — never a new/group session,
    //    so teardown only ever DETACHES a client and can never destroy a
    //    session. The main client is parked while the glass is up, so this
    //    mirror is the only client on the session.
    runner([
      "select-window",
      "-t", `${spec.sessionId}:${spec.windowId}`,
    ]);

    // 3. Zoom the pane if the window has more than one pane and it isn't already.
    let didZoom = false;
    const panesResult = runner([
      "display-message", "-p", "-t", spec.paneId,
      "#{window_panes} #{window_zoomed_flag}",
    ]);
    if (panesResult.ok && panesResult.lines.length > 0) {
      const parts = panesResult.lines[0].trim().split(" ");
      const paneCount = parseInt(parts[0] ?? "0", 10);
      const zoomedFlag = parts[1] ?? "0";
      if (paneCount > 1 && zoomedFlag !== "1") {
        runner(["resize-pane", "-Z", "-t", spec.paneId]);
        didZoom = true;
      }
    }

    // 4. Compute initial tile dimensions.
    const { interiorCols, interiorRows } = this.getTileInterior(spec.paneId);

    // 5. Spawn the PTY as a second client attached to the home session
    //    (strictAttach → `tmux attach-session -t <session>`). Killing this pty
    //    later just detaches the client; the session is untouched.
    const pty = new TmuxPty({
      sessionName: spec.sessionId,
      socketName,
      configFile,
      jmuxDir,
      cols: interiorCols,
      rows: interiorRows,
      attachMode: "strictAttach",
    });

    // 6. Create the screen bridge.
    const bridge = new ScreenBridge(interiorCols, interiorRows);

    // 7. Wire data→bridge→onFrame, per-tile writesPending counter.
    const state: TileState = {
      spec,
      pty,
      bridge,
      didZoom,
      writesPending: 0,
    };

    pty.onData((data: string) => {
      state.writesPending++;
      bridge.write(data).then(() => {
        state.writesPending--;
        if (state.writesPending === 0) {
          onFrame();
        }
      });
    });

    this.tiles.set(spec.paneId, state);
  }

  private teardownTile(paneId: string): void {
    const tile = this.tiles.get(paneId);
    if (!tile) return;

    // Unzoom the pane if we were the ones who zoomed it (restore the layout).
    if (tile.didZoom) {
      this.opts.runner(["resize-pane", "-Z", "-t", paneId]);
    }

    // Detach the mirror client. This NEVER kills the session — the home session,
    // its windows, and the pane all survive untouched.
    tile.pty.kill();

    this.tiles.delete(paneId);
  }

  private resizeAllTiles(): void {
    if (this.tileOrder.length === 0) return;

    const layout = computeTileLayout({
      tileCount: this.tileOrder.length,
      mainWidth: this.width,
      mainHeight: this.height,
      minTileWidth: this.opts.minTileWidth,
      minTileHeight: this.opts.minTileHeight,
      focusedIndex: this.focusedIndex,
      scrollRow: this.scrollRow,
    });

    for (const rect of layout.tiles) {
      const paneId = this.tileOrder[rect.index];
      if (!paneId) continue;
      const tile = this.tiles.get(paneId);
      if (!tile) continue;

      const iCols = Math.max(1, rect.width - 2);
      const iRows = Math.max(1, rect.height - 2);
      tile.pty.resize(iCols, iRows);
      tile.bridge.resize(iCols, iRows);
    }
  }

  /**
   * Compute interior dimensions for a tile housing a given pane,
   * using the current layout. Falls back to a sensible minimum.
   */
  private getTileInterior(paneId: string): { interiorCols: number; interiorRows: number } {
    const index = this.tileOrder.indexOf(paneId);
    if (index < 0 || this.tileOrder.length === 0) {
      return { interiorCols: Math.max(1, this.width - 2), interiorRows: Math.max(1, this.height - 2) };
    }

    const layout = computeTileLayout({
      tileCount: this.tileOrder.length,
      mainWidth: this.width,
      mainHeight: this.height,
      minTileWidth: this.opts.minTileWidth,
      minTileHeight: this.opts.minTileHeight,
      focusedIndex: this.focusedIndex,
      scrollRow: this.scrollRow,
    });

    const rect = layout.tiles[index];
    if (!rect) {
      return { interiorCols: Math.max(1, this.width - 2), interiorRows: Math.max(1, this.height - 2) };
    }

    return {
      interiorCols: Math.max(1, rect.width - 2),
      interiorRows: Math.max(1, rect.height - 2),
    };
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  private drawTile(
    grid: CellGrid,
    rect: TileRect,
    tile: TileState,
    isFocused: boolean,
  ): void {
    // Border color encodes agent state (matching the sidebar). Focus stays
    // legible via bold (focused) vs dim (unfocused). Panes with no agent state
    // fall back to bright-white (focused) / dark-gray (unfocused).
    const state = tile.spec.agentState;
    const stateFg = state ? AGENT_BORDER_PALETTE[state] : undefined;
    const borderFg = stateFg ?? (isFocused ? 15 : 8);
    const borderFgMode = ColorMode.Palette;
    const borderBold = stateFg !== undefined && isFocused;
    const borderDim = stateFg !== undefined && !isFocused;
    const borderAttrs = { fg: borderFg, fgMode: borderFgMode, bold: borderBold, dim: borderDim };

    // The label pops in bold emerald when focused, dims to gray otherwise.
    const labelAttrs: CellAttrs = isFocused
      ? { fg: LABEL_ACCENT_RGB, fgMode: ColorMode.RGB, bold: true, bg: CHIP_BG_FOCUSED, bgMode: ColorMode.RGB }
      : { fg: LABEL_DIM_RGB, fgMode: ColorMode.RGB, bold: false, bg: CHIP_BG_DIM, bgMode: ColorMode.RGB };

    const { x, y, width, height } = rect;

    if (width < 2 || height < 2) return;

    // Top border: ┌─ label ─────┐
    this.drawBorderRow(grid, y, x, width, true, tile.spec.label, borderAttrs, labelAttrs);

    // Bottom border: └──────────┘
    this.drawBorderRow(grid, y + height - 1, x, width, false, "", borderAttrs);

    // Side borders.
    for (let row = y + 1; row < y + height - 1; row++) {
      if (row < 0 || row >= grid.rows) continue;
      if (x >= 0 && x < grid.cols) {
        const leftCell = grid.cells[row][x];
        leftCell.char = BOX_V;
        leftCell.width = 1;
        leftCell.fg = borderFg;
        leftCell.fgMode = borderFgMode;
        leftCell.bold = borderBold;
        leftCell.dim = borderDim;
      }
      const rightX = x + width - 1;
      if (rightX >= 0 && rightX < grid.cols) {
        const rightCell = grid.cells[row][rightX];
        rightCell.char = BOX_V;
        rightCell.width = 1;
        rightCell.fg = borderFg;
        rightCell.fgMode = borderFgMode;
        rightCell.bold = borderBold;
        rightCell.dim = borderDim;
      }
    }

    // Blit interior: copy bridge cells into grid at (x+1, y+1).
    const bridgeGrid = tile.bridge.getGrid();
    const iStartX = x + 1;
    const iStartY = y + 1;
    const iCols = width - 2;
    const iRows = height - 2;

    for (let bRow = 0; bRow < Math.min(iRows, bridgeGrid.rows); bRow++) {
      const gRow = iStartY + bRow;
      if (gRow < 0 || gRow >= grid.rows) continue;
      for (let bCol = 0; bCol < Math.min(iCols, bridgeGrid.cols); bCol++) {
        const gCol = iStartX + bCol;
        if (gCol < 0 || gCol >= grid.cols) continue;
        const src = bridgeGrid.cells[bRow][bCol];
        const dst = grid.cells[gRow][gCol];

        // For wide (width=2) cells, skip if it would overflow the interior.
        if (src.width === 2 && bCol + 1 >= iCols) {
          // Replace with a space to avoid overflow.
          dst.char = " ";
          dst.width = 1;
          dst.fg = src.fg;
          dst.fgMode = src.fgMode;
          dst.bg = src.bg;
          dst.bgMode = src.bgMode;
          dst.bold = src.bold;
          dst.italic = src.italic;
          dst.underline = src.underline;
          dst.dim = src.dim;
          dst.link = src.link;
          continue;
        }

        dst.char = src.char;
        dst.width = src.width;
        dst.fg = src.fg;
        dst.fgMode = src.fgMode;
        dst.bg = src.bg;
        dst.bgMode = src.bgMode;
        dst.bold = src.bold;
        dst.italic = src.italic;
        dst.underline = src.underline;
        dst.dim = src.dim;
        dst.link = src.link;
      }
    }
  }

  /**
   * Draw one horizontal border row (top or bottom) with optional label.
   * Top row: ┌─[label]─────┐
   * Bottom row: └────────────┘
   */
  private drawBorderRow(
    grid: CellGrid,
    row: number,
    startX: number,
    width: number,
    isTop: boolean,
    label: string,
    borderAttrs: { fg: number; fgMode: ColorMode; bold?: boolean; dim?: boolean },
    labelAttrs?: CellAttrs,
  ): void {
    if (row < 0 || row >= grid.rows) return;
    if (width < 2) return;

    const bold = borderAttrs.bold ?? false;
    const dim = borderAttrs.dim ?? false;
    const leftCorner  = isTop ? BOX_TL : BOX_BL;
    const rightCorner = isTop ? BOX_TR : BOX_BR;

    // Left corner.
    const leftX = startX;
    if (leftX >= 0 && leftX < grid.cols) {
      const cell = grid.cells[row][leftX];
      cell.char = leftCorner;
      cell.width = 1;
      cell.fg = borderAttrs.fg;
      cell.fgMode = borderAttrs.fgMode;
      cell.bold = bold;
      cell.dim = dim;
    }

    // Right corner.
    const rightX = startX + width - 1;
    if (rightX >= 0 && rightX < grid.cols) {
      const cell = grid.cells[row][rightX];
      cell.char = rightCorner;
      cell.width = 1;
      cell.fg = borderAttrs.fg;
      cell.fgMode = borderAttrs.fgMode;
      cell.bold = bold;
      cell.dim = dim;
    }

    // Fill interior of the border row with ─, then overlay label if top.
    const innerStart = startX + 1;
    const innerEnd   = startX + width - 1; // exclusive

    for (let c = innerStart; c < innerEnd; c++) {
      if (c < 0 || c >= grid.cols) continue;
      const cell = grid.cells[row][c];
      cell.char = BOX_H;
      cell.width = 1;
      cell.fg = borderAttrs.fg;
      cell.fgMode = borderAttrs.fgMode;
      cell.bold = bold;
      cell.dim = dim;
    }

    // Overlay the label on the top border as ─ label ─, inset one cell from the
    // corner and wrapped in spaces so it reads as a chip rather than running
    // into the border line.
    if (isTop && label.length > 0) {
      const labelStart = innerStart + 2;          // ┌ ─ <space> label
      const maxLabelCols = innerEnd - labelStart - 1; // leave a trailing space
      if (maxLabelCols > 0) {
        // Truncate by display width, appending an ellipsis when it doesn't fit.
        let cols = 0;
        let cutAt = 0;
        for (const ch of label) {
          const w = cellWidth(ch.codePointAt(0) ?? 0);
          if (cols + w > maxLabelCols) break;
          cols += w;
          cutAt++;
        }
        let labelText = label.slice(0, cutAt);
        if (cutAt < label.length && maxLabelCols >= 1) {
          labelText = label.slice(0, Math.max(0, cutAt - 1)) + "…";
          cols = Math.min(cols, maxLabelCols);
        }
        if (labelText.length > 0) {
          // Render ` label ` as one filled chip: the surrounding spaces carry the
          // same background as the label so it reads as a contiguous tab.
          const chipAttrs = labelAttrs ?? { fg: borderAttrs.fg, fgMode: borderAttrs.fgMode };
          writeString(grid, row, innerStart + 1, " ", chipAttrs);
          writeString(grid, row, labelStart, labelText, chipAttrs);
          writeString(grid, row, labelStart + cols, " ", chipAttrs);
        }
      }
    }
  }
}
