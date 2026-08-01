/**
 * Write the camera plan the page reads.
 *
 * The film is flat; the tilts happen in CSS. That only stays honest if both
 * sides come from one definition — a hand-copied list of shot boundaries would
 * drift the first time a shot's length changed, and a camera pointing at the
 * wrong half of the screen is worse than no camera. So the build emits this
 * from `shots.ts` rather than anyone maintaining it twice.
 *
 *     npx tsx src/emit-camera.ts <outfile>
 */

import { writeFileSync } from "node:fs";

import { FPS, filmDurationInFrames, timeline } from "./shots";

const out = process.argv[2];
if (!out) {
  console.error("usage: emit-camera <outfile>");
  process.exit(1);
}

const plan = {
  // Generated. Edit render/src/shots.ts, then rebuild.
  fps: FPS,
  duration: filmDurationInFrames() / FPS,
  shots: timeline().map((s) => ({
    start: Number(s.start.toFixed(4)),
    end: Number(s.end.toFixed(4)),
    ...s.camera,
  })),
};

writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
console.log(`camera plan -> ${out} (${plan.shots.length} shots, ${plan.duration.toFixed(2)}s)`);
