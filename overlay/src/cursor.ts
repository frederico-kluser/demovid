/**
 * The synthetic cursor.
 *
 * The real OS pointer is not in the captured frames when we record a window and
 * drive it programmatically, so we draw one. Two independent concerns, and they
 * must not be conflated:
 *
 *  1. **Event dispatch** — does the app react? That is Playwright's `page.mouse`,
 *     which produces *trusted* events. `element.click()` from injected JS sets
 *     `isTrusted = false` and some apps ignore it.
 *  2. **Visual rendering** — does the viewer see a pointer? That is this file.
 *
 * Motion comes from three measured sources:
 *  - **Path/timing**: Fitts's Law, `230 + 166·log2(D/W + 1)` ms, times the
 *    preset's `travelFactor`. Taken from ghost-cursor (MIT) *without* its jitter
 *    and random in-target offset — those exist to defeat bot detection, which is
 *    the opposite of what a demo wants. We aim at centres, deliberately. The
 *    spring is expressed as `visualDuration` so this timing survives.
 *  - **Easing**: Cap's spring constants, now run at runtime rather than baked,
 *    so an interrupted travel resumes instead of restarting.
 *  - **Click feedback**: contract to 80 % over 130 ms (Cap `CURSOR_CLICK_DURATION`
 *    + `CLICK_SHRINK_SIZE`). It contracts; it is NOT a ripple.
 *
 * ## Why four nested elements instead of one
 *
 * Three transform channels act on the cursor at once — where it is, how much it
 * counter-scales against the camera, and the click contraction — and a single
 * element can only hold one `transform`. The previous version wrote all three
 * into the same string, so each one clobbered the others: `setStageZoom` wrote
 * `scale(s)` and stored it in `--demovid-cursor-counter`, then the very next
 * `moveTo` wrote `scale(1)` and threw it away. That custom property was written
 * and never read anywhere, and under zoom the cursor was simply the wrong size.
 *
 * One element per channel makes the composition the browser's job, and each
 * animation can be interrupted without disturbing the others.
 */
import { cancelAnim, springTo, bounceFor, type SpringSpec } from "./anim.js";
import type { BakedSpring } from "../../src/generated/springs.js";

export interface CursorStyle {
  dotPx: number;
  travelFactor: number;
  spring: BakedSpring;
  accent: string;
  ring: { toPx: number; strokePx: number; durationMs: number } | null;
  /** Click contraction. Defaults match Cap's constants. */
  click?: { shrinkTo: number; ms: number };
}

/** Fitts's Law. MacKenzie's constants; `W` is the target's smaller dimension. */
export function travelMs(distance: number, targetW: number, factor: number): number {
  const w = Math.max(8, targetW);
  const ms = 230 + 166 * Math.log2(distance / w + 1);
  return Math.round(ms * factor);
}

const point = "position:absolute; left:0; top:0; width:0; height:0;";

export class Cursor {
  /** Owns position only. */
  #travel: HTMLElement;
  /** Owns the counter-scale against the camera only. */
  #zoom: HTMLElement;
  /** Owns the click contraction only. */
  #click: HTMLElement;
  #dot: HTMLElement;
  #ring: HTMLElement;
  #style: CursorStyle;
  #x = -100;
  #y = -100;

  constructor(root: ShadowRoot, style: CursorStyle) {
    this.#style = style;

    const travel = document.createElement("div");
    travel.className = "demovid-cursor";
    travel.style.cssText =
      `position:fixed; left:0; top:0; width:0; height:0; opacity:0;` +
      `pointer-events:none; transform:translate3d(-100px,-100px,0);`;

    const ring = document.createElement("div");
    ring.className = "demovid-cursor-ring";
    const toPx = style.ring?.toPx ?? 0;
    ring.style.cssText =
      `position:absolute; left:0; top:0; width:${toPx}px; height:${toPx}px;` +
      `margin-left:${-toPx / 2}px; margin-top:${-toPx / 2}px; border-radius:50%;` +
      `border:${style.ring?.strokePx ?? 0}px solid ${style.accent};` +
      `opacity:0; pointer-events:none; transform:scale(0.2);`;

    const zoom = document.createElement("div");
    zoom.className = "demovid-cursor-zoom";
    zoom.style.cssText = `${point} transform:scale(1);`;

    const click = document.createElement("div");
    click.className = "demovid-cursor-click";
    click.style.cssText = `${point} transform:scale(1);`;

    const dot = document.createElement("div");
    dot.className = "demovid-cursor-dot";
    dot.style.cssText =
      `position:absolute; left:0; top:0; width:${style.dotPx}px; height:${style.dotPx}px;` +
      `margin-left:${-style.dotPx / 2}px; margin-top:${-style.dotPx / 2}px;` +
      `border-radius:50%; background:${style.accent};` +
      `box-shadow:0 1px 3px rgba(0,0,0,.35), 0 0 0 2px rgba(255,255,255,.9);` +
      `pointer-events:none; will-change:transform;`;

    click.append(dot);
    zoom.append(click);
    travel.append(ring, zoom);
    root.append(travel);

    this.#travel = travel;
    this.#zoom = zoom;
    this.#click = click;
    this.#dot = dot;
    this.#ring = ring;
  }

  get position(): { x: number; y: number } {
    return { x: this.#x, y: this.#y };
  }

  /** The travel spring, keeping Fitts's measured duration. */
  #travelSpec(ms: number): SpringSpec {
    return { visualDurationMs: ms, bounce: bounceFor(this.#style.spring.zeta) };
  }

  show(): void {
    this.#travel.style.opacity = "1";
  }

  hide(): void {
    this.#travel.style.opacity = "0";
  }

  /**
   * Counter-scale so the cursor stays legible while the stage zooms.
   *
   * `sqrt(k)`, not `1/k`. `supercut`'s reasoning, and it is right: a cursor held
   * at exactly constant size detaches visually from the content it is pointing
   * at. Balloons want `1.0` — they are chrome. The cursor is halfway between
   * chrome and content, so it grows a little.
   *
   * Lives on its own element, so nothing else can overwrite it. That is the
   * whole reason this class has four nodes.
   */
  setStageZoom(k: number): void {
    const s = 1 / Math.sqrt(Math.max(1, k));
    void springTo(this.#zoom, "transform", `scale(${s})`, this.#travelSpec(420), 420);
  }

  /** Jump with no animation. For the first placement, before the cursor is shown. */
  placeAt(x: number, y: number): void {
    this.#x = x;
    this.#y = y;
    // A live WAAPI animation overrides inline styles, so the write below would
    // silently do nothing while one is still parked here.
    cancelAnim(this.#travel, "transform");
    this.#travel.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  /** Glide to a point. Resolves when it arrives — or when it is superseded. */
  async moveTo(x: number, y: number, targetW = 40): Promise<void> {
    const d = Math.hypot(x - this.#x, y - this.#y);
    const ms = travelMs(d, targetW, this.#style.travelFactor);

    this.#x = x;
    this.#y = y;

    this.#showRing(ms);
    await springTo(
      this.#travel,
      "transform",
      `translate3d(${x}px, ${y}px, 0)`,
      this.#travelSpec(ms),
      ms,
    ).finished;
  }

  /**
   * The ring travels with the cursor — it is a child of the travel node — and
   * fades as it arrives, so the viewer's eye is already at the target when the
   * click lands.
   *
   * Animates `scale` and `opacity` only. The previous version animated `width`,
   * `height` and `margin`, four non-composited properties held for up to 1.5 s
   * during a 60 fps capture — every frame of it a layout.
   */
  #showRing(travelDurationMs: number): void {
    const cfg = this.#style.ring;
    if (!cfg) return;
    const r = this.#ring;

    cancelAnim(r, "transform");
    cancelAnim(r, "opacity");
    r.style.transform = "scale(0.2)";
    r.style.opacity = "0.75";

    const dur = Math.min(cfg.durationMs, travelDurationMs + 200);
    const spec: SpringSpec = { visualDurationMs: dur, bounce: 0 };
    void springTo(r, "transform", "scale(1)", spec, dur);
    void springTo(r, "opacity", 0, spec, dur);
  }

  /**
   * Click feedback: contract and release.
   *
   * On its own element, so it cannot fight the counter-scale — which is exactly
   * what happened when both wrote the same `transform`.
   */
  async click(): Promise<void> {
    const { shrinkTo, ms } = this.#style.click ?? { shrinkTo: 0.8, ms: 130 };
    const spec: SpringSpec = { visualDurationMs: ms, bounce: 0 };
    await springTo(this.#click, "transform", `scale(${shrinkTo})`, spec, ms).finished;
    await springTo(this.#click, "transform", "scale(1)", spec, ms).finished;
  }

  /** Exposed for the e2e: the counter-scale must survive a move. */
  get zoomElement(): HTMLElement {
    return this.#zoom;
  }

  get dotElement(): HTMLElement {
    return this.#dot;
  }
}
