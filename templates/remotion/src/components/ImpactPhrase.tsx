import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_STACK, type Brand } from "./theme";

/**
 * Frames between two consecutive words entering.
 *
 * Exported because `buildEdl` in demovid needs it to decide whether a scene is long
 * enough to hold a phrase at all: a five-word phrase is not finished entering until
 * `4 * WORD_STAGGER_FRAMES` plus the spring's own settle time. Change it here and
 * change `MIN_IMPACT_FRAMES` in `src/remotion/edl.ts` with it.
 */
export const WORD_STAGGER_FRAMES = 3;

/**
 * Kinetic typography: the words arrive one after another, not all at once.
 *
 * The stagger is {@link WORD_STAGGER_FRAMES} frames per word — 100 ms at 30 fps —
 * which is enough to read as sequence and short enough that a five-word phrase is
 * fully on screen in under half a second. `damping: 200` is critically damped: no
 * bounce, because a bouncing word in a product commercial reads as a template.
 *
 * Every size is a fraction of `height`, never `vh` — see the note in `theme.ts`.
 */
export const ImpactPhrase: React.FC<{ text: string; brand: Brand }> = ({ text, brand }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const words = text.split(/\s+/).filter(Boolean);

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "flex-end",
        paddingBottom: "11%",
        // No background plate: the phrase sits over the product, and a panel behind
        // it would hide the thing the shot is about. The shadow does the contrast.
        pointerEvents: "none",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0.3em" }}>
        {words.map((word, i) => {
          const enter = spring({ frame: frame - i * WORD_STAGGER_FRAMES, fps, config: { damping: 200 } });
          return (
            <span
              key={`${word}-${i}`}
              style={{
                fontFamily: FONT_STACK,
                fontSize: height * 0.052,
                fontWeight: 800,
                letterSpacing: "-0.02em",
                color: brand.fg,
                opacity: enter,
                transform: `translateY(${interpolate(enter, [0, 1], [height * 0.026, 0])}px)`,
                textShadow: `0 ${height * 0.002}px ${height * 0.008}px rgba(0,0,0,.55), 0 ${height * 0.008}px ${height * 0.032}px rgba(0,0,0,.45)`,
                whiteSpace: "nowrap",
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
      <div
        style={{
          marginTop: "0.45em",
          width: interpolate(spring({ frame, fps, config: { damping: 200 } }), [0, 1], [0, height * 0.16]),
          height: height * 0.004,
          borderRadius: 999,
          backgroundColor: brand.accent,
        }}
      />
    </AbsoluteFill>
  );
};
