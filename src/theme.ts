// Theme detection + derivation.
//
// jmux composites its own chrome (modals, sidebar) on top of tmux. Historically
// the surface colors were hardcoded to a GitHub-dark palette, which clashes with
// any terminal whose theme isn't near-black blue-grey (warmer darks, pure black,
// or light themes). This module derives those surfaces from the terminal's actual
// background, queried once at startup via OSC 11.
//
// Consumers (modal.ts, sidebar.ts, renderer.ts) read the mutable `theme` object
// at render time. Until a background is detected — or if the terminal never
// answers the OSC 11 query — `theme` holds DEFAULT_THEME, which reproduces the
// original hardcoded look exactly, so non-responding terminals are unaffected.

import { ColorMode } from "./types";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function pack(c: RGB): number {
  return ((c.r & 0xff) << 16) | ((c.g & 0xff) << 8) | (c.b & 0xff);
}

export function unpack(p: number): RGB {
  return { r: (p >> 16) & 0xff, g: (p >> 8) & 0xff, b: p & 0xff };
}

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Linear blend from `a` to `b`, `t` in [0,1]. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: clampChannel(a.r + (b.r - a.r) * t),
    g: clampChannel(a.g + (b.g - a.g) * t),
    b: clampChannel(a.b + (b.b - a.b) * t),
  };
}

/** Rec. 709 relative luminance, 0–255. */
export function luminance(c: RGB): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

export function isDark(c: RGB): boolean {
  return luminance(c) < 128;
}

export interface ThemeColors {
  /** Modal / panel background (packed 0xRRGGBB). */
  surface: number;
  /** Selected-row / active background. */
  selected: number;
  /** Hover background. */
  hover: number;
  /** Drop-shadow background. */
  shadow: number;
  /**
   * When true, neutral chrome text (primary white + secondary gray) uses the
   * terminal's own default foreground (ColorMode.Default) instead of palette
   * indices 7/8. Required for readability on light themes, where palette white
   * would vanish against a derived light surface. Accent colors stay palette.
   */
  useDefaultFg: boolean;
  /** True when the detected background is light (drives accentFor darkening). */
  isLight: boolean;
  /** Active pane's default foreground (tmux window-active-style) — high contrast. */
  paneActiveFg: number;
  /** Inactive pane's default foreground (tmux window-style) — faded. */
  paneInactiveFg: number;
}

/** The original hardcoded look — used until/unless OSC 11 detection succeeds. */
export const DEFAULT_THEME: ThemeColors = {
  surface: 0x161b22,
  selected: 0x1e2a35,
  hover: 0x1a1f26,
  shadow: 0x06080c,
  useDefaultFg: false,
  isLight: false,
  paneActiveFg: 0xb5bcc9,
  paneInactiveFg: 0x6b7280,
};

/**
 * Derive surfaces from a detected terminal background. The modal surface *is*
 * the terminal background, so chrome blends into the theme; selection and hover
 * are tinted toward the contrast anchor (white on dark themes, black on light),
 * and the shadow is a darkening regardless of theme.
 */
export function deriveTheme(termBg: RGB): ThemeColors {
  const dark = isDark(termBg);
  const anchor: RGB = dark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  const black: RGB = { r: 0, g: 0, b: 0 };
  return {
    surface: pack(termBg),
    selected: pack(mix(termBg, anchor, dark ? 0.11 : 0.1)),
    hover: pack(mix(termBg, anchor, 0.05)),
    shadow: pack(mix(termBg, black, dark ? 0.55 : 0.22)),
    useDefaultFg: true,
    isLight: !dark,
    // Pane fade: the active pane's default fg is a strong contrast against the
    // background (light on dark themes, dark on light themes); the inactive pane
    // is a mid-tone that recedes. Deriving both from the anchor keeps the active
    // pane the *more* legible one on any theme — the previous hardcoded light-gray
    // active fg washed out on light backgrounds, inverting the focus cue.
    paneActiveFg: pack(mix(termBg, anchor, 0.7)),
    paneInactiveFg: pack(mix(termBg, anchor, 0.38)),
  };
}

/**
 * Adapt a brand accent color (peach, blue, orange, …) to the current theme.
 * On dark themes the accent is used as designed. On light themes it is darkened
 * (blended toward black), preserving hue but restoring contrast — a color tuned
 * to glow on a dark background would otherwise wash out on a light one.
 */
export function accentFor(rgb: number): number {
  if (!theme.isLight) return rgb;
  return pack(mix(unpack(rgb), { r: 0, g: 0, b: 0 }, 0.45));
}

/** Format a packed color as a `#rrggbb` string for tmux style options. */
export function toHex(packed: number): string {
  return "#" + (packed & 0xffffff).toString(16).padStart(6, "0");
}

/** Live theme — consumers read these fields at render time. Mutated in place. */
export const theme: ThemeColors = { ...DEFAULT_THEME };

export function setTheme(t: ThemeColors): void {
  Object.assign(theme, t);
}

/**
 * Foreground attrs for a chrome text role under the current theme. `accent`
 * palette colors (green, yellow, …) are theme-independent and always pass
 * through; `neutral` roles (white text, gray text) collapse to the terminal's
 * default foreground once a real background is known.
 */
export function neutralFg(palette: number): { fg: number; fgMode: ColorMode } {
  return theme.useDefaultFg
    ? { fg: 0, fgMode: ColorMode.Default }
    : { fg: palette, fgMode: ColorMode.Palette };
}

/**
 * Parse an OSC 11 background-color response. Terminals reply with
 * `ESC ] 11 ; rgb:RRRR/GGGG/BBBB (BEL | ESC \)`, where each channel is 1–4 hex
 * digits (commonly 4, sometimes 2). The `rgba:` variant carries a trailing
 * alpha channel we ignore. Returns null if no recognizable response is present.
 */
export function parseOsc11(data: string): RGB | null {
  const m = data.match(
    /\x1b\]11;rgba?:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/,
  );
  if (!m) return null;
  const scale = (hex: string): number => {
    const max = Math.pow(16, hex.length) - 1;
    return Math.round((parseInt(hex, 16) / max) * 255);
  };
  return { r: scale(m[1]!), g: scale(m[2]!), b: scale(m[3]!) };
}

/** OSC 11 query: ask the terminal for its current background color. */
export const OSC11_QUERY = "\x1b]11;?\x07";

/**
 * Match an OSC 11 response (BEL- or ST-terminated) anywhere in a stream chunk,
 * so the input handler can peel it off before forwarding the rest to tmux.
 */
export const OSC11_RESPONSE_RE =
  /\x1b\]11;rgba?:[0-9a-fA-F]+\/[0-9a-fA-F]+\/[0-9a-fA-F]+(?:\x07|\x1b\\)/;

/** Prefix that begins an OSC 11 response — used to detect a split reply. */
const OSC11_START = "\x1b]11;";

export interface Osc11Scan {
  /** The detected background, if a full reply completed in this chunk. */
  rgb: RGB | null;
  /**
   * Bytes to forward downstream (to tmux), with any reply removed — or null to
   * swallow this chunk entirely while waiting for the rest of a split reply.
   */
  forward: string | null;
  /** Carry-over buffer to pass back in as `pending` on the next chunk. */
  pending: string;
}

/**
 * Scan a stdin chunk for an OSC 11 background reply, tolerating a reply that
 * splits across reads (the terminal may flush the query response in pieces).
 * Stateless: the caller threads `pending` between calls. When a started reply
 * lacks its terminator the chunk is held (forward=null) until the next call,
 * bounded so a terminal that never terminates it can't swallow real input.
 */
export function scanForOsc11(pending: string, chunk: string): Osc11Scan {
  const combined = pending + chunk;
  const m = combined.match(OSC11_RESPONSE_RE);
  if (m) {
    return {
      rgb: parseOsc11(m[0]),
      forward: combined.slice(0, m.index) + combined.slice(m.index! + m[0].length),
      pending: "",
    };
  }
  if (combined.includes(OSC11_START) && combined.length < 128) {
    return { rgb: null, forward: null, pending: combined };
  }
  return { rgb: null, forward: combined, pending: "" };
}
