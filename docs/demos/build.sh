#!/usr/bin/env bash
#
# Build the jmux walkthrough from the recorded acts.
#
#   ./build.sh          # cut + encode everything from existing act*.mp4
#   ./build.sh --record # re-record the acts first (slow: real agents warm up)
#
# Recording and cutting are separate steps on purpose. The acts are the
# expensive part — each boots a demo and waits ~60s for live agents to reach a
# filmable state — while the cut gets iterated on constantly. Changing a push or
# a transition must not cost a re-record.
#
# The cut is Remotion (render/), not ffmpeg. ffmpeg can crossfade and zoom, but
# its zoompan is linear, and linear motion is exactly what makes a product demo
# look like software did it rather than like someone shot it. Remotion gives
# eased motion, real CSS shadows, and a framed window on a gradient — the
# difference between a screen recording and a demo.
#
# Outputs (in dist/):
#   hero.mp4               the walkthrough, for the site (H.264 only — see below)
#   fleet.gif              the Command Center grid, for the README
#   ticket.gif             an agent's work beside its ticket
#   flow.gif               the workflow screen, and work leaving the sidebar
#   poster.jpg             hero poster frame

set -euo pipefail

cd "$(dirname "$0")"

DIST="dist"
WORK="$DIST/.work"
RENDER="render"

command -v ffmpeg  >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v npm     >/dev/null || { echo "npm is required (for the Remotion cut)" >&2; exit 1; }

if [[ "${1:-}" == "--record" ]]; then
  command -v vhs >/dev/null || { echo "vhs is required to record (brew install vhs)" >&2; exit 1; }
  echo "==> recording acts (each waits ~60s for live agents)"
  for tape in act1 act2 act3; do
    echo "    $tape"
    vhs "$tape.tape"
  done
fi

for act in act1 act2 act3; do
  [[ -f "$act.mp4" ]] || { echo "missing $act.mp4 — run with --record" >&2; exit 1; }
done

# Refuse to cut a film out of footage that never changed. A dropped keystroke
# records perfectly happily — see check-motion.py.
echo "==> checking footage"
python3 check-motion.py act1.mp4 act2.mp4 act3.mp4

rm -rf "$DIST"
mkdir -p "$WORK"

if [[ ! -d "$RENDER/node_modules" ]]; then
  echo "==> installing render toolchain"
  (cd "$RENDER" && npm install --no-audit --no-fund >/dev/null \
    && npm approve-scripts esbuild >/dev/null 2>&1 || true)
fi

echo "==> staging footage"
cp act1.mp4 act2.mp4 act3.mp4 "$RENDER/public/"

echo "==> cutting"
(cd "$RENDER" && npx remotion render film "../$WORK/hero.mp4" --log=error)

# The camera plan the page reads. Generated from the same shots.ts Remotion cut
# from, because the film is flat and the tilts happen in CSS — two hand-kept
# copies of the shot boundaries would drift the first time a shot changed length.
echo "==> camera plan"
(cd "$RENDER" && npx tsx src/emit-camera.ts "../$WORK/hero-camera.json")

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }

# Remotion renders near-lossless and full-range; the page wants something that
# loads and decodes everywhere.
#
# **H.264 only.** There is no webm any more. VP9 was tried twice and lost twice:
# at the CRFs that matched H.264's quality it produced a *larger* file while
# being listed first in the page's <video>, so webm-capable browsers downloaded
# the heavier one — and the file that finally beat it on size failed to decode
# in Chrome outright (`MEDIA_ERR_DECODE`), which, being first in the list, would
# have shipped a dead player to every Chrome and Firefox visitor. H.264 plays
# everywhere that matters, including iOS, and is the smaller file here.
#
# `out_range=tv` is not optional: Remotion's output is full-range, which tags as
# `yuvj420p` and renders with lifted contrast in some players — the terminal's
# colours are the thing this video is showing.
echo "==> encoding"
# Native 1600×900 — no downscale, so no resampling of terminal text.
#
# It was briefly encoded at 1280 for a ~550px hero column. The hero shot now
# bleeds into the page gutter and reaches ~900 CSS px, which is ~1800 device px
# on a retina screen, so 1280 had become the thing softening the picture. CRF
# carries the weight instead: this is the first thing on the page and it
# autoplays, so its size is the page's size.
ffmpeg -hide_banner -loglevel error -y -i "$WORK/hero.mp4" \
  -vf "scale=out_range=tv,format=yuv420p" \
  -c:v libx264 -preset slow -crf 31 -pix_fmt yuv420p \
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -movflags +faststart \
  "$DIST/hero.mp4"

# Poster from inside the opening shot, after the fade from black.
ffmpeg -hide_banner -loglevel error -y -ss 2.4 -i "$DIST/hero.mp4" \
  -frames:v 1 -q:v 3 "$DIST/poster.jpg"

cp "$WORK/hero-camera.json" "$DIST/hero-camera.json"

# README loops. Rendered as their own compositions with the camera held still —
# see render/src/Loops.tsx. Cutting them out of the finished film instead gave
# 8–13MB each, because a moving camera leaves GIF's frame-delta compression
# nothing to work with.
#
# Two-pass palette: a shared palette across all frames keeps jmux's sidebar
# colours from banding into mud at 128 colours.
gif() {
  local comp="$1" out="$2" fps="${3:-11}" width="${4:-980}"
  (cd "$RENDER" && npx remotion render "$comp" "../$WORK/$comp.mp4" --log=error)
  ffmpeg -hide_banner -loglevel error -y -i "$WORK/$comp.mp4" \
    -vf "fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=stats_mode=diff" \
    -y "$WORK/pal.png"
  ffmpeg -hide_banner -loglevel error -y -i "$WORK/$comp.mp4" -i "$WORK/pal.png" \
    -lavfi "fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
    "$out"
}

echo "==> loops"
gif loop-fleet  "$DIST/fleet.gif"
gif loop-ticket "$DIST/ticket.gif"
gif loop-flow   "$DIST/flow.gif"

rm -rf "$WORK"

# Publish into the places the site and README reference, so "rebuild the video"
# is one command and cannot leave the published assets a version behind.
echo "==> installing"
SITE="../../site/assets"
SHOTS="../screenshots"
mkdir -p "$SITE" "$SHOTS"
cp "$DIST/hero.mp4"   "$SITE/hero.mp4"
cp "$DIST/poster.jpg" "$SITE/hero-poster.jpg"
cp "$DIST/hero-camera.json" "$SITE/hero-camera.json"
cp "$DIST/fleet.gif"  "$SHOTS/fleet.gif"
cp "$DIST/ticket.gif" "$SHOTS/ticket.gif"
cp "$DIST/flow.gif"   "$SHOTS/flow.gif"

echo
echo "==> done"
ls -lh "$DIST"
printf '%-12s %ss\n' "hero.mp4" "$(dur "$DIST/hero.mp4")"
echo "installed -> site/assets/{hero.mp4,hero-poster.jpg,hero-camera.json}"
echo "installed -> docs/screenshots/{fleet,ticket,flow}.gif"
