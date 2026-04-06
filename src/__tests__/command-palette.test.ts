import { describe, test, expect } from "bun:test";
import { fuzzyMatch, type FuzzyResult } from "../command-palette";

describe("fuzzyMatch", () => {
  test("matches exact substring", () => {
    const result = fuzzyMatch("split", "Split horizontal");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([0, 1, 2, 3, 4]);
  });

  test("matches characters in order across word boundaries", () => {
    const result = fuzzyMatch("nw", "New window");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([0, 2]);
  });

  test("is case-insensitive", () => {
    const result = fuzzyMatch("SPLIT", "Split horizontal");
    expect(result).not.toBeNull();
  });

  test("returns null when characters are not in order", () => {
    const result = fuzzyMatch("zx", "Split horizontal");
    expect(result).toBeNull();
  });

  test("returns null for empty label", () => {
    const result = fuzzyMatch("a", "");
    expect(result).toBeNull();
  });

  test("matches everything for empty query", () => {
    const result = fuzzyMatch("", "Split horizontal");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([]);
    expect(result!.score).toBe(0);
  });

  test("consecutive matches score higher than spread matches", () => {
    const consecutive = fuzzyMatch("sp", "Split horizontal");
    const spread = fuzzyMatch("sp", "Session: project");
    expect(consecutive).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(consecutive!.score).toBeGreaterThan(spread!.score);
  });

  test("word boundary match scores higher", () => {
    const boundary = fuzzyMatch("sh", "Split horizontal");
    const mid = fuzzyMatch("sh", "pushed");
    expect(boundary).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(boundary!.score).toBeGreaterThan(mid!.score);
  });
});
