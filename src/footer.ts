// Pure model + layout for jmux's persistent footer row — mirrors the
// band-layout/packChips discipline (see band-layout.ts): geometry and
// styling are computed once here, and painting (renderer.ts) just replays
// the `cells` this returns via writeStyledLine. No rendering, no I/O.
//
// The footer has two zones:
//   left  — a small fixed set of context keybind hints, in display-priority
//           order (front = keep longest, back = drop first when narrow).
//   right — ambient status: the snapshot health chip (when present) and the
//           version indicator (moved here from the sidebar's last row).
//
// The right zone is laid out first and never truncates — losing ambient
// status silently would be worse than losing a keybind hint. The left zone
// is packed left-to-right into whatever room remains and drops whole
// segments (never a partial one) starting from the back, exactly like
// `packChips`'s "align: left" contiguous-prefix packing already does.

import { textCols, type StyledSegment, type CellAttrs } from "./cell-grid";
import { packChips } from "./band-layout";
import { tokens } from "./chrome-tokens";

export interface FooterSegment {
  key?: string;
  label: string;
  onClick?: "changelog";
}

export interface FooterModel {
  left: FooterSegment[];
  right: FooterSegment[];
}

export interface FooterClickRange {
  startCol: number;
  endCol: number;
  onClick: "changelog";
}

export interface FooterLayout {
  cells: StyledSegment[];
  ranges: FooterClickRange[];
}

/** The fixed set of left-side keybind hints, in priority order (highest
 * priority — kept longest — first). `? keys` is a display-only label: it
 * documents the help overlay's key but doesn't wire a click/keybind here,
 * exactly like the toolbar's own hint conventions. */
const LEFT_KEYBINDS: readonly FooterSegment[] = [
  { key: "↵", label: "open" },       // ↵ open
  { key: "^a p", label: "palette" },
  { key: "^a n", label: "new" },
  { key: "?", label: "keys" },
];

/** Separator glyph between adjacent segments, drawn as " · " — the dot in
 * `tokens.ruleHairline`, the flanking spaces uncoloured. */
const SEP_GLYPH = "·"; // ·
const SEP_WIDTH = 3; // " · "

export function buildFooter(state: {
  snapshotChip: string | null;
  version: string;
  updateAvailable: string | null;
}): FooterModel {
  const right: FooterSegment[] = [];
  if (state.snapshotChip) {
    right.push({ label: state.snapshotChip });
  }
  right.push({
    label: state.updateAvailable ?? `v${state.version}`,
    onClick: "changelog",
  });
  return { left: LEFT_KEYBINDS.slice(), right };
}

function segmentWidth(seg: FooterSegment): number {
  const keyWidth = seg.key ? textCols(seg.key) + 1 : 0;
  return keyWidth + textCols(seg.label);
}

export function layoutFooter(model: FooterModel, cols: number): FooterLayout {
  // Right side first, anchored to the terminal's right edge — budget of
  // -Infinity means packChips can never drop a chip here, so the right
  // zone is never truncated regardless of how little room is left.
  const rightItems = model.right.map((seg, i) => ({ id: String(i), width: segmentWidth(seg) }));
  const rightChips = packChips(rightItems, {
    start: cols,
    budget: -Infinity,
    align: "right",
    sepWidth: SEP_WIDTH,
  });
  const rightStart = rightChips.length > 0 ? rightChips[0].x : cols;

  // Left side packs into what's left of the right zone (with at least one
  // blank column of separation when the right zone is non-empty). packChips'
  // "align: left" packing keeps a contiguous prefix and drops the rest whole
  // the moment a chip would overflow — since LEFT_KEYBINDS is already
  // ordered highest-priority-first, that's exactly "drop lowest-priority
  // first, never a partial segment".
  const leftBudget = rightChips.length > 0 ? Math.max(0, rightStart - 1) : cols;
  const leftItems = model.left.map((seg, i) => ({ id: String(i), width: segmentWidth(seg) }));
  const leftChips = packChips(leftItems, { start: 0, budget: leftBudget, align: "left", sepWidth: SEP_WIDTH });

  const cells: StyledSegment[] = [];
  const ranges: FooterClickRange[] = [];
  let cursor = 0;

  const keyAttrs: CellAttrs = tokens.accentMuted;
  const labelAttrs: CellAttrs = tokens.textSecondary;
  // Right-side segments that carry a click affordance render in the same
  // accentMuted tone as a left-side key — it's the one generic signal
  // `FooterSegment` gives us for "this is actionable".
  const clickableLabelAttrs: CellAttrs = tokens.accentMuted;
  const sepDotAttrs: CellAttrs = tokens.ruleHairline;

  const pushSegment = (seg: FooterSegment): void => {
    const start = cursor;
    if (seg.key) {
      cells.push({ text: seg.key, attrs: keyAttrs });
      cursor += textCols(seg.key);
      cells.push({ text: " ", attrs: labelAttrs });
      cursor += 1;
    }
    cells.push({ text: seg.label, attrs: seg.onClick ? clickableLabelAttrs : labelAttrs });
    cursor += textCols(seg.label);
    if (seg.onClick) {
      ranges.push({ startCol: start, endCol: cursor - 1, onClick: seg.onClick });
    }
  };

  const pushSeparator = (): void => {
    cells.push({ text: " ", attrs: labelAttrs });
    cells.push({ text: SEP_GLYPH, attrs: sepDotAttrs });
    cells.push({ text: " ", attrs: labelAttrs });
    cursor += SEP_WIDTH;
  };

  for (let i = 0; i < leftChips.length; i++) {
    pushSegment(model.left[Number(leftChips[i].id)]);
    if (i < leftChips.length - 1) pushSeparator();
  }

  if (cursor < rightStart) {
    cells.push({ text: " ".repeat(rightStart - cursor) });
    cursor = rightStart;
  }

  for (let i = 0; i < model.right.length; i++) {
    pushSegment(model.right[i]);
    if (i < model.right.length - 1) pushSeparator();
  }

  return { cells, ranges };
}
