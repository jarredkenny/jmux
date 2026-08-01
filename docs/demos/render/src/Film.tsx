import React from "react";
import { AbsoluteFill, Easing, OffthreadVideo, staticFile, useVideoConfig } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { slide } from "@remotion/transitions/slide";

import {
  FPS,
  SHOTS,
  SLIDE_FRAMES,
  WRAP,
  WRAP_FRAMES,
  framesOf,
  type ShotSpec,
} from "./shots";

export { FPS };
export { filmDurationInFrames } from "./shots";

/**
 * The film: six shots of terminal, joined by one slide-up, looping.
 *
 * **Flat on purpose.** No camera, no window chrome, no backdrop — the page adds
 * all three in CSS. Baking a tilt in changes every pixel of every frame, which
 * cost 2.9MB and softened the terminal text it was rotating; done on the page
 * the same move is free, sharp at any size, and tunable without a re-render.
 * See `shots.ts` for the full argument and the tradeoff it accepts.
 *
 * **One transition, used everywhere.** Every boundary is the same slide-up.
 * Mixing fades, wipes and flips made each cut announce itself differently and
 * turned the film into a tour of transitions; one consistent move reads as a
 * single camera travelling through screens.
 *
 * `slide` is a DOM presentation. The package's richer set — `linearBlur`,
 * `crossZoom`, `pushCut` — is built on gl-transitions, and headless Chrome here
 * cannot create a WebGL2 context; forcing software GL (`--gl=swangle`) blows the
 * render timeout on the first frame. Any replacement has to be DOM-based.
 *
 * There is no end card: this is built to sit behind a hero and run forever, and
 * a call to action that reappears every twenty-odd seconds is an advert rather
 * than a backdrop.
 */
const Plate: React.FC<{ spec: ShotSpec }> = ({ spec }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#0d0d0f" }}>
      <OffthreadVideo
        src={staticFile(spec.src)}
        // Trims are in composition frames, so seconds × fps.
        trimBefore={Math.round(spec.from * fps)}
        playbackRate={spec.speed ?? 1}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};

const slideUp = () => (
  <TransitionSeries.Transition
    presentation={slide({ direction: "from-bottom" })}
    timing={linearTiming({
      durationInFrames: SLIDE_FRAMES,
      easing: Easing.inOut(Easing.ease),
    })}
  />
);

export const Film: React.FC = () => (
  <AbsoluteFill style={{ background: "#0d0d0f" }}>
    <TransitionSeries>
      {SHOTS.map((spec) => (
        <React.Fragment key={`${spec.src}-${spec.from}`}>
          <TransitionSeries.Sequence durationInFrames={framesOf(spec.duration)}>
            <Plate spec={spec} />
          </TransitionSeries.Sequence>
          {slideUp()}
        </React.Fragment>
      ))}

      {/* Back into the opening shot, so the film can run forever. */}
      <TransitionSeries.Sequence durationInFrames={WRAP_FRAMES}>
        <Plate spec={WRAP} />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);
