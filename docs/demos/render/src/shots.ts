/**
 * The shot plan — the one place shot timings and camera moves are written down.
 *
 * Remotion reads this to cut the film. The *page* reads it too, as JSON emitted
 * by the build, because the camera no longer lives in the video.
 *
 * ## Why the camera is not baked in
 *
 * A tilt rendered into the video changes every pixel of every frame, which
 * costs three things at once: the file was 2.9MB where a flat cut of the same
 * footage is a fraction of that, rotated terminal text gets resampled and goes
 * soft, and retuning a push means a full re-render. Done in CSS on the page the
 * transform is free, stays pixel-sharp at any resolution, and is a stylesheet
 * edit rather than a render.
 *
 * The cost is that the standalone file is flat: shots and slide transitions,
 * no camera. That matters if the mp4 is posted somewhere on its own. The plan
 * below still holds the moves, so a baked variant is a change to `Film.tsx`
 * rather than a rewrite.
 *
 * ## Keeping the two in sync
 *
 * The page drives its transform from `video.currentTime` rather than from a CSS
 * animation of a matching duration. An animation would start in sync and drift
 * the moment the video stalled on a slow connection, and a camera pointing at
 * the wrong half of the screen is worse than no camera at all.
 */

export const FPS = 50;

/** Frames each slide-up runs for. One value, because there is one transition. */
export const SLIDE_FRAMES = 20;

/**
 * Frames the wrap sequence runs for. Longer than the slide on purpose: if it is
 * exactly the transition's length the slide is still finishing on the final
 * frame, which leaves the window sitting low with a dark band above it.
 */
export const WRAP_FRAMES = SLIDE_FRAMES + 8;

export interface Camera {
  /**
   * Rotation only — there is deliberately no `scale`.
   *
   * The camera used to push in as well as tilt. On a page that reads as the
   * *page* zooming rather than as a camera moving: a tilt is something happening
   * to an object in space, a scale is something happening to your viewport.
   *
   * Scale originally earned its place for a different reason — when the camera
   * was baked into the video, a shot whose camera came to rest produced
   * identical frames, and a floor on scale drift was what kept it moving. The
   * video is flat now and carries its own motion, so that argument retired with
   * the baked camera.
   */
  /** Y-axis rotation in degrees, start → end. Negative slants the other way. */
  rotateY?: [number, number];
  /** X-axis rotation in degrees, start → end. Positive leans the top away. */
  rotateX?: [number, number];
  /** Vertical offset in px, start → end, at the film's native 1600×900. */
  y?: [number, number];
  /** CSS transform-origin — the point the rotation pivots about. */
  origin?: string;
  /** Settle on a spring rather than a bezier, for shots that *arrive*. */
  spring?: boolean;
}

export interface ShotSpec {
  /** File in public/, e.g. "act1.mp4". */
  src: string;
  /** Where to start in the source, in seconds. */
  from: number;
  /** How long this shot runs on screen, in seconds (after `speed`). */
  duration: number;
  /** Source playback rate. >1 compresses navigation nobody needs to study. */
  speed?: number;
  /** How the camera behaves for this shot. */
  camera?: Camera;
}

/**
 * Six shots. The order builds understanding without a word: many agents at once
 * → one agent up close → where the work comes from → how you bend it to your
 * own process → what that does to your sidebar.
 *
 * Every shot moves differently, and every move is a rotation. Seven identical
 * push-ins was one idea repeated seven times; by the third the viewer sees the
 * effect rather than the product. Tilting on different axes, from different
 * origins, at different speeds reads as one camera working rather than as a
 * preset.
 */
export const SHOTS: ShotSpec[] = [
  // Open on the grid: five agents working at once, the most arresting frame in
  // the recording.
  //
  // This shot is the loop point: the film ends inside a slide-up back into it.
  // It cannot have an *entrance* — it used to spring in from a 15° slant, which
  // made its first and last frames completely different and left the seam
  // measuring 13 where a hard cut measures 15–40. A slow sweep is fine, because
  // the wrap returns to this shot's start pose rather than its end pose.
  {
    src: "act1.mp4",
    from: 11.2,
    duration: 5.0,
    // A slow sweep, and nothing else. This shot is the loop point, so whatever
    // it does the page must be able to return to its *start* pose at the wrap —
    // which it does, because the wrap falls through to exactly that.
    camera: { rotateY: [-3, 1.5] },
  },

  // One agent, close — and the entrance the opening shot had to give up. Arrives
  // hard over on Y and springs flat, pivoting about the sidebar so that column is
  // what swings into view.
  {
    src: "act1.mp4",
    from: 0.6,
    duration: 4.6,
    camera: {
      rotateY: [14, 0],
      y: [22, 0],
      origin: "16% 45%",
      spring: true,
    },
  },

  // The ticket beside the work. Leans the opposite way to the shot before it, on
  // both axes, and settles rather than arrives.
  {
    src: "act2.mp4",
    from: 9.6,
    duration: 4.6,
    camera: { rotateY: [-9, -2], rotateX: [2, 0] },
  },

  // The workflow screen. Leans back from the top and settles — a different axis
  // again, and the tilt draws the eye down the status table.
  {
    src: "act3.mp4",
    from: 1.0,
    duration: 4.4,
    camera: { rotateX: [9, 0], spring: true },
  },

  // Walking the table and marking one. Compressed, and given a small lean of its
  // own: arrow keys shift a row highlight and nothing else, so this is the one
  // shot whose content cannot carry the motion by itself.
  {
    src: "act3.mp4",
    from: 6.4,
    duration: 2.6,
    speed: 1.8,
    camera: { rotateX: [4, 0.5], origin: "58% 42%" },
  },

  // The payoff. The take switches to a live agent after the park, so the frame
  // carries the sidebar's new `Parked (2)` row *and* a working pane. Rises into
  // place, pivoting low-left so the parked row is what settles toward the
  // viewer.
  {
    src: "act3.mp4",
    from: 19.4,
    duration: 5.2,
    camera: {
      y: [30, 0],
      rotateY: [-6, 0],
      origin: "22% 72%",
      spring: true,
    },
  },
];

/**
 * The wrap: a slide-up back into the opening shot, so the film runs forever.
 *
 * It outlasts the slide so the transition finishes, and its `from` is rolled
 * back by its own length so its last frame is exactly the frame the film opens
 * on.
 */
export const WRAP: ShotSpec = {
  ...SHOTS[0]!,
  from: SHOTS[0]!.from - (WRAP_FRAMES - 1) / FPS,
  duration: WRAP_FRAMES / FPS,
  // No camera. The page's timeline covers SHOTS only, so during the wrap it
  // falls through to shot 1's *start* pose — which is exactly the pose the film
  // restarts on, and is what makes the seam invisible.
  camera: undefined,
};

export const framesOf = (seconds: number): number => Math.round(seconds * FPS);

/** Total length in frames, accounting for the frames transitions overlap away. */
export const filmDurationInFrames = (): number => {
  const shots = SHOTS.reduce((n, s) => n + framesOf(s.duration), 0) + WRAP_FRAMES;
  return shots - SHOTS.length * SLIDE_FRAMES;
};

/**
 * When each shot starts and ends on the finished timeline, in seconds.
 *
 * A transition overlaps the two sequences it joins, so each shot begins
 * `SLIDE_FRAMES` earlier than a naive sum would put it. The page needs these to
 * know which camera is in force at a given `currentTime`.
 */
export function timeline(): Array<{ start: number; end: number; camera: Camera }> {
  const out: Array<{ start: number; end: number; camera: Camera }> = [];
  let cursor = 0;
  for (const shot of SHOTS) {
    const frames = framesOf(shot.duration);
    out.push({
      start: cursor / FPS,
      end: (cursor + frames) / FPS,
      camera: shot.camera ?? {},
    });
    cursor += frames - SLIDE_FRAMES;
  }
  return out;
}
