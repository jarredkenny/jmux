import React from "react";
import { Composition } from "remotion";
import { Film, FPS, filmDurationInFrames } from "./Film";
import { LoopFleet, LoopTicket, LoopFlow } from "./Loops";

const W = 1920;
const H = 1080;

export const Root: React.FC = () => (
  <>
    {/*
      The film renders at the terminal's native 1600×900 — flat, with no chrome.
      The page frames it and moves the camera, so every pixel here is terminal
      and none is letterboxing.
    */}
    <Composition
      id="film"
      component={Film}
      durationInFrames={filmDurationInFrames()}
      fps={FPS}
      width={1600}
      height={900}
    />

    {/* README loops carry their own frame and backdrop. See Loops.tsx. */}
    <Composition id="loop-fleet"  component={LoopFleet}  durationInFrames={5 * FPS} fps={FPS} width={W} height={H} />
    <Composition id="loop-ticket" component={LoopTicket} durationInFrames={5 * FPS} fps={FPS} width={W} height={H} />
    <Composition id="loop-flow"   component={LoopFlow}   durationInFrames={9 * FPS} fps={FPS} width={W} height={H} />
  </>
);
