/**
 * Shared type and font stack.
 *
 * A system stack rather than a webfont on purpose: a render must not depend on the
 * network, and `@remotion/google-fonts` would add a dependency for a look you will
 * probably want to replace with your own brand font anyway. Swap `FONT_STACK` and
 * the whole piece changes.
 *
 * ## Sizes are fractions of `useVideoConfig().height`, never `vh`
 *
 * Every component here multiplies a fraction by the composition height instead of
 * writing `vh`. That looks like extra work and is not.
 *
 * Measured against Remotion 4.0.501 on 2026-07-30: **during a render the browser
 * viewport IS the composition** — `window.innerHeight` read 720 on a 1280×720
 * composition — so `vh` renders exactly right and the mistake is invisible in the
 * output. But the Studio and the `<Player>` draw the composition into a
 * `transform: scale()`d container inside an ordinary window, so `vh` resolves
 * against the **window**. On that same composition, `20vh` measured **180px** in a
 * 900px-tall Studio window and **240px** in a 1200px-tall one, against the 144px it
 * renders as — and `5vh` type came out 45px and 60px instead of 36px.
 *
 * So with `vh` the preview disagrees with the output, and disagrees *differently*
 * every time the operator resizes the window. That defeats the entire point of
 * shipping a Studio: you cannot size a title against a preview that lies.
 *
 * Safe: `%` (resolves against the parent box, which is inside the composition) and
 * `em` (relative to font-size). Unsafe, for the same reason: `vh`, `vw`, `vmin`,
 * `vmax`, and `rem` — the root font-size is not scaled either.
 */
export interface Brand {
  accent: string;
  fg: string;
  bg: string;
}

export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
