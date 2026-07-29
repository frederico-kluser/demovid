/**
 * The speech balloon.
 *
 * Positioned in JS from `getBoundingClientRect`, on purpose, rather than with
 * CSS anchor positioning. Two reasons, both measured or spec'd:
 *
 *  - `anchor-name` must be declared in the *same tree* as the reference. The
 *    balloon lives in a shadow root and the anchor is in the light DOM, so the
 *    reference crosses the shadow boundary and the anchor is simply invalid.
 *  - `getBoundingClientRect` on an element inside the transformed stage already
 *    returns the *transformed* rect. So JS positioning tracks the camera for
 *    free, with no counter-transform maths anywhere.
 *
 * Floating UI would also work and is only ~6 KB gzip, but its `autoUpdate` runs
 * on ResizeObserver/IntersectionObserver/rAF — async reflow in the middle of a
 * frame is exactly what a recorder does not want. We take its vocabulary
 * (offset / shift / flip / arrow / hide) and none of its scheduling.
 */
import { cancelAnim, springTo } from "./anim.js";

export interface BalloonStyle {
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
  placement: "anchored" | "docked-bottom-left" | "lower-third";
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Side = "bottom" | "top" | "right" | "left";

const GAP = 14;
/** Viewport margin for the clamp. Below this the balloon reads as falling off. */
const MARGIN = 16;
const TAIL = 12;

export class Balloon {
  #el: HTMLElement;
  #tail: HTMLElement;
  #style: BalloonStyle;
  /** Where the balloon currently is. Position lives in `transform`, not `left`/`top`. */
  #x = 0;
  #y = 0;

  constructor(root: ShadowRoot, style: BalloonStyle) {
    this.#style = style;

    const el = document.createElement("div");
    el.className = "demovid-balloon";
    el.style.cssText =
      `position:fixed; left:0; top:0; box-sizing:border-box;` +
      `max-width:${style.maxWidthPx}px; padding:${style.paddingPx[0]}px ${style.paddingPx[1]}px;` +
      `border-radius:${style.radiusPx}px; background:${style.bg}; color:${style.fg};` +
      `font:${style.fontWeight} ${style.fontSizePx}px/${style.lineHeight} ` +
      `Inter, -apple-system, "Segoe UI", system-ui, sans-serif;` +
      `box-shadow:${style.shadow}; backdrop-filter:blur(1px);` +
      `opacity:0; transform:translate3d(0,0,0); pointer-events:none;` +
      // Navattic ships exactly this entrance for everything: fade + 20px rise,
      // 200ms. Arcade removed its scale-in. Exits are shorter than entrances.
      `transition:opacity 200ms cubic-bezier(0,0,0,1), transform 200ms cubic-bezier(0,0,0,1);`;

    const tail = document.createElement("div");
    tail.style.cssText = `position:fixed; width:0; height:0; opacity:0; pointer-events:none;` +
      `transition:opacity 200ms ease;`;

    root.append(tail, el);
    this.#el = el;
    this.#tail = tail;
  }

  /**
   * Show `text` pointing at `anchor`.
   *
   * Placement order tries vertical first for wide targets and horizontal for
   * tall ones — a balloon under a full-width toolbar is fine; a balloon under a
   * tall sidebar is nonsense.
   */
  show(text: string, anchor: Box | null): void {
    this.#el.textContent = text;

    if (this.#style.placement === "lower-third" || !anchor) {
      this.#dock("lower-third");
      return;
    }
    if (this.#style.placement === "docked-bottom-left") {
      this.#dock("docked-bottom-left");
      return;
    }

    // Measure with the final text in place, before positioning.
    //
    // `offsetWidth`/`offsetHeight` and NOT `getBoundingClientRect`: the rect is
    // transform-aware, so an enter animation still in flight would report a
    // scaled or displaced box and corrupt the placement search. The offsets are
    // layout-box numbers and do not care what the element is doing visually.
    this.#el.style.visibility = "hidden";
    const bw = this.#el.offsetWidth;
    const bh = this.#el.offsetHeight;

    const W = document.documentElement.clientWidth;
    const H = document.documentElement.clientHeight;
    const order: Side[] = anchor.w >= anchor.h ? ["bottom", "top", "right", "left"] : ["right", "left", "bottom", "top"];

    let chosen: { side: Side; x: number; y: number } | null = null;
    for (const side of order) {
      const p = place(side, anchor, bw, bh);
      // Never cover the element being described — that is the one placement that
      // defeats the whole point.
      if (overlaps(p, bw, bh, anchor)) continue;
      if (p.x >= MARGIN && p.y >= MARGIN && p.x + bw <= W - MARGIN && p.y + bh <= H - MARGIN) {
        chosen = { side, ...p };
        break;
      }
    }

    if (!chosen) {
      // Every side either collides with the anchor or leaves the viewport. That
      // happens with very large targets (a full-width table). Docking with no
      // tail degrades gracefully — it is what Arcade and Storylane do too.
      this.#dock("docked-bottom-left");
      return;
    }

    const x = clamp(chosen.x, MARGIN, W - bw - MARGIN);
    const y = clamp(chosen.y, MARGIN, H - bh - MARGIN);

    this.#el.style.visibility = "visible";
    this.#moveTo(x, y, () => this.#drawTail(chosen.side, x, y, bw, bh, anchor));
  }

  /**
   * Position the balloon, gliding when it is already on screen.
   *
   * Position lives in `transform`, not `left`/`top`, precisely so this can be
   * animated: a `say()` aimed at a new element used to teleport the balloon
   * across the frame in one frame, which on a 60fps capture reads as a glitch
   * rather than a movement.
   *
   * The tail is hidden for the duration and redrawn on arrival — a triangle
   * sliding independently of the box it belongs to looks broken, and it is
   * cheaper to hide it than to animate a second element in lockstep.
   */
  #moveTo(x: number, y: number, onArrive: () => void): void {
    const el = this.#el;
    const visible = getComputedStyle(el).opacity !== "0";
    this.#x = x;
    this.#y = y;
    const spec = { visualDurationMs: visible ? 380 : 240, bounce: visible ? 0.08 : 0 };

    if (!visible) {
      // Enter: rise into place. Set the start state without animating.
      cancelAnim(el, "transform");
      el.style.transform = `translate3d(${x}px, ${y + 14}px, 0)`;
    } else {
      this.#tail.style.opacity = "0";
    }

    void springTo(el, "opacity", 1, spec, 300);
    void springTo(el, "transform", `translate3d(${x}px, ${y}px, 0)`, spec, 500).finished.then(
      onArrive,
    );
  }

  #dock(where: "docked-bottom-left" | "lower-third"): void {
    const W = document.documentElement.clientWidth;
    const H = document.documentElement.clientHeight;
    this.#el.style.visibility = "visible";
    this.#tail.style.opacity = "0";
    const bw = this.#el.offsetWidth;
    const bh = this.#el.offsetHeight;

    const x = where === "lower-third" ? Math.round((W - bw) / 2) : MARGIN * 2;
    const y = where === "lower-third" ? Math.round(H * 0.72) : H - bh - MARGIN * 2;
    this.#moveTo(x, y, () => {});
  }

  /**
   * A CSS-triangle tail. Dropped entirely when the viewport clamp moved the
   * balloon so far that the tail could no longer reach the anchor — a tail
   * pointing at nothing is worse than no tail.
   */
  #drawTail(side: Side, bx: number, by: number, bw: number, bh: number, anchor: Box): void {
    const ax = anchor.x + anchor.w / 2;
    const ay = anchor.y + anchor.h / 2;
    const c = this.#style.bg;
    const t = this.#tail;

    const reachableX = ax > bx + TAIL && ax < bx + bw - TAIL;
    const reachableY = ay > by + TAIL && ay < by + bh - TAIL;

    if ((side === "bottom" || side === "top") && !reachableX) return void (t.style.opacity = "0");
    if ((side === "left" || side === "right") && !reachableY) return void (t.style.opacity = "0");

    // Explicit property writes, never `cssText +=`. Appending grew the
    // declaration on every single `say()` — after a twenty-step demo the tail
    // carried twenty stale copies of every border rule, and the winner was
    // whichever happened to be last.
    const border = `${TAIL}px solid transparent`;
    const set = (
      left: number,
      top: number,
      borders: Partial<Record<"borderLeft" | "borderRight" | "borderTop" | "borderBottom", string>>,
    ): void => {
      t.style.left = `${left}px`;
      t.style.top = `${top}px`;
      t.style.borderLeft = borders.borderLeft ?? "0";
      t.style.borderRight = borders.borderRight ?? "0";
      t.style.borderTop = borders.borderTop ?? "0";
      t.style.borderBottom = borders.borderBottom ?? "0";
    };

    const solid = `${TAIL}px solid ${c}`;
    if (side === "bottom") {
      set(ax - TAIL, by - TAIL, { borderLeft: border, borderRight: border, borderBottom: solid });
    } else if (side === "top") {
      set(ax - TAIL, by + bh, { borderLeft: border, borderRight: border, borderTop: solid });
    } else if (side === "right") {
      set(bx - TAIL, ay - TAIL, { borderTop: border, borderBottom: border, borderRight: solid });
    } else {
      set(bx + bw, ay - TAIL, { borderTop: border, borderBottom: border, borderLeft: solid });
    }
    t.style.opacity = "1";
  }

  /**
   * Fade out where it stands.
   *
   * Deliberately NOT a reset to the origin: position lives in `transform` now,
   * so resetting it would send the balloon flying to the top-left corner as it
   * faded — a very visible artifact at the end of every step.
   */
  hide(): void {
    const spec = { visualDurationMs: 180, bounce: 0 };
    this.#tail.style.opacity = "0";
    void springTo(this.#el, "opacity", 0, spec, 240);
    void springTo(this.#el, "transform", `translate3d(${this.#x}px, ${this.#y + 10}px, 0)`, spec, 240);
  }
}

function place(side: Side, a: Box, bw: number, bh: number): { x: number; y: number } {
  switch (side) {
    case "bottom":
      return { x: a.x + a.w / 2 - bw / 2, y: a.y + a.h + GAP };
    case "top":
      return { x: a.x + a.w / 2 - bw / 2, y: a.y - bh - GAP };
    case "right":
      return { x: a.x + a.w + GAP, y: a.y + a.h / 2 - bh / 2 };
    case "left":
      return { x: a.x - bw - GAP, y: a.y + a.h / 2 - bh / 2 };
  }
}

function overlaps(p: { x: number; y: number }, bw: number, bh: number, a: Box): boolean {
  return p.x < a.x + a.w && p.x + bw > a.x && p.y < a.y + a.h && p.y + bh > a.y;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
