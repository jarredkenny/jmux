import { test, expect, describe } from "bun:test";

/**
 * Guards the chrome colour single-source.
 *
 * The chrome visual language resolved three real collisions: two different
 * oranges both meaning "active", a pink that duplicated the accent's job, and a
 * third orange for issue priority. Every one of them arose the same way — a
 * module hand-wrote an RGB literal instead of referencing the shared token — so
 * the guard is against that specific reintroduction, not against colour
 * generally.
 *
 * What is banned in the chrome modules: RGB colour literals, written either as
 * `0xRRGGBB` or shift-composed as `(0xRR << 16) | (0xGG << 8) | 0xBB`. Those
 * belong in `chrome-tokens.ts` (which owns the accent and the derived ramp) or
 * `theme.ts` (which derives surfaces from the terminal background).
 *
 * What is NOT banned: bare ANSI palette indices (`fg: 2`, `fg: 8`). Those are a
 * deliberate part of the design — palette colours respect whatever the user's
 * terminal theme defines, which is why the spec assigns semantics to them
 * (green = affirmative, yellow = attention, red = failure) rather than pinning
 * hexes. Banning them would be a false positive on correct code.
 *
 * Scoped to the chrome modules by construction, so theme derivation, the OSC 11
 * parser, colour transport, cell defaults and test fixtures are out of scope
 * without needing an exception list.
 */

/** The surfaces that composite jmux's own chrome. */
const CHROME_MODULES = [
  "sidebar.ts",
  "renderer.ts",
  "footer.ts",
  "modal.ts",
  "command-palette.ts",
  "input-modal.ts",
  "list-modal.ts",
  "content-modal.ts",
  "new-session-modal.ts",
  "textarea-modal.ts",
  "create-issue-modal.ts",
  "settings-screen.ts",
  "panel-view-renderer.ts",
  "info-panel.ts",
  "glass/view.ts",
  "glass/strip.ts",
];

/** `0xRRGGBB` — a packed RGB colour written directly. */
const PACKED_RGB = /0x[0-9A-Fa-f]{6}\b/;
/** `(0xRR << 16)` — the shift-composed form the original offenders all used. */
const SHIFT_COMPOSED_RGB = /0x[0-9A-Fa-f]{2}\s*<<\s*16/;

async function readModule(rel: string): Promise<string> {
  return Bun.file(new URL(`../${rel}`, import.meta.url).pathname).text();
}

/** Strips line and block comments so a hex named in prose isn't a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("chrome colour single-source", () => {
  test("no chrome module hand-writes an RGB colour literal", async () => {
    const offenders: string[] = [];

    for (const rel of CHROME_MODULES) {
      const source = stripComments(await readModule(rel));
      source.split("\n").forEach((line, i) => {
        if (PACKED_RGB.test(line) || SHIFT_COMPOSED_RGB.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    // A failure here means a colour was hand-written where a chrome-tokens
    // reference belongs — route it through `tokens.*` rather than widening
    // this test.
    expect(offenders).toEqual([]);
  });

  test("the retired collision colours never reappear anywhere in src", async () => {
    // These three are why the spec exists: #FBD4B8 was a second "active"
    // orange competing with the accent, #E8A0B4 a pink doing the accent's job
    // on one button, and #FF8C00 a third orange for issue priority.
    const RETIRED: Array<{ hex: string; was: string }> = [
      { hex: "fbd4b8", was: "the pale peach second accent" },
      { hex: "e8a0b4", was: "the Claude-button pink" },
      { hex: "ff8c00", was: "the priority-2 third orange" },
    ];

    const glob = new Bun.Glob("**/*.ts");
    const srcDir = new URL("..", import.meta.url).pathname;
    const offenders: string[] = [];

    for await (const rel of glob.scan(srcDir)) {
      if (rel.includes("__tests__")) continue;
      const source = stripComments(await Bun.file(`${srcDir}/${rel}`).text());
      const flat = source.replace(/[\s|()]/g, "").toLowerCase();
      for (const { hex, was } of RETIRED) {
        const packed = `0x${hex}`;
        const shifted = `0x${hex.slice(0, 2)}<<16`;
        if (flat.includes(packed) || flat.includes(`${shifted}|0x${hex.slice(2, 4)}<<8|0x${hex.slice(4)}`)) {
          offenders.push(`${rel}: reintroduced ${was} (#${hex})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
