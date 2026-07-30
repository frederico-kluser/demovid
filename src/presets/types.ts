/**
 * The preset contract.
 *
 * Two axes, deliberately orthogonal because they answer different questions:
 *
 *  - **The preset** is look and pace: how much help does the viewer need?
 *    Dim opacity, dwell time and cursor travel all move together along that one
 *    axis (helpdesk → boardroom → launchpad → changelog → cinema).
 *  - **The camera rung** is safety: how aggressively may we touch the app?
 *    Chosen by the rehearsal, demoted on failure, independent of the look.
 *
 * Presets never carry `scenes`. Only the user's storyboard does. Mixing content
 * into a layered-config preset is the classic array-merge footgun.
 */
import type { BakedSpring } from "../generated/springs.js";
import type { Voice } from "../openai/tts.js";

/** Where the camera transform is applied. R0 (`document.body`) was measured broken and removed. */
export type CameraRung = "R1" | "R2" | "R3";

/** `auto` lets the rehearsal choose and demote. */
export type CameraSetting = CameraRung | "auto";

/** How the camera animates. See `overlay/src/stage.ts` for why `will-change` is banned. */
export type Quality = "smooth" | "crisp";

export interface CameraPreset {
  /** Industry-convergent default is 1.5×. Above ~2× the frame stops reading as the app. */
  zoom: number;
  /** Baked from Cap's constants at build time. */
  spring: BakedSpring;
  /** Hold after the camera settles, before narration continues. */
  minHoldMs: number;
  /**
   * Extra hold after the move resolves, for the compositor to re-rasterise.
   * Measured: `transform: scale()` does not blur text, but text IS soft while
   * the layer is promoted mid-move and crisp again once it lands. Defaults to
   * 180ms when absent.
   */
  rasterHoldMs?: number;
}

export interface CursorPreset {
  /** Diameter of the dot, in px, at scale 1. */
  dotPx: number;
  /** Multiplier on Fitts's-Law travel time. >1 is slower and more deliberate than a real user. */
  travelFactor: number;
  spring: BakedSpring;
  /** Ring drawn while travelling — anticipation. `null` for presets that skip it. */
  ring: { toPx: number; strokePx: number; durationMs: number } | null;
  /** Click contraction. Cap's constants (0.8 over 130ms) when absent. */
  click?: { shrinkTo: number; ms: number };
}

export interface SpotlightPreset {
  /** Opacity of the dim outside the cutout. */
  dim: number;
  cutoutRadiusPx: number;
  paddingPx: number;
  /** Pulsing ring around the cutout. `null` for a static outline. */
  pulse: { toScale: number; periodMs: number; cycles: number } | null;
  ringPx: number;
}

export interface BalloonPreset {
  maxWidthPx: number;
  fontSizePx: number;
  lineHeight: number;
  fontWeight: number;
  radiusPx: number;
  paddingPx: [number, number];
  bg: string;
  fg: string;
  accent: string;
  shadow: string;
  /** `anchored` draws a tail at the target; `docked` pins to a corner with a connector. */
  placement: "anchored" | "docked-bottom-left" | "lower-third";
  /**
   * `backdrop-filter: blur()` behind the balloon, in px.
   *
   * Load-bearing whenever `bg` carries real alpha: transparency without blur
   * puts the app's own text directly behind the caption, and two overlapping
   * texts are unreadable at any contrast ratio. The blur turns whatever is
   * behind into a field instead of competing glyphs.
   */
  backdropBlurPx: number;
  /**
   * Keep the balloon off the synthetic cursor as well as off the target.
   *
   * Only matters when the balloon is the sole channel — in a narrated video a
   * cursor briefly behind a balloon costs nothing, because the voice carries the
   * step anyway. In a silent GIF the same overlap hides the one thing the frame
   * is about.
   */
  avoidCursor: boolean;
}

export interface PacingPreset {
  /** Characters per second the viewer can comfortably read. Netflix/BBC subtitle budgets. */
  cps: number;
  /** Silence between steps. Real, because the TTS clips are trimmed to near-zero. */
  gapMs: number;
  /** Floor and ceiling for how long a step stays on screen, independent of audio length. */
  dwellMinMs: number;
  dwellPerWordMs: number;
  dwellCapMs: number;
}

export interface VoicePreset {
  voice: Voice;
  targetWpm: number;
  /** Steers accent, tone and pacing. The locale overlay appends to this. */
  instructions: string;
}

export interface Preset {
  name: string;
  /** One line, shown by `demovid --help` and in the rehearsal report. */
  summary: string;
  camera: CameraPreset;
  cursor: CursorPreset;
  spotlight: SpotlightPreset;
  balloon: BalloonPreset;
  pacing: PacingPreset;
  voice: VoicePreset;
}

/**
 * A locale overlay. Separate layer on purpose — 5 presets × N locales would
 * otherwise be 5N presets.
 */
export interface LocaleOverlay {
  tag: string;
  /** Multiplier on `pacing.cps`. Netflix's pt-BR adult limit is 17 CPS vs English 20. */
  cpsFactor: number;
  /** Multiplier on dwell. Portuguese is more syllable-dense than English. */
  durationFactor: number;
  /** Multiplier on balloon width — the same word count needs more line. */
  widthFactor: number;
  /** Appended to the preset's `instructions`. */
  instructionsSuffix: string;
  /**
   * Whether a human must listen before the video ships. True where accent drift
   * is reported and unverified — pt-BR ↔ pt-PT is the known case.
   */
  requireHumanListen: boolean;
}
