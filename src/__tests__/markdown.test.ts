import { describe, test, expect } from "bun:test";
import { renderMarkdownToStyledLines } from "../markdown";
import { ColorMode } from "../types";

describe("renderMarkdownToStyledLines", () => {
  test("empty input returns empty", () => {
    expect(renderMarkdownToStyledLines("", 80)).toEqual([]);
  });

  test("zero width returns empty", () => {
    expect(renderMarkdownToStyledLines("hello", 0)).toEqual([]);
  });

  test("plain paragraph yields the original text", () => {
    const out = renderMarkdownToStyledLines("hello world", 80);
    expect(out.length).toBe(1);
    const text = out[0].map((s) => s.text).join("");
    expect(text).toBe("hello world");
  });

  test("bold inline produces a bold segment", () => {
    const out = renderMarkdownToStyledLines("a **bold** word", 80);
    const segs = out.flat();
    expect(segs.some((s) => s.text === "bold" && s.attrs?.bold === true)).toBe(true);
    expect(segs.some((s) => s.text.startsWith("a") && !s.attrs?.bold)).toBe(true);
  });

  test("italic inline produces an italic segment", () => {
    const out = renderMarkdownToStyledLines("an *italic* word", 80);
    const segs = out.flat();
    expect(segs.some((s) => s.text === "italic" && s.attrs?.italic === true)).toBe(true);
  });

  test("heading text is bold", () => {
    const out = renderMarkdownToStyledLines("# Hello", 80);
    const segs = out.flat();
    expect(segs.some((s) => s.text.includes("Hello") && s.attrs?.bold === true)).toBe(true);
  });

  test("inline code segment exists", () => {
    const out = renderMarkdownToStyledLines("a `snippet` b", 80);
    const segs = out.flat();
    expect(segs.some((s) => s.text === "snippet")).toBe(true);
  });

  test("link renders as text plus url when hyperlinks disabled", () => {
    const out = renderMarkdownToStyledLines("[click](https://example.com)", 80, { hyperlinks: false });
    const text = out.flat().map((s) => s.text).join("");
    expect(text).toContain("click");
    expect(text).toContain("example.com");
  });

  test("baseAttrs fills cells that have default fg/bg", () => {
    const baseAttrs = { bg: 0x161b22, bgMode: ColorMode.RGB, fg: 7, fgMode: ColorMode.Palette };
    const out = renderMarkdownToStyledLines("plain", 80, { baseAttrs });
    const helloSeg = out.flat().find((s) => s.text.includes("plain"));
    expect(helloSeg).toBeDefined();
    // Plain text has no SGR around it, so base bg should fall through.
    expect(helloSeg!.attrs?.bg).toBe(0x161b22);
    expect(helloSeg!.attrs?.bgMode).toBe(ColorMode.RGB);
  });

  test("Bun-set fg overrides baseAttrs fg", () => {
    const baseAttrs = { fg: 7, fgMode: ColorMode.Palette };
    const out = renderMarkdownToStyledLines("# Hi", 80, { baseAttrs });
    const heading = out.flat().find((s) => s.text.includes("Hi"));
    expect(heading).toBeDefined();
    // Bun colors headings; base fg should NOT apply to those cells.
    expect(heading!.attrs?.fg).not.toBe(7);
  });

  test("trims trailing blank lines", () => {
    const out = renderMarkdownToStyledLines("hello\n\n\n", 80);
    expect(out.length).toBeGreaterThan(0);
    const last = out[out.length - 1];
    expect(last.some((s) => s.text.trim() !== "")).toBe(true);
  });

  test("respects width for paragraph wrapping", () => {
    const longLine = "word ".repeat(40).trim();
    const out = renderMarkdownToStyledLines(longLine, 30);
    for (const line of out) {
      const len = line.reduce((acc, s) => acc + s.text.length, 0);
      expect(len).toBeLessThanOrEqual(30);
    }
  });

  test("bullet list renders multiple lines", () => {
    const out = renderMarkdownToStyledLines("- one\n- two\n- three\n", 80);
    const text = out.map((line) => line.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("three");
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  test("image renders as a link with the image url on attrs.link", () => {
    const out = renderMarkdownToStyledLines("![a screenshot](https://example.com/img.png)", 80);
    const segs = out.flat();
    const text = segs.map((s) => s.text).join("");
    expect(text).toContain("a screenshot");
    expect(text).not.toContain("[img]");
    expect(segs.some((s) => s.attrs?.link === "https://example.com/img.png")).toBe(true);
  });

  test("image with empty alt uses url as label and link", () => {
    const out = renderMarkdownToStyledLines("![](https://example.com/img.png)", 80);
    const segs = out.flat();
    const text = segs.map((s) => s.text).join("");
    expect(text).toContain("example.com/img.png");
    expect(segs.some((s) => s.attrs?.link === "https://example.com/img.png")).toBe(true);
  });

  test("image inside a link keeps the outer page url", () => {
    const out = renderMarkdownToStyledLines("[![logo](https://logo.png)](https://example.com)", 80);
    const segs = out.flat();
    expect(segs.some((s) => s.attrs?.link === "https://example.com")).toBe(true);
  });

  test("regular link emits OSC 8 by default and hides url from text", () => {
    const out = renderMarkdownToStyledLines("[click me](https://example.com/foo)", 80);
    const segs = out.flat();
    const text = segs.map((s) => s.text).join("");
    expect(text).toContain("click me");
    expect(text).not.toContain("example.com");
    expect(segs.some((s) => s.attrs?.link === "https://example.com/foo")).toBe(true);
  });

  test("hyperlinks: false falls back to inline text (url) form", () => {
    const out = renderMarkdownToStyledLines("[click me](https://example.com/foo)", 80, { hyperlinks: false });
    const segs = out.flat();
    const text = segs.map((s) => s.text).join("");
    expect(text).toContain("click me");
    expect(text).toContain("example.com/foo");
    expect(segs.every((s) => !s.attrs?.link)).toBe(true);
  });

  test("linkifyImages can be disabled", () => {
    const out = renderMarkdownToStyledLines("![alt](https://example.com/img.png)", 80, { linkifyImages: false });
    const text = out.flat().map((s) => s.text).join("");
    // With linkify off, Bun's own image rendering takes over — the URL is dropped.
    expect(text).not.toContain("example.com/img.png");
    expect(text).toContain("alt");
  });

  test("emits no segments containing raw escape characters", () => {
    const out = renderMarkdownToStyledLines("# Hello\n\n**bold** and *italic* and `code`\n", 80);
    for (const line of out) {
      for (const seg of line) {
        expect(seg.text).not.toContain("\x1b");
      }
    }
  });
});
