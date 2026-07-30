import React from "react";
import { AbsoluteFill } from "remotion";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { EndCard } from "./components/EndCard";
import { Hook } from "./components/Hook";
import { Scene } from "./components/Scene";
import type { Edl, EdlTransition } from "./edl";

/**
 * One `<Transition>`, built by a switch rather than by looking the presentation up
 * in a map.
 *
 * A map reads better and does not compile: `TransitionPresentation` is generic over
 * each presentation's own props (`FadeProps`, `SlideProps`, `WipeProps`), so a
 * `{ fade, slide, wipe }` lookup produces a *union* and `<Transition>` cannot infer
 * one generic from three. In a switch each branch hands over a single concrete
 * type. The three imports are static for a related reason: `@remotion/transitions`
 * ships each presentation as its own entry point, so a name the EDL invented would
 * be an unresolvable import at bundle time rather than a value that is merely
 * missing at runtime.
 */
function transition(key: string, t: EdlTransition): React.ReactNode {
  const timing = linearTiming({ durationInFrames: t.durationInFrames });
  switch (t.presentation) {
    case "fade":
      return <TransitionSeries.Transition key={key} timing={timing} presentation={fade()} />;
    case "slide":
      return <TransitionSeries.Transition key={key} timing={timing} presentation={slide()} />;
    case "wipe":
      return <TransitionSeries.Transition key={key} timing={timing} presentation={wipe()} />;
  }
}

/**
 * The children are assembled into a FLAT array on purpose.
 *
 * `<TransitionSeries>` reads its children to pair every `Transition` with the
 * `Sequence` on each side. Nested arrays and fragments from a `.map()` make that
 * pairing depend on how React happens to flatten — building the list by hand keeps
 * the order literal and the pairing obvious.
 */
export const Comercial: React.FC<Edl> = (edl) => {
  const children: React.ReactNode[] = [];

  if (edl.hook) {
    children.push(
      <TransitionSeries.Sequence key="hook" durationInFrames={edl.hook.durationInFrames} name="gancho">
        <Hook {...edl.hook} brand={edl.brand} />
      </TransitionSeries.Sequence>,
    );
  }

  for (const scene of edl.scenes) {
    // A Transition can never be the first child — there would be nothing to
    // transition from. demovid never emits one for the opening scene, and this
    // guard makes a hand-edited EDL fail soft instead of throwing in the Studio.
    if (scene.transitionIn && children.length > 0) {
      children.push(transition(`${scene.id}-in`, scene.transitionIn));
    }
    children.push(
      <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.durationInFrames} name={scene.label}>
        <Scene scene={scene} edl={edl} />
      </TransitionSeries.Sequence>,
    );
  }

  if (edl.endCard) {
    // Hard cut into the end card. A transition here would have to be subtracted
    // from the total as well, and the card is the one place a cut reads as intent.
    children.push(
      <TransitionSeries.Sequence key="end" durationInFrames={edl.endCard.durationInFrames} name="fecho">
        <EndCard {...edl.endCard} brand={edl.brand} />
      </TransitionSeries.Sequence>,
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: edl.brand.bg }}>
      <TransitionSeries>{children}</TransitionSeries>
    </AbsoluteFill>
  );
};
