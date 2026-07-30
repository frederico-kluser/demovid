import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_STACK, type Brand } from "./theme";

/** The opening card. Two lines at most — it is on screen for two seconds. */
export const Hook: React.FC<{ text: string; sub: string | null; brand: Brand }> = ({ text, sub, brand }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
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
          transform: `translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
          opacity: enter,
          textAlign: "center",
          padding: "0 8%",
        }}
      >
        <div
          style={{
            fontFamily: FONT_STACK,
            fontSize: "7.5vh",
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
              fontSize: "3.1vh",
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
            width: `${interpolate(enter, [0, 1], [0, 14])}vh`,
            height: 5,
            borderRadius: 3,
            backgroundColor: brand.accent,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
