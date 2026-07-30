import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_STACK, type Brand } from "./theme";

/**
 * Kinetic typography: the words arrive one after another, not all at once.
 *
 * The stagger is three frames per word — 100 ms at 30 fps — which is enough to read
 * as sequence and short enough that a five-word phrase is fully on screen in under
 * half a second. `damping: 200` is critically damped: no bounce, because a bouncing
 * word in a product commercial reads as a template.
 */
export const ImpactPhrase: React.FC<{ text: string; brand: Brand }> = ({ text, brand }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
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
          const enter = spring({ frame: frame - i * 3, fps, config: { damping: 200 } });
          return (
            <span
              key={`${word}-${i}`}
              style={{
                fontFamily: FONT_STACK,
                fontSize: "5.2vh",
                fontWeight: 800,
                letterSpacing: "-0.02em",
                color: brand.fg,
                opacity: enter,
                transform: `translateY(${interpolate(enter, [0, 1], [26, 0])}px)`,
                textShadow: "0 2px 8px rgba(0,0,0,.55), 0 8px 32px rgba(0,0,0,.45)",
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
          width: `${interpolate(spring({ frame, fps, config: { damping: 200 } }), [0, 1], [0, 16])}vh`,
          height: 4,
          borderRadius: 2,
          backgroundColor: brand.accent,
        }}
      />
    </AbsoluteFill>
  );
};
