import React from "react";
import { AbsoluteFill, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Audio, Video } from "@remotion/media";
import type { Edl, EdlScene } from "../edl";
import { ImpactPhrase } from "./ImpactPhrase";

/**
 * One cut: a window of the recording, plus whatever is drawn on top of it.
 *
 * `<Video>` from `@remotion/media` rather than `<OffthreadVideo>` — it is the
 * recommended tag for new projects and extracts the exact frame during rendering.
 * `trimBefore` / `trimAfter` are absolute frames **in the source file**, so the
 * same MP4 is reused by every scene and no clip files are cut on disk.
 */
export const Scene: React.FC<{ scene: EdlScene; edl: Edl }> = ({ scene, edl }) => {
  const frame = useCurrentFrame();

  // Ken Burns. Only ever set where the page's own camera stayed still — demovid
  // checks that, because two zooms on one shot fight each other.
  const scale = scene.kenBurns
    ? interpolate(frame, [0, scene.durationInFrames], [scene.kenBurns.from, scene.kenBurns.to], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;

  const separateTracks = edl.audio === "tracks";

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${scale})` }}>
        <Video
          src={staticFile(edl.video.src)}
          trimBefore={scene.trimBefore}
          trimAfter={scene.trimAfter}
          // Muted only when the narration is being played from its own files.
          // Otherwise the recording's own audio IS the narration, already in sync.
          muted={separateTracks}
        />
      </AbsoluteFill>

      {separateTracks
        ? scene.narration.map((n) => (
            <Sequence key={n.src} from={n.atFrame} durationInFrames={n.durationInFrames} name={n.text.slice(0, 32)}>
              <Audio src={staticFile(n.src)} />
            </Sequence>
          ))
        : null}

      {scene.impact ? (
        <Sequence
          from={scene.impact.atFrame}
          durationInFrames={scene.impact.durationInFrames}
          name={`impacto: ${scene.impact.text}`}
        >
          <ImpactPhrase text={scene.impact.text} brand={edl.brand} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
