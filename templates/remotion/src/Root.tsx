import React from "react";
import { Composition } from "remotion";
import { Comercial } from "./Comercial";
import edlJson from "./edl.json";
import { totalFrames, type Edl } from "./edl";

/**
 * `edl.json` is the roteiro de edição demovid wrote. It arrives as `defaultProps`,
 * so the Studio opens with the whole commercial already assembled — no `--props` to
 * remember. `--props <arquivo>` still overrides it if you want to keep variants.
 */
const edl = edlJson as Edl;

export const Root: React.FC = () => {
  return (
    <Composition
      id="Comercial"
      component={Comercial}
      defaultProps={edl}
      fps={edl.fps}
      width={edl.width}
      height={edl.height}
      durationInFrames={totalFrames(edl)}
      // Recomputed from whatever props are actually in play, so editing a
      // transition or a scene length in the Studio moves the end of the video too.
      calculateMetadata={({ props }) => ({
        durationInFrames: totalFrames(props),
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
    />
  );
};
