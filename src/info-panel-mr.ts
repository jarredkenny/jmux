import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import type { MergeRequest } from "./adapters/types";

const TITLE_ATTRS: CellAttrs = { fg: (0x58 << 16) | (0xA6 << 8) | 0xFF, fgMode: ColorMode.RGB, bold: true };
const LABEL_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const VALUE_ATTRS: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB };
const ACTION_KEY: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const ACTION_LABEL: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const ERROR_ATTRS: CellAttrs = { fg: 1, fgMode: ColorMode.Palette };
const EMPTY_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };

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
  mr: MergeRequest | null,
  cols: number,
  rows: number,
  error?: string,
): CellGrid {
  const grid = createGrid(cols, rows);
  const pad = 2;

  if (error) {
    writeString(grid, 2, pad, error, ERROR_ATTRS);
    return grid;
  }

  if (!mr) {
    writeString(grid, 2, pad, "No merge request found for this branch.", EMPTY_ATTRS);
    writeString(grid, 4, pad, "Push a branch and open an MR to see status here.", EMPTY_ATTRS);
    return grid;
  }

  let row = 1;

  // Title
  const titleStr = mr.title.length > cols - pad * 2 ? mr.title.slice(0, cols - pad * 2 - 1) + "…" : mr.title;
  writeString(grid, row, pad, titleStr, TITLE_ATTRS);
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

  // Actions
  writeString(grid, row, pad, "Actions", LABEL_ATTRS);
  row += 1;
  let col = pad;
  const open = "[o]";
  const openLabel = " Open  ";
  writeString(grid, row, col, open, ACTION_KEY);
  col += open.length;
  writeString(grid, row, col, openLabel, ACTION_LABEL);
  col += openLabel.length;
  if (mr.status === "draft") {
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
