import { describe, test, expect } from "bun:test";
import { buildFooter, layoutFooter, type FooterModel } from "../footer";
import { tokens } from "../chrome-tokens";

// Reconstructs the plain-text line a `cells` array would paint — every glyph
// used in the footer's left dialect and version/chip text is display-width 1
// (arrows, carets, box-drawing, ASCII), so string index === column here.
function flatten(cells: { text: string }[]): string {
  return cells.map((c) => c.text).join("");
}

describe("buildFooter", () => {
  test("right side is just the version segment when there's no snapshot chip", () => {
    const model = buildFooter({ snapshotChip: null, version: "1.2.3", updateAvailable: null });
    expect(model.right).toEqual([{ label: "v1.2.3", onClick: "changelog", urgent: false }]);
  });

  test("right side puts the snapshot chip before the version segment", () => {
    const model = buildFooter({ snapshotChip: "snapshot stale", version: "1.2.3", updateAvailable: null });
    expect(model.right).toEqual([
      { label: "snapshot stale" },
      { label: "v1.2.3", onClick: "changelog", urgent: false },
    ]);
  });

  test("the version segment renders the update-available text when present", () => {
    const model = buildFooter({ snapshotChip: null, version: "1.2.3", updateAvailable: "v1.3.0 avail" });
    expect(model.right).toEqual([{ label: "v1.3.0 avail", onClick: "changelog", urgent: true }]);
  });

  test("left side is the fixed keybind hint set, in priority order", () => {
    const model = buildFooter({ snapshotChip: null, version: "1.2.3", updateAvailable: null });
    expect(model.left).toEqual([
      { key: "↵", label: "open" },
      { key: "^a p", label: "palette" },
      { key: "^a n", label: "new" },
      { key: "?", label: "keys" },
    ]);
  });
});

describe("layoutFooter — left dialect colours", () => {
  const model = buildFooter({ snapshotChip: null, version: "1.2.3", updateAvailable: null });
  const { cells } = layoutFooter(model, 80);

  test("a left segment's key renders in accentMuted", () => {
    const seg = cells.find((c) => c.text === "↵");
    expect(seg).toBeDefined();
    expect(seg!.attrs?.fg).toBe(tokens.accentMuted.fg);
    expect(seg!.attrs?.fgMode).toBe(tokens.accentMuted.fgMode);
  });

  test("a left segment's label renders in textSecondary", () => {
    const seg = cells.find((c) => c.text === "open");
    expect(seg).toBeDefined();
    expect(seg!.attrs?.fg).toBe(tokens.textSecondary.fg);
    expect(seg!.attrs?.fgMode).toBe(tokens.textSecondary.fgMode);
  });

  test("the · separator renders in ruleHairline", () => {
    const seg = cells.find((c) => c.text === "·");
    expect(seg).toBeDefined();
    expect(seg!.attrs?.fg).toBe(tokens.ruleHairline.fg);
    expect(seg!.attrs?.fgMode).toBe(tokens.ruleHairline.fgMode);
    expect(seg!.attrs?.dim).toBe(tokens.ruleHairline.dim);
  });

  test("multiple left segments and separators actually appear, in order", () => {
    const flat = flatten(cells);
    expect(flat).toContain("↵ open");
    expect(flat.indexOf("↵ open")).toBeLessThan(flat.indexOf("^a p palette"));
  });
});

describe("layoutFooter — right side never truncates", () => {
  test("both the snapshot chip and the version segment survive at a very narrow width", () => {
    const model = buildFooter({ snapshotChip: "snapshot stale", version: "1.2.3", updateAvailable: null });
    const { cells } = layoutFooter(model, 20);
    const flat = flatten(cells);
    expect(flat).toContain("snapshot stale");
    expect(flat).toContain("v1.2.3");
  });

  test("the right side survives even when it alone exceeds the available width", () => {
    const model = buildFooter({ snapshotChip: "snapshot: other jmux", version: "1.2.3", updateAvailable: null });
    const { cells } = layoutFooter(model, 10);
    const flat = flatten(cells);
    expect(flat).toContain("snapshot: other jmux");
    expect(flat).toContain("v1.2.3");
  });

  test("left segments are entirely dropped before the right side ever shrinks", () => {
    const model = buildFooter({ snapshotChip: "snapshot stale", version: "1.2.3", updateAvailable: null });
    const { cells } = layoutFooter(model, 30);
    const flat = flatten(cells);
    // Right content is fully intact...
    expect(flat).toContain("snapshot stale");
    expect(flat).toContain("v1.2.3");
    // ...even though there isn't room for all four left hints.
    expect(flat).not.toContain("? keys");
  });
});

describe("layoutFooter — left drops whole segments, lowest priority first", () => {
  test("at a width that only fits two hints, '? keys' and '^a n new' are dropped first", () => {
    const model: FooterModel = {
      left: [
        { key: "↵", label: "open" },
        { key: "^a p", label: "palette" },
        { key: "^a n", label: "new" },
        { key: "?", label: "keys" },
      ],
      right: [{ label: "v1.2.3", onClick: "changelog" }],
    };
    // "↵ open" (6) + " · " (3) + "^a p palette" (12) = 21 cols, plus a
    // reserved blank + "v1.2.3" (6) on the right — pick a width that fits
    // exactly the first two hints and nothing more.
    const { cells } = layoutFooter(model, 30);
    const flat = flatten(cells);
    expect(flat).toContain("↵ open");
    expect(flat).toContain("^a p palette");
    expect(flat).not.toContain("^a n new");
    expect(flat).not.toContain("? keys");
  });

  test("never renders a partial segment — a segment is either whole or absent", () => {
    const model: FooterModel = {
      left: [
        { key: "↵", label: "open" },
        { key: "^a p", label: "palette" },
      ],
      right: [{ label: "v1.2.3", onClick: "changelog" }],
    };
    // Just short of fitting "^a p palette" whole.
    const { cells } = layoutFooter(model, 20);
    const flat = flatten(cells);
    expect(flat).toContain("↵ open");
    expect(flat).not.toContain("^a p");
    expect(flat).not.toContain("palette");
  });

  test("at least two left segments survive at 80 cols", () => {
    const model = buildFooter({ snapshotChip: "snapshot stale", version: "1.2.3", updateAvailable: null });
    const { cells } = layoutFooter(model, 80);
    const flat = flatten(cells);
    let survivors = 0;
    for (const hint of ["↵ open", "^a p palette", "^a n new", "? keys"]) {
      if (flat.includes(hint)) survivors++;
    }
    expect(survivors).toBeGreaterThanOrEqual(2);
  });
});

describe("layoutFooter — version click range", () => {
  test("the version segment's range carries onClick: changelog and spans its own text", () => {
    const model = buildFooter({ snapshotChip: "snapshot stale", version: "1.2.3", updateAvailable: null });
    const cols = 80;
    const { cells, ranges } = layoutFooter(model, cols);
    const flat = flatten(cells);

    const changelogRanges = ranges.filter((r) => r.onClick === "changelog");
    expect(changelogRanges.length).toBe(1);
    const range = changelogRanges[0];
    expect(flat.slice(range.startCol, range.endCol + 1)).toBe("v1.2.3");
  });

  test("only the version segment gets a click range — the snapshot chip has none", () => {
    const model = buildFooter({ snapshotChip: "snapshot stale", version: "1.2.3", updateAvailable: null });
    const { ranges } = layoutFooter(model, 80);
    expect(ranges.length).toBe(1);
  });

  test("the update-available text is what carries the changelog range when present", () => {
    const model = buildFooter({ snapshotChip: null, version: "1.2.3", updateAvailable: "v1.3.0 avail" });
    const cols = 80;
    const { cells, ranges } = layoutFooter(model, cols);
    const flat = flatten(cells);
    const range = ranges.find((r) => r.onClick === "changelog")!;
    expect(flat.slice(range.startCol, range.endCol + 1)).toBe("v1.3.0 avail");
  });
});

describe("layoutFooter — fills exactly `cols` columns", () => {
  test("the flattened line's display width equals cols", () => {
    const model = buildFooter({ snapshotChip: "snapshot stale", version: "1.2.3", updateAvailable: null });
    const cols = 80;
    const { cells } = layoutFooter(model, cols);
    expect(flatten(cells).length).toBe(cols);
  });
});

describe("layoutFooter — version segment urgency colour", () => {
  test("when updateAvailable is null, the version segment renders in accentMuted", () => {
    const model = buildFooter({ snapshotChip: null, version: "1.2.3", updateAvailable: null });
    const { cells } = layoutFooter(model, 80);
    const flat = flatten(cells);
    const versionText = "v1.2.3";
    const versionIdx = flat.indexOf(versionText);
    expect(versionIdx).toBeGreaterThanOrEqual(0);
    // The version segment's text cell is in the cells array; find it
    const versionCell = cells.find((c) => c.text === versionText);
    expect(versionCell).toBeDefined();
    expect(versionCell!.attrs?.fg).toBe(tokens.accentMuted.fg);
    expect(versionCell!.attrs?.fgMode).toBe(tokens.accentMuted.fgMode);
  });

  test("when updateAvailable is non-null, the version segment renders in attention", () => {
    const model = buildFooter({ snapshotChip: null, version: "1.2.3", updateAvailable: "v1.3.0 avail" });
    const { cells } = layoutFooter(model, 80);
    const flat = flatten(cells);
    const versionText = "v1.3.0 avail";
    const versionIdx = flat.indexOf(versionText);
    expect(versionIdx).toBeGreaterThanOrEqual(0);
    // Find the cell with the update-available text
    const versionCell = cells.find((c) => c.text === versionText);
    expect(versionCell).toBeDefined();
    expect(versionCell!.attrs?.fg).toBe(tokens.attention.fg);
    expect(versionCell!.attrs?.fgMode).toBe(tokens.attention.fgMode);
  });
});
