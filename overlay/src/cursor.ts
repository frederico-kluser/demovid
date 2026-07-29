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
 *    the opposite of what a demo wants. We aim at centres, deliberately.
 *  - **Easing**: Cap's springs, baked to CSS `linear()` at build time.
 *  - **Click feedback**: contract to 80 % over 130 ms (Cap `CURSOR_CLICK_DURATION`
 *    + `CLICK_SHRINK_SIZE`). It contracts; it is NOT a ripple. Screen Studio
 *    ships ripple/shockwave as separate opt-in effects on top.
 *
 * The travelling ring is the other half: interactive-demo tools (Storylane) use
 * an expanding ring as an *affordance* ("click here"), recorders use the contract
 * as *feedback* ("a click happened"). A narrated demo needs both, at different
 * moments — ring while travelling, contract at the instant of the click.
 */
import type { BakedSpring } from "../../src/generated/springs.js";

export interface CursorStyle {
  dotPx: number;
  travelFactor: number;
  spring: BakedSpring;
  accent: string;
  ring: { toPx: number; strokePx: number; durationMs: number } | null;
}

/** Fitts's Law. MacKenzie's constants; `W` is the target's smaller dimension. */
export function travelMs(distance: number, targetW: number, factor: number): number {
  const w = Math.max(8, targetW);
  const ms = 230 + 166 * Math.log2(distance / w + 1);
  return Math.round(ms * factor);
}

export class Cursor {
  #dot: HTMLElement;
  #ring: HTMLElement;
  #style: CursorStyle;
  #x = -100;
  #y = -100;

  constructor(root: ShadowRoot, style: CursorStyle) {
    this.#style = style;

    const dot = document.createElement("div");
    dot.className = "demovid-cursor";
    dot.style.cssText =
      `position:fixed; left:0; top:0; width:${style.dotPx}px; height:${style.dotPx}px;` +
      `margin-left:${-style.dotPx / 2}px; margin-top:${-style.dotPx / 2}px;` +
      `border-radius:50%; background:${style.accent}; opacity:0;` +
      `box-shadow:0 1px 3px rgba(0,0,0,.35), 0 0 0 2px rgba(255,255,255,.9);` +
      `pointer-events:none; will-change:transform;` +
      `transform:translate3d(-100px,-100px,0) scale(1);`;

    const ring = document.createElement("div");
    ring.className = "demovid-cursor-ring";
    ring.style.cssText =
      `position:fixed; left:0; top:0; border-radius:50%; opacity:0;` +
      `border:${style.ring?.strokePx ?? 0}px solid ${style.accent}; pointer-events:none;`;

    root.append(ring, dot);
    this.#dot = dot;
    this.#ring = ring;
  }

  get position(): { x: number; y: number } {
    return { x: this.#x, y: this.#y };
  }

  show(): void {
    this.#dot.style.opacity = "1";
  }

  hide(): void {
    this.#dot.style.opacity = "0";
    this.#ring.style.opacity = "0";
  }

  /**
   * Counter-scale so the cursor stays legible while the stage zooms.
   *
   * `sqrt(k)`, not `1/k`. `supercut`'s reasoning, and it is right: a cursor held
   * at exactly constant size detaches visually from the content it is pointing
   * at. Balloons want `1.0` — they are chrome. The cursor is halfway between
   * chrome and content, so it grows a little.
   */
  setStageZoom(k: number): void {
    const s = 1 / Math.sqrt(Math.max(1, k));
    this.#dot.style.setProperty("--demovid-cursor-counter", String(s));
    this.#dot.style.transform = `translate3d(${this.#x}px, ${this.#y}px, 0) scale(${s})`;
  }

  /** Jump with no animation. For the first placement, before the cursor is shown. */
  placeAt(x: number, y: number): void {
    this.#x = x;
    this.#y = y;
    this.#dot.style.transition = "none";
    this.#dot.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1)`;
    void this.#dot.offsetWidth;
  }

  /** Glide to a point. Resolves when it arrives. */
  moveTo(x: number, y: number, targetW = 40): Promise<void> {
    const d = Math.hypot(x - this.#x, y - this.#y);
    const ms = travelMs(d, targetW, this.#style.travelFactor);

    this.#x = x;
    this.#y = y;
    this.#dot.style.transition = `transform ${ms}ms ${this.#style.spring.easing}`;
    this.#dot.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1)`;

    this.#showRing(x, y, ms);
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * The ring travels with the cursor and fades as it arrives — anticipation, so
   * the viewer's eye is already at the target when the click lands.
   */
  #showRing(x: number, y: number, travelDurationMs: number): void {
    const cfg = this.#style.ring;
    if (!cfg) return;
    const r = this.#ring;
    r.style.transition = "none";
    r.style.width = `${this.#style.dotPx}px`;
    r.style.height = `${this.#style.dotPx}px`;
    r.style.marginLeft = `${-this.#style.dotPx / 2}px`;
    r.style.marginTop = `${-this.#style.dotPx / 2}px`;
    r.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    r.style.opacity = "0.75";
    void r.offsetWidth;

    const dur = Math.min(cfg.durationMs, travelDurationMs + 200);
    r.style.transition = `width ${dur}ms ease-out, height ${dur}ms ease-out,` +
      `margin ${dur}ms ease-out, opacity ${dur}ms ease-out`;
    r.style.width = `${cfg.toPx}px`;
    r.style.height = `${cfg.toPx}px`;
    r.style.marginLeft = `${-cfg.toPx / 2}px`;
    r.style.marginTop = `${-cfg.toPx / 2}px`;
    r.style.opacity = "0";
  }

  /**
   * Click feedback: contract to 80 % and back, 130 ms.
   *
   * Two bugs from Screenity's implementation are deliberately avoided here. They
   * reset the transform at 350 ms while opacity is still fading to 0 at 500 ms,
   * so their ring visibly re-expands during its last ~150 ms — we hold the reset
   * until the full duration. And their at-rest transform is `none` rather than a
   * centring translate, so their first click jumps by half the ring's size — our
   * transform always carries the position.
   */
  async click(): Promise<void> {
    const base = `translate3d(${this.#x}px, ${this.#y}px, 0)`;
    this.#dot.style.transition = "transform 130ms cubic-bezier(.25,.8,.25,1)";
    this.#dot.style.transform = `${base} scale(0.8)`;
    await new Promise((r) => setTimeout(r, 130));
    this.#dot.style.transform = `${base} scale(1)`;
    await new Promise((r) => setTimeout(r, 130));
  }
}
