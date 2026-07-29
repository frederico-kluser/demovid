/**
 * The camera stage.
 *
 * Everything here is the R1 rung, and every line of it is a measurement, not a
 * guess. See `AGENTS.md` and the plan's "Onde aplicar o transform" section.
 *
 * The rung we do NOT implement is R0 (transform on `document.body`). It is what
 * the OSS prior art does and it is broken: measured on 2026-07-29, under a
 * transformed `body` a `position:fixed` header scrolls to y=-800 after scrolling
 * 800px, `bottom:0` resolves against body's *content* height (y=4004 instead of
 * 669), and `height:100%` becomes the whole document (4068px instead of 733).
 * `body` is viewport-WIDTH but content-HEIGHT — only half of the "coincident
 * with the viewport" premise holds.
 */

import { cancelAnim, springTo, type SpringSpec } from "./anim.js";

export interface Camera {
  tx: number;
  ty: number;
  k: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const IDENTITY: Camera = { tx: 0, ty: 0, k: 1 };

const STAGE_ID = "__demovid_stage";

let stage: HTMLElement | null = null;
let cam: Camera = { ...IDENTITY };

/** The transform string for a camera state. `transform-origin` stays at `0 0`. */
export function cameraToCss(c: Camera): string {
  return `translate3d(${c.tx}px, ${c.ty}px, 0) scale(${c.k})`;
}

/**
 * Centre `r` (viewport coords, already un-transformed) at zoom `k`, clamped so
 * the camera never reveals anything outside the stage.
 */
export function camFor(r: Rect, k: number, W: number, H: number): Camera {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return {
    k,
    tx: Math.min(0, Math.max(W * (1 - k), W / 2 - k * cx)),
    ty: Math.min(0, Math.max(H * (1 - k), H / 2 - k * cy)),
  };
}

/** Invert the current camera to recover an element's untransformed rect. */
export function localRect(el: Element, c: Camera = cam): Rect {
  const R = el.getBoundingClientRect();
  return { x: (R.x - c.tx) / c.k, y: (R.y - c.ty) / c.k, w: R.width / c.k, h: R.height / c.k };
}

/**
 * Mount the stage around the app.
 *
 * Order matters and is load-bearing:
 *  1. `scrollbar-gutter: stable` FIRST — swapping the scroller away from the
 *     document reclaims the scrollbar's 15px and shifts every rect. Reserving
 *     the gutter up front keeps the layout fingerprint stable, so the rehearsal's
 *     pixel diff does not flag our own bookkeeping as an app breakage.
 *  2. `moveBefore` to relocate the children — atomic, and unlike `insertBefore`
 *     it preserves iframe loading state, animations, `:focus`, fullscreen and
 *     open `<dialog>`/popover state.
 *  3. `documentElement.overflow: hidden` LAST — the stage is now the scroller.
 */
export function mountStage(): HTMLElement {
  const existing = document.getElementById(STAGE_ID);
  if (existing) return (stage = existing);

  const doc = document.documentElement;
  doc.style.scrollbarGutter = "stable";

  const el = document.createElement("div");
  el.id = STAGE_ID;
  el.style.cssText =
    "position:fixed; top:0; left:0; width:100%; height:100%;" +
    "overflow:auto; overflow-x:hidden; scrollbar-width:none;" +
    "transform-origin:0 0;";
  // Deliberately NO `will-change: transform`: it pins the raster scale and makes
  // magnified text blurry permanently, not just while moving.
  //
  // `scrollbar-width: none` is load-bearing, not cosmetic. Measured: the moment
  // ANY transform is set on the stage — even `scale(1)` — a `position:fixed;
  // left:0; right:0` header switches containing block from the viewport to the
  // stage's PADDING box, and a visible scrollbar makes that box 15px narrower.
  // The header silently went 1353 → 1338px, a layout shift we caused and would
  // have blamed on the app. With the scrollbar hidden, padding box == border box
  // == viewport, so the rects are identical with and without a transform. The
  // stage still scrolls programmatically, and a scrollbar was never wanted in a
  // recording anyway.
  //
  // `overflow-x: hidden` because the camera pans; nobody scrolls sideways.

  const kids = Array.from(document.body.children);
  document.body.appendChild(el);
  for (const k of kids) {
    if (k === el) continue;
    // `moveBefore` is Chrome 133+. We only ever drive Chromium, but fall back
    // rather than throw — a re-parented iframe is better than no demo.
    const move = (el as unknown as { moveBefore?: (n: Node, ref: Node | null) => void }).moveBefore;
    if (typeof move === "function") move.call(el, k, null);
    else el.appendChild(k);
  }

  doc.style.overflow = "hidden";
  stage = el;
  cam = { ...IDENTITY };
  return el;
}

/** Set the camera immediately, with no animation. */
export function setCamera(c: Camera): void {
  if (!stage) throw new Error("demovid: stage not mounted");
  // A live WAAPI animation overrides inline styles regardless of specificity,
  // so without this the write below would silently do nothing whenever a camera
  // move was still in flight.
  cancelAnim(stage, "transform");
  cam = c;
  stage.style.transform = cameraToCss(c);
}

/**
 * Animate the camera, resolving once it has settled.
 *
 * This replaces writing `stage.style.transition` from the Node side and then
 * sleeping for a guessed duration. That approach left the transition string
 * parked on the element forever, so the final `setCamera(identity)` at the end
 * of a take either transitioned or snapped depending on whether the last step
 * happened to zoom — the ending was not deterministic.
 *
 * The ban on `will-change: transform` is NOT violated by animating here. WAAPI
 * promotes the stage to its own compositor layer only while the animation is
 * running; `motion/mini` writes the final value to inline style and cancels,
 * which releases the promotion and lets Chromium re-raster at the landed scale.
 * `will-change` would make that promotion permanent, which is what pins the
 * raster and makes magnified text blurry forever.
 *
 * The one new hazard: never leave a paused or filled animation parked on the
 * stage, because that is the same permanent promotion by another route. The
 * overlay e2e asserts `stage.getAnimations().length === 0` after settling.
 */
export async function cameraTo(c: Camera, spec: SpringSpec, hintMs = 900): Promise<void> {
  if (!stage) throw new Error("demovid: stage not mounted");
  cam = c;
  await springTo(stage, "transform", cameraToCss(c), spec, hintMs).finished;
}

/** For the e2e: is anything still animating the stage? */
export function stageAnimationCount(): number {
  return stage ? stage.getAnimations().length : 0;
}

export function getCamera(): Camera {
  return { ...cam };
}

/** Scroll the stage — it is the scroller now, not the document. */
export function scrollStageTo(top: number, behavior: ScrollBehavior = "smooth"): void {
  stage?.scrollTo({ top, behavior });
}

/**
 * The hard requirement, as a runtime assertion: the overlay must NOT have been
 * scaled or moved by the stage's transform.
 *
 * Compared against a baseline captured at mount time, NOT against any viewport
 * metric. Two measured facts forced this:
 *   - `innerWidth` includes the scrollbar gutter (1368) — false negative always.
 *   - `clientWidth` also reads 1368 while a `width:100%` fixed child measures
 *     1353, because `scrollbar-gutter: stable` reserves those 15px.
 * Neither number describes "the box the overlay is entitled to". The requirement
 * was never "the overlay equals N pixels" — it is "the overlay did not change
 * when the camera moved". So measure exactly that.
 */
let overlayBaseline: readonly [number, number, number, number] | null = null;

const asTuple = (el: Element): [number, number, number, number] => {
  const r = el.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
};

/** Record what the overlay looks like with the camera at identity. */
export function captureOverlayBaseline(overlay: Element): void {
  overlayBaseline = asTuple(overlay);
}

export function assertOverlayUnscaled(overlay: Element): { ok: boolean; detail: string } {
  const now = asTuple(overlay);
  if (!overlayBaseline) {
    captureOverlayBaseline(overlay);
    return { ok: true, detail: `baseline do overlay registrado: ${now[2]}x${now[3]} @${now[0]},${now[1]}` };
  }
  const base = overlayBaseline;
  const ok = now.every((v, i) => v === base[i]);
  return {
    ok,
    detail: ok
      ? `overlay ${now[2]}x${now[3]} @${now[0]},${now[1]} — inalterado`
      : `overlay era ${base[2]}x${base[3]} @${base[0]},${base[1]} e agora é ` +
        `${now[2]}x${now[3]} @${now[0]},${now[1]} — a câmera arrastou o overlay`,
  };
}

/** Layout fingerprint, for the rehearsal's before/after comparison. */
export function fingerprint(): string {
  const doc = document.documentElement;
  const fixed = Array.from(document.querySelectorAll("*"))
    .filter((e) => getComputedStyle(e).position === "fixed")
    .map((e) => {
      const r = e.getBoundingClientRect();
      return `${e.tagName}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
    });
  return JSON.stringify({
    scroll: [doc.scrollWidth, doc.scrollHeight],
    client: [doc.clientWidth, doc.clientHeight],
    fixed,
  });
}
