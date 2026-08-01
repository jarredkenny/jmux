# The jmux walkthrough

`./build.sh --record` records and cuts the whole thing. `./build.sh` re-cuts
from footage already recorded.

```
act1.tape ─┐
act2.tape ─┼─ vhs ─► act{1,2,3}.mp4 ─► check-motion.py ─► render/ (Remotion)
act3.tape ─┘                                                   │
                                          ┌────────────────────┴────────────────┐
                                          ▼                                     ▼
                        site/assets/hero.mp4  (flat)              docs/screenshots/*.gif
                        site/assets/hero-camera.json ─► the hero tilts it in CSS
```

## Why two tools

**VHS** drives jmux and records the terminal. It runs the tapes against
`jmux --demo --live`, so the agents on screen are real ones doing real work.

**Remotion** does the cut: six shots joined by one slide-up, looping.

The video it produces is **flat** — no tilts, no window chrome, no backdrop. All
three happen on the page in CSS. Baking a camera into the video changes every
pixel of every frame, which cost 2.9MB, softened the terminal text it was
rotating, and made retuning a push a full re-render; as a CSS transform the same
move is free, sharp at any size, and a stylesheet edit.

The tradeoff is that the standalone `hero.mp4` has no camera — shots and slides
only. That matters if it gets posted somewhere on its own. The shot plan still
carries the camera, so a baked variant is a small change to `Film.tsx`, not a
rewrite.

`render/src/shots.ts` is the single source: Remotion cuts from it, and the build
emits `hero-camera.json` from it for the page. Two hand-kept copies of the shot
boundaries would drift the first time a shot changed length, and a camera
pointing at the wrong half of the screen is worse than no camera at all.

`docs/demos/storyboard.md` is the argument behind the cut; `render/src/Film.tsx`
is the cut itself.

## A note on the Remotion licence

Remotion is **source-available, not open source**. It is free for individuals
and companies of three people or fewer, and requires a paid licence above that —
see <https://remotion.dev/license>. jmux is AGPL, and nothing jmux *ships*
depends on Remotion: it lives here, in `render/`, and is needed only to
re-render this video. Building, installing and running jmux does not touch it.

If that ever becomes awkward, the swap is contained. `render/src/` is about 200
lines against a small surface — `<OffthreadVideo>`, `interpolate`, `Easing` and
`TransitionSeries` — and [Motion Canvas](https://motioncanvas.io) (MIT) covers
the same ground.

## Things that will bite

- **`typescript` must stay on 5.x here.** TypeScript 7 dropped `ts.sys`, and
  `@remotion/bundler`'s esbuild loader calls `typescript.sys.readFile` — but only
  when typescript is resolvable at all. Installing it unpinned takes 7.x and the
  bundler dies with `Cannot read properties of undefined (reading 'readFile')`,
  which points at esbuild and has nothing to do with esbuild.

- **A dropped keystroke records fine.** `check-motion.py` exists because two
  takes shipped as finished video without ever changing on screen. It fails the
  build on footage whose first and last frames match.
- **Live agents make every take different.** Shots are composed to survive that —
  they hold on states the fleet reliably reaches, not on a particular agent
  saying a particular thing.
- **Moving cameras and GIFs don't mix.** The README loops are separate
  compositions (`render/src/Loops.tsx`), and unlike the film they carry their own
  frame and backdrop — a bare terminal rectangle in a README looks like a
  screenshot that failed to load.
- **H.264 only, and deliberately.** VP9 was tried twice: at matching quality it
  produced a *larger* file while listed first in the page's `<video>`, so
  webm-capable browsers fetched the heavier one; and the encode that finally beat
  it on size failed to decode in Chrome (`MEDIA_ERR_DECODE`) — which, being
  first in the list, is a dead player for most visitors.
- **It is encoded at the terminal's native 1600×900**, so nothing is resampled.
  It was briefly 1280 for a ~550px hero column; the hero shot now bleeds into the
  page gutter and reaches ~730 CSS px, which is ~1460 device px on retina, so the
  smaller encode had become the thing softening the picture. CRF carries the
  weight instead — this is the first thing on the page and it autoplays, so its
  size is the page's size.
- **Remotion renders full-range.** Left alone it tags `yuvj420p` and some players
  lift the contrast. The encode forces `out_range=tv`; the terminal's colours are
  the thing being shown.
- **Some of jmux is unfilmable here.** `Ctrl-Shift-Up/Down`, the glass
  `Shift+arrow` bindings and everything mouse-only cannot be driven by VHS. See
  storyboard.md § "What VHS cannot drive".
