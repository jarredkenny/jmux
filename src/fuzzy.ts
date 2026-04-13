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

export function truncateLabel(label: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (label.length <= maxLen) return label;
  if (maxLen <= 1) return "…";
  return label.slice(0, maxLen - 1) + "…";
}
