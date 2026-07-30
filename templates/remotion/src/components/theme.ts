/**
 * Shared type and font stack.
 *
 * A system stack rather than a webfont on purpose: a render must not depend on the
 * network, and `@remotion/google-fonts` would add a dependency for a look you will
 * probably want to replace with your own brand font anyway. Swap `FONT_STACK` and
 * the whole piece changes.
 */
export interface Brand {
  accent: string;
  fg: string;
  bg: string;
}

export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
