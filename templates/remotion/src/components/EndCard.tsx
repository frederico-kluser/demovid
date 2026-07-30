import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_STACK, type Brand } from "./theme";

/**
 * The closing card: the claim, then the call to action a beat later.
 *
 * Every size is a fraction of `height`, never `vh` — see the note in `theme.ts`.
 */
export const EndCard: React.FC<{ title: string; cta: string; brand: Brand }> = ({ title, cta, brand }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  // Eight frames behind the title, so the eye lands on the claim first.
  const ctaEnter = spring({ frame: frame - 8, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: brand.bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          fontFamily: FONT_STACK,
          fontSize: height * 0.064,
          fontWeight: 800,
          letterSpacing: "-0.03em",
          color: brand.fg,
          opacity: enter,
          transform: `translateY(${interpolate(enter, [0, 1], [height * 0.024, 0])}px)`,
          textAlign: "center",
          padding: "0 8%",
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: "1.2em",
          padding: "0.55em 1.5em",
          borderRadius: 999,
          backgroundColor: brand.accent,
          color: brand.bg,
          fontFamily: FONT_STACK,
          fontSize: height * 0.032,
          fontWeight: 700,
          opacity: ctaEnter,
          transform: `scale(${interpolate(ctaEnter, [0, 1], [0.9, 1])})`,
        }}
      >
        {cta}
      </div>
    </AbsoluteFill>
  );
};
