import type { PaletteCommand, PaletteSublistOption, PaletteResult, PaletteAction } from "./types";
import type { CellGrid } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import { ColorMode } from "./types";

export interface FuzzyResult {
  score: number;
  indices: number[];
}

export function fuzzyMatch(query: string, label: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, indices: [] };
  if (label.length === 0) return null;

  const lowerQuery = query.toLowerCase();
  const lowerLabel = label.toLowerCase();
  const indices: number[] = [];
  let qi = 0;

  for (let li = 0; li < lowerLabel.length && qi < lowerQuery.length; li++) {
    if (lowerLabel[li] === lowerQuery[qi]) {
      indices.push(li);
      qi++;
    }
  }

  if (qi < lowerQuery.length) return null;

  let score = 0;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) score += 10;
  }
  for (const idx of indices) {
    if (idx === 0 || label[idx - 1] === " " || label[idx - 1] === "-" || label[idx - 1] === "_") {
      score += 6;
    }
  }

  return { score, indices };
}
