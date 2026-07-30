import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_STACK, type Brand } from "./theme";

/**
 * The opening card. Two lines at most — it is on screen for two seconds.
 *
 * Every size is a fraction of `height`, never `vh` — see the note in `theme.ts`.
 */
export const Hook: React.FC<{ text: string; sub: string | null; brand: Brand }> = ({ text, sub, brand }) => {
  const frame = useCurrentFrame();
  // `durationInFrames` is THIS SEQUENCE's length, not the composition's. Measured on
  // 4.0.501: a `<Sequence durationInFrames={30}>` inside a 90-frame composition
  // reports 30. That is what makes the fade-out below land on the end of the card
  // instead of the end of the video.
  const { fps, durationInFrames, height } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  // Eases out over the last third, so a hard cut into the first scene still feels
  // deliberate rather than abrupt.
  const leave = interpolate(frame, [durationInFrames - Math.round(fps * 0.3), durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: brand.bg,
        alignItems: "center",
        justifyContent: "center",
        opacity: leave,
      }}
    >
      <div
        style={{
          transform: `translateY(${interpolate(enter, [0, 1], [height * 0.03, 0])}px)`,
          opacity: enter,
          textAlign: "center",
          padding: "0 8%",
        }}
      >
        <div
          style={{
            fontFamily: FONT_STACK,
            fontSize: height * 0.075,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.08,
            color: brand.fg,
          }}
        >
          {text}
        </div>
        {sub ? (
          <div
            style={{
              marginTop: "0.5em",
              fontFamily: FONT_STACK,
              fontSize: height * 0.031,
              fontWeight: 500,
              color: brand.fg,
              opacity: 0.72,
            }}
          >
            {sub}
          </div>
        ) : null}
        <div
          style={{
            margin: "1.1em auto 0",
            width: interpolate(enter, [0, 1], [0, height * 0.14]),
            height: height * 0.005,
            borderRadius: 999,
            backgroundColor: brand.accent,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
