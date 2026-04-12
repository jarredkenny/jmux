import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import type { MergeRequest, LinkSource } from "./adapters/types";

type TaggedMr = MergeRequest & { source: LinkSource };

const TITLE_ATTRS: CellAttrs = { fg: (0x58 << 16) | (0xA6 << 8) | 0xFF, fgMode: ColorMode.RGB, bold: true };
const LABEL_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const VALUE_ATTRS: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB };
const ACTION_KEY: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const ACTION_LABEL: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const ERROR_ATTRS: CellAttrs = { fg: 1, fgMode: ColorMode.Palette };
const EMPTY_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const DIM_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const CURSOR_ATTRS: CellAttrs = { fg: (0x58 << 16) | (0xA6 << 8) | 0xFF, fgMode: ColorMode.RGB };
const SEP_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };

const STATUS_COLORS: Record<string, CellAttrs> = {
  open: { fg: 2, fgMode: ColorMode.Palette },
  draft: { fg: 3, fgMode: ColorMode.Palette },
  merged: { fg: 5, fgMode: ColorMode.Palette },
  closed: { fg: 1, fgMode: ColorMode.Palette },
};

const PIPELINE_COLORS: Record<string, CellAttrs> = {
  passed: { fg: 2, fgMode: ColorMode.Palette },
  running: { fg: 3, fgMode: ColorMode.Palette },
  failed: { fg: 1, fgMode: ColorMode.Palette },
  pending: { fg: 3, fgMode: ColorMode.Palette },
  canceled: { fg: 8, fgMode: ColorMode.Palette, dim: true },
};

const PIPELINE_GLYPHS: Record<string, string> = {
  passed: "✓", running: "⟳", failed: "✗", pending: "○", canceled: "—",
};

export function renderMrTab(
  mrs: TaggedMr[],
  cols: number,
  rows: number,
  selectedIndex: number,
  error?: string,
): CellGrid {
  const grid = createGrid(cols, rows);
  const pad = 2;

  if (error) {
    writeString(grid, 2, pad, error, ERROR_ATTRS);
    return grid;
  }

  if (mrs.length === 0) {
    writeString(grid, 2, pad, "No merge requests found for this session.", EMPTY_ATTRS);
    writeString(grid, 4, pad, "Push a branch and open an MR to see status here.", EMPTY_ATTRS);
    return grid;
  }

  let row = 1;

  for (let i = 0; i < mrs.length; i++) {
    const mr = mrs[i];
    const isSelected = i === selectedIndex;

    // Separator between MRs
    if (i > 0) {
      const sepLine = "─".repeat(Math.max(0, cols - pad * 2));
      writeString(grid, row, pad, sepLine, SEP_ATTRS);
      row += 1;
    }

    // Title with optional selection cursor and auto badge
    let col = pad;
    const cursor = "▸ ";
    if (isSelected) {
      writeString(grid, row, col, cursor, CURSOR_ATTRS);
      col += cursor.length;
    }
    const titleMaxLen = cols - col - (mr.source !== "manual" ? " (auto)".length : 0) - 1;
    const titleStr = mr.title.length > titleMaxLen ? mr.title.slice(0, titleMaxLen - 1) + "…" : mr.title;
    writeString(grid, row, col, titleStr, TITLE_ATTRS);
    col += titleStr.length;
    if (mr.source !== "manual") {
      writeString(grid, row, col, " (auto)", DIM_ATTRS);
    }
    row += 1;

    // Status
    const statusLabel = mr.status.charAt(0).toUpperCase() + mr.status.slice(1);
    const statusAttrs = STATUS_COLORS[mr.status] ?? VALUE_ATTRS;
    writeString(grid, row, pad, statusLabel, statusAttrs);
    row += 2;

    // Branches
    writeString(grid, row, pad, "Branch", LABEL_ATTRS);
    row += 1;
    writeString(grid, row, pad, `${mr.sourceBranch} → ${mr.targetBranch}`, VALUE_ATTRS);
    row += 2;

    // Pipeline
    if (mr.pipeline) {
      writeString(grid, row, pad, "Pipeline", LABEL_ATTRS);
      row += 1;
      const glyph = PIPELINE_GLYPHS[mr.pipeline.state] ?? "?";
      const pipeAttrs = PIPELINE_COLORS[mr.pipeline.state] ?? VALUE_ATTRS;
      writeString(grid, row, pad, `${glyph} ${mr.pipeline.state}`, pipeAttrs);
      row += 2;
    }

    // Approvals
    writeString(grid, row, pad, "Approvals", LABEL_ATTRS);
    row += 1;
    const approvalStr = `${mr.approvals.current}/${mr.approvals.required}`;
    const approvalAttrs = mr.approvals.current >= mr.approvals.required
      ? { fg: 2, fgMode: ColorMode.Palette } as CellAttrs : VALUE_ATTRS;
    writeString(grid, row, pad, approvalStr, approvalAttrs);
    row += 2;
  }

  // Actions — shown once at the bottom
  const selectedMr = mrs[selectedIndex] ?? mrs[0];
  writeString(grid, row, pad, "Actions", LABEL_ATTRS);
  row += 1;
  let col = pad;
  const open = "[o]";
  const openLabel = " Open  ";
  writeString(grid, row, col, open, ACTION_KEY);
  col += open.length;
  writeString(grid, row, col, openLabel, ACTION_LABEL);
  col += openLabel.length;
  if (selectedMr.status === "draft") {
    const ready = "[r]";
    const readyLabel = " Ready  ";
    writeString(grid, row, col, ready, ACTION_KEY);
    col += ready.length;
    writeString(grid, row, col, readyLabel, ACTION_LABEL);
    col += readyLabel.length;
  }
  const approve = "[a]";
  const approveLabel = " Approve";
  writeString(grid, row, col, approve, ACTION_KEY);
  col += approve.length;
  writeString(grid, row, col, approveLabel, ACTION_LABEL);

  return grid;
}
