#!/usr/bin/env python3
"""
Fail a build whose footage doesn't move.

Two takes shipped as finished video before this existed. Both looked fine in the
tape and in the build log: a prefix chord fired before jmux had settled and was
dropped, and because the rest of the tape was arrow keys and a space — harmless
at a shell prompt — the recording completed normally and produced eighteen
seconds of a static sidebar. A second act sat on one frame for its whole length
with a first-to-last difference of 0.03.

Nothing else in the pipeline can catch that. VHS exits 0, ffmpeg encodes it, the
durations are right, and the only signal is that the picture never changes.

    python3 check-motion.py act1.mp4 act2.mp4 ...
"""

import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageStat

# Mean absolute luma difference between the first and last second. Measured
# against real takes: a working act scores 4–21, a dead one 0.03–0.43. Anything
# under this is a frame that never changed, not a subtle shot.
MIN_MOTION = 2.0


def grab(src: str, ss: float, out: str) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(ss),
         "-i", src, "-frames:v", "1", out],
        check=True,
    )


def motion(src: str) -> tuple[float, float]:
    dur = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
        capture_output=True, text=True, check=True,
    ).stdout)

    with tempfile.TemporaryDirectory() as d:
        a, b = os.path.join(d, "a.png"), os.path.join(d, "b.png")
        grab(src, 0.5, a)
        grab(src, max(0.6, dur - 1.0), b)
        ia = Image.open(a).convert("L")
        ib = Image.open(b).convert("L")
        return ImageStat.Stat(ImageChops.difference(ia, ib)).mean[0], dur


def main() -> None:
    dead = []
    for src in sys.argv[1:]:
        m, dur = motion(src)
        mark = "ok " if m >= MIN_MOTION else "DEAD"
        print(f"    {mark} {os.path.basename(src):10s} {dur:5.1f}s  motion={m:6.2f}")
        if m < MIN_MOTION:
            dead.append(src)

    if dead:
        print(f"\n{len(dead)} act(s) never changed on screen — re-record before shipping:",
              file=sys.stderr)
        for src in dead:
            print(f"  {src}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
