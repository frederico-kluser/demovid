/**
 * The overlay's animation layer.
 *
 * Replaces hand-written CSS transitions with real springs that can be
 * interrupted. The reason interruptibility matters here is not aesthetics: a
 * `cursorTo` arriving while the previous travel is still in flight used to
 * restart the transition from wherever the dot happened to be, which reads as a
 * stutter on a 60 fps capture.
 *
 * `motion/mini` and not `motion`: measured at 11.2 KB against 61.8 KB for the
 * full package, on top of a 14 KB overlay. The full build also runs a
 * per-frame rAF loop on the main thread — the same cost this codebase already
 * rejected when it turned down Floating UI's `autoUpdate`. Mini converts the
 * spring to a `linear()` easing plus a duration and hands it to WAAPI, so the
 * animation runs on the compositor.
 *
 * ## The trap this module exists to close
 *
 * Mini's `finished` promise resolves from `onfinish`. When a second `animate()`
 * lands on the same element, mini calls `stop()` on the first, which commits
 * styles and cancels — **`onfinish` never fires and that promise never
 * settles**. `src/record.ts` awaits `cursorTo` through `page.evaluate`, so one
 * interrupted travel would hang the Node driver until Playwright's timeout, and
 * the failure would be reported against whatever step came next.
 *
 * So every tween here returns its OWN deferred, resolved on natural completion,
 * on retarget, or by a watchdog. That is the same rule `src/record.ts` states
 * for the driver: every wait is bounded.
 *
 * ## The other trap
 *
 * A live WAAPI animation overrides inline styles regardless of specificity. Any
 * code that writes `el.style.transform` directly must `cancelAnim` first, or the
 * write silently does nothing while the animation is still parked on the
 * element.
 */
import { animate } from "motion/mini";
import { spring } from "motion";

/**
 * A spring, in either of Motion's two parameterisations.
 *
 * The physical form reproduces the baked constants exactly. The perceptual form
 * exists because some timings in this overlay are *measured requirements*, not
 * aesthetic choices — cursor travel follows Fitts's Law, and a spring picked by
 * stiffness alone would throw that away. `visualDuration` pins how long the
 * move reads as taking, and `bounce` keeps the house's near-critical damping.
 */
export type SpringSpec =
  | {
      stiffness: number;
      damping: number;
      mass: number;
      /** Seed with the velocity an interrupted spring had. */
      velocity?: number;
    }
  | { visualDurationMs: number; bounce: number };

function springOptions(spec: SpringSpec): Record<string, unknown> {
  if ("visualDurationMs" in spec) {
    return { type: spring, visualDuration: spec.visualDurationMs / 1000, bounce: spec.bounce };
  }
  return {
    type: spring,
    stiffness: spec.stiffness,
    damping: spec.damping,
    mass: spec.mass,
    ...(spec.velocity !== undefined ? { velocity: spec.velocity } : {}),
  };
}

/** ζ → Motion's `bounce`. Near-critical damping means almost none. */
export function bounceFor(zeta: number): number {
  return Math.max(0, Math.min(0.4, 1 - zeta));
}

export interface Tween {
  /** Always settles: on finish, on retarget, or on the watchdog. */
  finished: Promise<void>;
}

interface Running {
  stop: () => void;
  settle: () => void;
  watchdog: ReturnType<typeof setTimeout>;
}

/**
 * One running tween per (element, property). Keyed by element so a detached
 * node does not keep its entry alive.
 */
const running = new WeakMap<Element, Map<string, Running>>();

function slotsFor(el: Element): Map<string, Running> {
  let m = running.get(el);
  if (!m) {
    m = new Map();
    running.set(el, m);
  }
  return m;
}

/**
 * Stop whatever is animating `prop` on `el`, committing the current value and
 * settling the promise anyone is waiting on.
 *
 * Call this before writing `el.style[prop]` by hand.
 */
export function cancelAnim(el: Element, prop: string): void {
  const slot = slotsFor(el).get(prop);
  if (!slot) return;
  slotsFor(el).delete(prop);
  clearTimeout(slot.watchdog);
  try {
    slot.stop();
  } catch {
    /* already gone */
  }
  slot.settle();
}

/** Current numeric translation of an element, from its committed transform. */
export function currentTranslate(el: Element): { x: number; y: number } {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return { x: 0, y: 0 };
  try {
    const m = new DOMMatrixReadOnly(t);
    return { x: m.m41, y: m.m42 };
  } catch {
    return { x: 0, y: 0 };
  }
}

/** Current uniform scale of an element, from its committed transform. */
export function currentScale(el: Element): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 1;
  try {
    const m = new DOMMatrixReadOnly(t);
    return Math.hypot(m.m11, m.m12) || 1;
  } catch {
    return 1;
  }
}

/**
 * Animate one CSS property to `to` with a spring.
 *
 * `durationHintMs` only sizes the watchdog; the spring decides the real
 * duration. The watchdog is generous on purpose — it is a guarantee that the
 * promise settles, not a schedule.
 */
export function springTo(
  el: Element,
  prop: string,
  to: string | number,
  spec: SpringSpec,
  durationHintMs = 800,
): Tween {
  // Retarget: settle the old promise now, so nobody waits on a dead animation.
  cancelAnim(el, prop);

  let settle!: () => void;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const controls = animate(
    el as HTMLElement,
    { [prop]: to } as Record<string, string | number>,
    springOptions(spec) as never,
  );

  const slot: Running = {
    stop: () => controls.stop(),
    settle,
    watchdog: setTimeout(() => {
      // The animation never reported finishing. Commit and move on rather than
      // leaving the driver blocked.
      const s = slotsFor(el).get(prop);
      if (s !== slot) return;
      slotsFor(el).delete(prop);
      try {
        controls.complete();
      } catch {
        /* nothing to complete */
      }
      settle();
    }, durationHintMs + 250),
  };

  slotsFor(el).set(prop, slot);

  void controls.finished
    .then(() => {
      if (slotsFor(el).get(prop) !== slot) return; // superseded
      slotsFor(el).delete(prop);
      clearTimeout(slot.watchdog);
      settle();
    })
    .catch(() => {
      // A cancelled animation rejects in some engines. The promise still has to
      // settle, and `cancelAnim` has usually done it already.
      if (slotsFor(el).get(prop) !== slot) return;
      slotsFor(el).delete(prop);
      clearTimeout(slot.watchdog);
      settle();
    });

  return { finished };
}

/**
 * True while `el` still has any animation parked on it.
 *
 * The overlay's e2e asserts this is false after the camera settles: a live
 * animation keeps the stage promoted to its own compositor layer, which pins
 * the raster scale — the exact mechanism that makes magnified text permanently
 * blurry. No pixel assertion can see that; this can.
 */
export function hasLiveAnimations(el: Element): boolean {
  return el.getAnimations().length > 0;
}
