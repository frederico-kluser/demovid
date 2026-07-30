/**
 * The shape of `edl.json`, and the one piece of arithmetic the renderer owns.
 *
 * Types only, no zod. The EDL is produced by `buildEdl` in demovid from already
 * typed data, so a schema here would be a second source of truth for the same
 * shape — and the two would drift on the first field added to either. If you want
 * the Studio's generated props form, adding a zod schema and passing it as
 * `schema` on the `<Composition>` is a one-file change; see the README.
 */

export interface EdlNarration {
  /** Relative to `public/`. */
  src: string;
  /** Frames from the start of ITS OWN scene. */
  atFrame: number;
  durationInFrames: number;
  text: string;
}

export interface EdlTransition {
  presentation: "fade" | "slide" | "wipe";
  durationInFrames: number;
}

export interface EdlScene {
  id: string;
  label: string;
  /** Absolute frame in the source video. */
  trimBefore: number;
  /** Absolute frame in the source video. */
  trimAfter: number;
  durationInFrames: number;
  kenBurns: { from: number; to: number } | null;
  narration: EdlNarration[];
  impact: { text: string; atFrame: number; durationInFrames: number } | null;
  /** `null` is a hard cut: no `<TransitionSeries.Transition>` is emitted at all. */
  transitionIn: EdlTransition | null;
}

/**
 * A `type`, not an `interface`, and that is load-bearing.
 *
 * `<Composition>` constrains its props to `Record<string, unknown>`. TypeScript
 * gives an implicit index signature to a type ALIAS of an object type and never to
 * an interface, so declaring this as an interface makes the composition fail to
 * typecheck with "Type 'Record<string, unknown>' is missing the following
 * properties" — and, worse, drops the generic so `calculateMetadata` receives
 * `unknown` props.
 */
export type Edl = {
  format: string;
  version: number;
  fps: number;
  width: number;
  height: number;
  video: { src: string; durationInFrames: number };
  /**
   * `embedded` — the recorded MP4 keeps its narration and plays it. One clock.
   * `tracks` — the video is muted and each narration line plays as its own
   * `<Audio>`, which is what you want if you start reordering scenes.
   */
  audio: "embedded" | "tracks";
  brand: { accent: string; fg: string; bg: string };
  hook: { text: string; sub: string | null; durationInFrames: number } | null;
  scenes: EdlScene[];
  endCard: { title: string; cta: string; durationInFrames: number } | null;
  music: null;
};

/**
 * Frames scene `index`'s incoming transition removes from the total.
 *
 * `<TransitionSeries>` shortens by a transition only when it sits **between two
 * sequences**: the overlapped frames come out of a predecessor, and an edge transition
 * has none. It is perfectly legal to open the series with a `<Transition>` — that is
 * the documented way to animate the first scene's entrance — it simply costs nothing.
 *
 * Measured: `Transition(15) · Sequence(60) · Transition(20) · Sequence(60)` laid out
 * **100** frames, which is `60 + 60 − 20`. The leading 15 were free.
 *
 * So `Comercial.tsx` renders whatever the EDL asks for, and this function is the only
 * thing that decides what `totalFrames` subtracts. Subtracting a free transition would
 * make the composition shorter than its content and cut the end off the last scene.
 */
export function transitionCostAt(edl: Edl, index: number): number {
  const t = edl.scenes[index]?.transitionIn;
  if (!t) return 0;
  if (index === 0 && !edl.hook) return 0;
  return t.durationInFrames;
}

/**
 * Total length of the composition.
 *
 * This is `<TransitionSeries>`' own contract — `Total = ΣSequences − ΣTransitions`,
 * because a transition overlaps its two neighbours instead of adding to them. It
 * has to be computed from the *props* rather than read from a stored field, or
 * editing a transition in the Studio would leave the composition the wrong length.
 *
 * demovid has the same formula in `src/remotion/edl.ts` (`edlDurationInFrames`),
 * where it is unit-tested. If you change one, change both.
 */
export function totalFrames(edl: Edl): number {
  const sequences =
    (edl.hook?.durationInFrames ?? 0) +
    edl.scenes.reduce((n, s) => n + s.durationInFrames, 0) +
    (edl.endCard?.durationInFrames ?? 0);
  const transitions = edl.scenes.reduce((n, _s, i) => n + transitionCostAt(edl, i), 0);
  return Math.max(1, sequences - transitions);
}
