import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useVideoConfig } from "remotion";
import type { ShotSpec } from "./shots";

/**
 * README loops: single shots, flat, no transition.
 *
 * These are GIFs, so they carry the window frame and backdrop the film leaves to
 * the page — a bare terminal rectangle in a README looks like a screenshot that
 * failed to load. They hold the camera still for the same reason the film's
 * wrap does: continuous movement means every pixel changes every frame, and GIF
 * has nothing left to compress. Cut from the moving film, these were 8–13MB
 * each; still, they are under 500KB.
 */
const BACKDROP =
  "radial-gradient(120% 100% at 25% 0%, #1c1d23 0%, #101116 55%, #0a0b0e 100%)";

const makeLoop =
  (spec: ShotSpec): React.FC =>
  () => {
    const { fps } = useVideoConfig();
    return (
      <AbsoluteFill style={{ background: BACKDROP }}>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <div
            style={{
              width: 1600,
              height: 900,
              borderRadius: 14,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow:
                "0 64px 150px rgba(0,0,0,0.70), 0 10px 34px rgba(0,0,0,0.48)",
            }}
          >
            <OffthreadVideo
              src={staticFile(spec.src)}
              trimBefore={Math.round(spec.from * fps)}
              playbackRate={spec.speed ?? 1}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    );
  };

/** The Command Center grid: five agents working at once. */
export const LoopFleet = makeLoop({ src: "act1.mp4", from: 11.4, duration: 5 });

/** An agent's diff beside the ticket it came from. */
export const LoopTicket = makeLoop({ src: "act2.mp4", from: 9.6, duration: 5 });

/** Marking a status, and two sessions leaving the sidebar. */
export const LoopFlow = makeLoop({ src: "act3.mp4", from: 8.6, duration: 9 });
