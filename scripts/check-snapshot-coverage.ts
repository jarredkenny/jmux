#!/usr/bin/env bun
// Parses `bun test --coverage` output and fails if any `src/snapshot/**` file
// or `src/agent-state.ts` drops below 95% line coverage.
// (Bun reports % funcs and % lines, not branches — line coverage is the
// closest proxy and is what we gate on.)

import { spawnSync } from "child_process";

const res = spawnSync(
  "bun",
  ["test", "--coverage", "src/__tests__/snapshot/", "src/__tests__/agent-state.test.ts"],
  { encoding: "utf8" },
);
const out = (res.stdout ?? "") + (res.stderr ?? "");
process.stdout.write(out);

// Bun's coverage table uses pipe-delimited rows, e.g.:
//   " src/snapshot/capture.ts           |  100.00 |  100.00 | "
// Columns (after splitting on |): file | % Funcs | % Lines | Uncovered Line #s
const lines = out.split("\n");
const failures: string[] = [];
const THRESHOLD = 95;
const matched: string[] = [];

function isGatedFile(line: string): boolean {
  return line.includes("src/snapshot/") || line.includes("src/agent-state.ts");
}

for (const line of lines) {
  // Only inspect lines that mention a gated source file.
  if (!isGatedFile(line)) continue;

  const parts = line.split("|").map((p) => p.trim());
  // Find the cell that contains the file path.
  const fileIdx = parts.findIndex((p) => isGatedFile(p));
  if (fileIdx === -1) continue;

  // Collect the first two finite numbers after the file column.
  const numbers: number[] = [];
  for (let i = fileIdx + 1; i < parts.length && numbers.length < 2; i++) {
    const n = Number(parts[i]);
    if (Number.isFinite(n)) numbers.push(n);
  }
  if (numbers.length < 2) continue;

  // Bun's pipe layout: col1 = % Funcs, col2 = % Lines
  const linePct = numbers[1];
  const file = parts[fileIdx];
  matched.push(`${file}: ${linePct.toFixed(2)}%`);

  if (linePct < THRESHOLD) {
    failures.push(
      `${file}: line coverage ${linePct.toFixed(1)}% < ${THRESHOLD}%`,
    );
  }
}

if (matched.length === 0) {
  console.error(
    "\nCOVERAGE GATE ERROR: no src/snapshot/** or src/agent-state.ts files found in coverage output.",
  );
  console.error("Ensure bun test --coverage is producing a table for these files.");
  process.exit(2);
}

if (failures.length > 0) {
  console.error("\nCOVERAGE GATE FAILED:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(
  `\nCoverage gate passed: all gated files >= ${THRESHOLD}% line coverage.`,
);
console.log(`Files checked (${matched.length}):`);
for (const m of matched) console.log(`  ${m}`);
