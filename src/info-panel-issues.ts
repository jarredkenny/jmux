import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import type { Issue, LinkSource } from "./adapters/types";

type TaggedIssue = Issue & { source: LinkSource };

const IDENT_ATTRS: CellAttrs = { fg: 5, fgMode: ColorMode.Palette, bold: true };
const TITLE_ATTRS: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB, bold: true };
const LABEL_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const VALUE_ATTRS: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB };
const ACTION_KEY: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const ACTION_LABEL: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const ERROR_ATTRS: CellAttrs = { fg: 1, fgMode: ColorMode.Palette };
const EMPTY_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const URL_ATTRS: CellAttrs = { fg: (0x58 << 16) | (0xA6 << 8) | 0xFF, fgMode: ColorMode.RGB, dim: true };
const DIM_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const CURSOR_ATTRS: CellAttrs = { fg: 5, fgMode: ColorMode.Palette };
const SEP_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };

export function renderIssuesTab(
  issues: TaggedIssue[],
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

  if (issues.length === 0) {
    writeString(grid, 2, pad, "No linked issue found.", EMPTY_ATTRS);
    writeString(grid, 4, pad, "Link an issue to your MR or use a branch", EMPTY_ATTRS);
    writeString(grid, 5, pad, "name like eng-1234-description.", EMPTY_ATTRS);
    return grid;
  }

  let row = 1;

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const isSelected = i === selectedIndex;

    // Separator between issues
    if (i > 0) {
      const sepLine = "─".repeat(Math.max(0, cols - pad * 2));
      writeString(grid, row, pad, sepLine, SEP_ATTRS);
      row += 1;
    }

    // Identifier with optional selection cursor
    let col = pad;
    const cursor = "▸ ";
    if (isSelected) {
      writeString(grid, row, col, cursor, CURSOR_ATTRS);
      col += cursor.length;
    }
    writeString(grid, row, col, issue.identifier, IDENT_ATTRS);
    col += issue.identifier.length;
    if (issue.source !== "manual") {
      writeString(grid, row, col, " (auto)", DIM_ATTRS);
    }
    row += 1;

    // Title
    const titleMaxLen = cols - pad * 2;
    const titleStr = issue.title.length > titleMaxLen
      ? issue.title.slice(0, titleMaxLen - 1) + "…" : issue.title;
    writeString(grid, row, pad, titleStr, TITLE_ATTRS);
    row += 2;

    // Status
    writeString(grid, row, pad, "Status", LABEL_ATTRS);
    row += 1;
    writeString(grid, row, pad, issue.status, VALUE_ATTRS);
    row += 2;

    // Assignee
    writeString(grid, row, pad, "Assignee", LABEL_ATTRS);
    row += 1;
    writeString(grid, row, pad, issue.assignee ?? "Unassigned", issue.assignee ? VALUE_ATTRS : EMPTY_ATTRS);
    row += 2;

    // Linked MRs
    if (issue.linkedMrUrls.length > 0) {
      writeString(grid, row, pad, "Linked MRs", LABEL_ATTRS);
      row += 1;
      for (const url of issue.linkedMrUrls) {
        const display = url.length > cols - pad * 2 ? url.slice(0, cols - pad * 2 - 1) + "…" : url;
        writeString(grid, row, pad, display, URL_ATTRS);
        row += 1;
      }
      row += 1;
    }
  }

  // Actions — shown once at the bottom
  writeString(grid, row, pad, "Actions", LABEL_ATTRS);
  row += 1;
  let col = pad;
  writeString(grid, row, col, "[o]", ACTION_KEY);
  col += "[o]".length;
  writeString(grid, row, col, " Open  ", ACTION_LABEL);
  col += " Open  ".length;
  writeString(grid, row, col, "[s]", ACTION_KEY);
  col += "[s]".length;
  writeString(grid, row, col, " Status", ACTION_LABEL);

  return grid;
}
