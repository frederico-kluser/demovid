/**
 * The edit decision list: `.timeline.json` + the model's editorial choices → a
 * typed document a Remotion composition can render without interpreting anything.
 *
 * This is the first consumer of `.timeline.json` in the repository. The sidecar has
 * carried scored cut points since it was written and nothing had ever read them.
 *
 * ## Where the cuts come from
 *
 * Two different sources answer two different questions, and mixing them up is the
 * only real bug available here:
 *
 *  - **`cuts[]` decides WHETHER a boundary may be trimmed.** `scoreCuts` already
 *    knows that a navigation nearby is worth −0.40 and a failed step −0.30, and it
 *    only emits points at 0.5 or above. So a boundary with no cut point near it is
 *    a boundary demovid has already judged unsafe, and this module leaves it alone
 *    instead of re-deriving the same heuristic worse.
 *  - **`narration[]` decides WHERE.** The spans are measured `play()`→`onended`
 *    round trips, so the silence between two of them is real silence. The cut lands
 *    inside it, a fixed handle away from speech on both sides.
 *
 * ## Why the handles are not optional
 *
 * `<TransitionSeries.Transition>` overlaps its neighbours: the last N frames of the
 * outgoing scene play under the first N frames of the incoming one, and the total
 * shortens by N (docs: `Total = ΣSequences − ΣTransitions`). Those overlapped frames
 * must therefore be frames nobody needs to hear. {@link HANDLE_MS} reserves them.
 * A transition longer than the handle would fade out a word that is still being
 * spoken, so {@link transitionFrames} clamps it and degrades to a hard cut rather
 * than shortening the handle.
 *
 * ## Frames are absolute in the source
 *
 * `trimBefore` / `trimAfter` are the current names (Remotion 4.0.319+, replacing
 * `startFrom` / `endAt`) and they are positions **in the source video**, not
 * offsets within the scene. `atFrame` on a narration line is the opposite: relative
 * to its own scene, because that is where a `<Sequence>` puts it. Both are named
 * after the Remotion prop they feed so the renderer never has to convert.
 *
 * The EDL runs at {@link EDL_FPS}, deliberately not the capture's 60: the capture
 * rate is a property of the recorder and the timeline is a property of the edit.
 */
import type { Commercial, SceneEdit, TransitionKind } from "../openai/commercial.js";
import type { Timeline } from "../timeline.js";

export const EDL_FORMAT = "demovid.edl";
export const EDL_VERSION = 1;

/** The edit's frame rate. 30 is the commercial default; the capture is 60. */
export const EDL_FPS = 30;

/**
 * Silence kept on each side of a trimmed boundary, in ms.
 *
 * Sized for the transition, not for taste: 320 ms is 9.6 frames at 30 fps, so the
 * longest transition this module will emit (9 frames) still overlaps only silence.
 */
export const HANDLE_MS = 320;

/** Below this there is nothing worth removing, so the boundary is just partitioned. */
const MIN_DROP_MS = 150;

/** Longest transition, in frames. Bounded by {@link HANDLE_MS}. */
const MAX_TRANSITION_FRAMES = 9;

/** A scene this short cannot hold a transition or a phrase. */
const TINY_SCENE_MS = 1200;

/** Where the impact phrase goes when the model did not say. */
const DEFAULT_IMPACT_AT = 0.25;

/**
 * Frames an impact phrase needs on screen to be worth emitting.
 *
 * Derived from the renderer rather than from taste: `ImpactPhrase.tsx` staggers the
 * words `WORD_STAGGER_FRAMES = 3` apart and enters each on a `damping: 200` spring
 * that takes roughly 15 frames to settle, so a five-word phrase is not finished
 * arriving until `4 * 3 + 15 = 27` frames. Anything shorter is a flash of
 * half-animated words. Change the stagger in the template and change this with it.
 */
const MIN_IMPACT_FRAMES = 27;

export interface EdlNarration {
  /** `audio/<hash>.mp3`, relative to the Remotion project's `public/`. */
  src: string;
  /** Frames from the START OF THIS SCENE. */
  atFrame: number;
  durationInFrames: number;
  /** What the human wrote, for captions and for reading the EDL. */
  text: string;
}

export interface EdlTransition {
  /** Imported by the renderer from `@remotion/transitions/<presentation>`. */
  presentation: Exclude<TransitionKind, "corte">;
  durationInFrames: number;
}

export interface EdlScene {
  id: string;
  /** Human label, shown in the Studio timeline. */
  label: string;
  /** Absolute frame in the source video. Feeds `<Video trimBefore>`. */
  trimBefore: number;
  /** Absolute frame in the source video. Feeds `<Video trimAfter>`. */
  trimAfter: number;
  /** `trimAfter - trimBefore`. Feeds `<TransitionSeries.Sequence durationInFrames>`. */
  durationInFrames: number;
  /** Slow push-in, or null where the in-page camera already moved. */
  kenBurns: { from: number; to: number } | null;
  narration: EdlNarration[];
  /** Kinetic typography. `atFrame` is relative to this scene. */
  impact: { text: string; atFrame: number; durationInFrames: number } | null;
  /** How this scene enters. `null` is a hard cut — no Transition element at all. */
  transitionIn: EdlTransition | null;
}

export interface Edl {
  format: typeof EDL_FORMAT;
  version: typeof EDL_VERSION;
  fps: number;
  width: number;
  height: number;
  video: {
    /** Relative to `public/`. */
    src: string;
    durationInFrames: number;
  };
  /**
   * Where sound comes from.
   *
   * `embedded` — the recorded MP4 keeps its narration and the composition plays it.
   * One clock, no alignment to get wrong, and the default for that reason.
   *
   * `tracks` — the video is muted and each `narration[].src` is played as its own
   * `<Audio>`. Full editorial control (re-record one line, reorder scenes, duck
   * music properly) at the cost of owning the alignment. The clips ship either way,
   * so this is a one-field change in the Studio.
   */
  audio: "embedded" | "tracks";
  brand: { accent: string; fg: string; bg: string };
  hook: { text: string; sub: string | null; durationInFrames: number } | null;
  scenes: EdlScene[];
  endCard: { title: string; cta: string; durationInFrames: number } | null;
  /** Reserved. No track is bundled — see `templates/remotion/README.md`. */
  music: null;
}

const msToFrames = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

/** Never emit a zero-length sequence: Remotion throws on `durationInFrames: 0`. */
const atLeastOneFrame = (n: number): number => Math.max(1, n);

/**
 * Clamp a requested transition to what the handles can pay for.
 *
 * Returns 0 when the boundary cannot afford one, which the caller turns into a hard
 * cut. Shortening the handle instead would put the crossfade on top of speech.
 */
export function transitionFrames(kind: TransitionKind, trimmed: boolean, fps: number): number {
  if (kind === "corte") return 0;
  // An untrimmed boundary has no handles — the scenes butt directly against
  // narration, so any overlap eats words.
  if (!trimmed) return 0;
  const affordable = Math.floor((HANDLE_MS / 1000) * fps);
  const frames = Math.min(MAX_TRANSITION_FRAMES, affordable);
  // Under three frames a transition is indistinguishable from a cut and still
  // costs the arithmetic.
  return frames >= 3 ? frames : 0;
}

/**
 * Where the impact phrase sits inside its scene, or `null` for no phrase.
 *
 * The phrase has to dodge **both** crossfades, and they are at opposite ends.
 * Measured on Remotion 4.0.501: in a `<TransitionSeries>` of a 45-frame sequence, a
 * 9-frame transition and a 54-frame sequence, `useCurrentFrame()` inside the second
 * sequence read **24 at absolute frame 60** — so that sequence's frame 0 sits at
 * absolute 36, and the overlap is at the **start** of the incoming scene. A scene
 * therefore loses its first `framesIn` frames to the transition it enters on and its
 * last `framesOut` frames to its successor's.
 *
 * Exported because it is the only arithmetic here with two neighbours in it, and
 * asserting it directly is much cheaper than asserting it through a whole EDL.
 */
export function placeImpact(opts: {
  text: string | null | undefined;
  /** 0–1, the model's requested position. */
  atPercent: number;
  durationInFrames: number;
  /** True for a scene too short to hold text at all. */
  tiny: boolean;
  /** Frames lost at the START, to the transition this scene enters on. */
  framesIn: number;
  /** Frames lost at the END, to the NEXT scene's transition. */
  framesOut: number;
}): { text: string; atFrame: number; durationInFrames: number } | null {
  const text = opts.text?.trim();
  if (!text || opts.tiny) return null;

  // The last frame the phrase may still be visible on.
  const last = opts.durationInFrames - opts.framesOut;
  if (last - opts.framesIn < MIN_IMPACT_FRAMES) return null;

  const wanted = Math.round(opts.durationInFrames * opts.atPercent);
  // Late is fine; too late is not. The phrase keeps its text and loses its timing —
  // the model chose to caption this shot and only guessed at when.
  const atFrame = Math.min(Math.max(wanted, opts.framesIn), last - MIN_IMPACT_FRAMES);
  return { text, atFrame, durationInFrames: last - atFrame };
}

interface Boundary {
  /** Where the outgoing scene ends, in ms of video time. */
  outMs: number;
  /** Where the incoming scene starts. Greater than `outMs` when air was removed. */
  inMs: number;
  /** True when dead air was actually dropped — the precondition for a transition. */
  trimmed: boolean;
}

/**
 * Resolve one boundary between consecutive steps.
 *
 * `gap` is the measured silence between the last word of the outgoing scene and the
 * first word of the incoming one. It is only trimmed when `cuts[]` contains a point
 * inside it, which is how the existing scoring keeps this function from cutting next
 * to a navigation or inside a failed step.
 */
function resolveBoundary(gapStartMs: number, gapEndMs: number, tl: Timeline): Boundary {
  const mid = Math.round((gapStartMs + gapEndMs) / 2);
  const gap = gapEndMs - gapStartMs;
  const needed = 2 * HANDLE_MS + MIN_DROP_MS;

  if (gap < needed) return { outMs: mid, inMs: mid, trimmed: false };

  const endorsed = tl.cuts.some((c) => c.atMs > gapStartMs && c.atMs < gapEndMs);
  if (!endorsed) return { outMs: mid, inMs: mid, trimmed: false };

  return { outMs: gapStartMs + HANDLE_MS, inMs: gapEndMs - HANDLE_MS, trimmed: true };
}

/** The step indices whose scenes the in-page camera left alone. */
export function staticCameraSteps(tl: Timeline): Set<number> {
  const moved = new Set<number>();
  for (const e of tl.events) {
    if (e.t === "camera-move" && e.stepIndex !== undefined) moved.add(e.stepIndex);
  }
  return new Set(tl.steps.map((s) => s.index).filter((i) => !moved.has(i)));
}

export interface BuildEdlOptions {
  timeline: Timeline;
  /** Filename of the video inside the project's `public/`. */
  videoSrc: string;
  /** The model's editorial choices. Absent means hard cuts and no text. */
  commercial?: Commercial | undefined;
  fps?: number;
  audio?: "embedded" | "tracks";
  brand?: { accent: string; fg: string; bg: string };
}

const DEFAULT_BRAND = { accent: "#F59E0B", fg: "#F8FAFC", bg: "#0B1220" };

export function buildEdl(opts: BuildEdlOptions): Edl {
  const tl = opts.timeline;
  const fps = opts.fps ?? EDL_FPS;
  const edits = new Map<number, SceneEdit>((opts.commercial?.scenes ?? []).map((s) => [s.index, s]));
  const cameraStatic = staticCameraSteps(tl);

  // Only steps that produced usable video. A failed step is still in the take, but
  // its scene shows an action that did not happen.
  const steps = tl.steps.filter((s) => s.ok).sort((a, b) => a.startMs - b.startMs);

  const narrationOf = (index: number): typeof tl.narration =>
    tl.narration
      .filter((n) => n.stepIndex === index)
      .sort((a, b) => a.sentenceIndex - b.sentenceIndex);

  // ── boundaries first: a scene's in-point depends on the previous scene ──────
  const inMs: number[] = [];
  const outMs: number[] = [];
  const trimmed: boolean[] = [];

  for (const [i, step] of steps.entries()) {
    const mine = narrationOf(step.index);
    const next = steps[i + 1];

    inMs[i] = i === 0 ? Math.max(0, step.startMs) : (inMs[i] ?? step.startMs);
    if (!next) {
      outMs[i] = Math.min(tl.video.durationMs, step.endMs);
      // Deliberately does NOT touch `trimmed[i]`: that flag describes this scene's
      // INCOMING boundary and the previous iteration already set it. Clearing it
      // here cost the last scene its transition.
      continue;
    }

    // The gap is measured speech-to-speech when both sides have narration, and
    // falls back to the step boundary when one of them is silent.
    const lastWordEnd = mine.length > 0 ? Math.max(...mine.map((n) => n.endMs)) : step.endMs;
    const nextNarration = narrationOf(next.index);
    const firstWordStart =
      nextNarration.length > 0 ? Math.min(...nextNarration.map((n) => n.startMs)) : next.startMs;

    const b = resolveBoundary(Math.min(lastWordEnd, firstWordStart), Math.max(lastWordEnd, firstWordStart), tl);
    outMs[i] = b.outMs;
    inMs[i + 1] = b.inMs;
    trimmed[i + 1] = b.trimmed;
  }

  // ── scene extents first, scenes second ─────────────────────────────────────
  //
  // Two passes and not one, because an impact phrase has to end before the NEXT
  // scene's transition begins: scene `i` needs a number that belongs to scene
  // `i + 1`. Everything in this pass depends only on index `i`, so `tFrames` — the
  // cost of the transition a scene ENTERS on — is computed here too, and the second
  // pass reads its successor's out of the same array.
  const drafts = steps.map((step, i) => {
    const startMs = inMs[i] ?? step.startMs;
    const endMs = Math.max(startMs + 1, outMs[i] ?? step.endMs);
    const trimBefore = msToFrames(startMs, fps);
    const trimAfter = Math.max(trimBefore + 1, msToFrames(endMs, fps));
    const edit = edits.get(step.index);
    const tiny = endMs - startMs < TINY_SCENE_MS;
    return {
      step,
      edit,
      startMs,
      trimBefore,
      trimAfter,
      durationInFrames: atLeastOneFrame(trimAfter - trimBefore),
      tiny,
      // Zero for a hard cut, and zero for a boundary with no handles to pay for one.
      // Scene 0 lands here too: nothing was trimmed before it, so `trimmed[0]` is
      // unset and `transitionFrames` declines — which is also why the opening scene
      // needs no special case.
      tFrames: tiny ? 0 : transitionFrames(edit?.transition ?? "corte", trimmed[i] ?? false, fps),
    };
  });

  const scenes: EdlScene[] = drafts.map((d, i) => {
    const { step, edit } = d;
    const presentation = edit?.transition;
    const transitionIn: EdlTransition | null =
      d.tFrames > 0 && presentation && presentation !== "corte"
        ? { presentation, durationInFrames: d.tFrames }
        : null;

    const impact = placeImpact({
      text: edit?.impact,
      atPercent: edit?.impactAtPercent ?? DEFAULT_IMPACT_AT,
      durationInFrames: d.durationInFrames,
      tiny: d.tiny,
      framesIn: d.tFrames,
      // `undefined` past the end of the array, which is the right answer for the
      // last scene: nothing transitions away from it.
      framesOut: drafts[i + 1]?.tFrames ?? 0,
    });

    return {
      id: `s${step.index}`,
      label: `${step.action}${step.target ? ` ${step.target}` : ""}`,
      trimBefore: d.trimBefore,
      trimAfter: d.trimAfter,
      durationInFrames: d.durationInFrames,
      // Honoured only where the page's own camera stayed put: two zooms on the same
      // shot fight each other, and the in-page one has real resolution.
      kenBurns: edit?.kenBurns && cameraStatic.has(step.index) ? { from: 1, to: 1.06 } : null,
      narration: narrationOf(step.index).map((n) => ({
        src: `audio/${n.id}.mp3`,
        atFrame: Math.max(0, msToFrames(n.startMs - d.startMs, fps)),
        durationInFrames: atLeastOneFrame(msToFrames(n.endMs - n.startMs, fps)),
        text: n.text,
      })),
      impact,
      transitionIn,
    };
  });

  return {
    format: EDL_FORMAT,
    version: EDL_VERSION,
    fps,
    width: tl.video.width,
    height: tl.video.height,
    video: { src: opts.videoSrc, durationInFrames: msToFrames(tl.video.durationMs, fps) },
    audio: opts.audio ?? "embedded",
    brand: opts.brand ?? DEFAULT_BRAND,
    hook: opts.commercial
      ? { text: opts.commercial.hook.text, sub: opts.commercial.hook.sub ?? null, durationInFrames: Math.round(fps * 2) }
      : null,
    scenes,
    endCard: opts.commercial
      ? { title: opts.commercial.endCard.title, cta: opts.commercial.endCard.cta, durationInFrames: Math.round(fps * 2.5) }
      : null,
    music: null,
  };
}

/**
 * Frames scene `index`'s incoming transition removes from the total.
 *
 * The rule is **not** "a transition may not come first" — that is a widely repeated
 * claim and it is false; the docs offer a leading `<Transition>` as the way to animate
 * the first scene's entrance. The real rule is that `<TransitionSeries>` shortens by a
 * transition only when it sits **between two sequences**, because the overlapped frames
 * have to come from a predecessor and an edge transition has none.
 *
 * Measured: `Transition(15) · Sequence(60) · Transition(20) · Sequence(60)` laid out
 * **100** frames — `60 + 60 − 20`, with the leading 15 costing nothing. Remotion clamps
 * that case rather than rejecting it.
 *
 * So a transition on scene 0 is legal and free, but only while nothing precedes it,
 * which here means no hook card. Subtracting it anyway would make the composition
 * shorter than its content and silently cut the last frames off the end.
 *
 * demovid never emits one there — `transitionFrames` declines at scene 0 because
 * nothing was trimmed before it, so there are no handles. This is for the EDL a human
 * edited, which the README invites them to do.
 *
 * Note this answers a *different* question from `placeImpact`'s `framesIn`: what a
 * transition COSTS the timeline and what it OVERLAPS on screen are not the same number.
 * A free leading transition still covers the scene's first frames.
 *
 * `templates/remotion/src/edl.ts` has this function too, under the same name.
 * `test/remotion-template.test.ts` asserts the two agree; if you change one, change both.
 */
export function transitionCostAt(edl: Pick<Edl, "hook" | "scenes">, index: number): number {
  const t = edl.scenes[index]?.transitionIn;
  if (!t) return 0;
  if (index === 0 && !edl.hook) return 0;
  return t.durationInFrames;
}

/**
 * Total length of the composition, in frames.
 *
 * Mirrors `TransitionSeries`' own arithmetic — `ΣSequences − ΣTransitions` — because
 * `calculateMetadata` has to agree with what the renderer builds, and a composition
 * one frame longer than its content renders a black frame at the end.
 */
export function edlDurationInFrames(edl: Edl): number {
  const sequences =
    (edl.hook?.durationInFrames ?? 0) +
    edl.scenes.reduce((n, s) => n + s.durationInFrames, 0) +
    (edl.endCard?.durationInFrames ?? 0);
  const transitions = edl.scenes.reduce((n, _s, i) => n + transitionCostAt(edl, i), 0);
  return atLeastOneFrame(sequences - transitions);
}
