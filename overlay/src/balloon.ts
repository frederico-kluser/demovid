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
      `opacity:0; transform:translate3d(0,20px,0); pointer-events:none;` +
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
    this.#el.style.visibility = "hidden";
    this.#el.style.opacity = "0";
    this.#el.style.transform = "translate3d(0,0,0)";
    const { width: bw, height: bh } = this.#el.getBoundingClientRect();

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
    this.#el.style.left = `${x}px`;
    this.#el.style.top = `${y}px`;
    this.#el.style.transform = "translate3d(0,20px,0)";
    void this.#el.offsetWidth;
    this.#el.style.opacity = "1";
    this.#el.style.transform = "translate3d(0,0,0)";

    this.#drawTail(chosen.side, x, y, bw, bh, anchor);
  }

  #dock(where: "docked-bottom-left" | "lower-third"): void {
    const W = document.documentElement.clientWidth;
    const H = document.documentElement.clientHeight;
    this.#el.style.visibility = "visible";
    this.#tail.style.opacity = "0";
    this.#el.style.transform = "translate3d(0,0,0)";
    const { width: bw, height: bh } = this.#el.getBoundingClientRect();

    if (where === "lower-third") {
      this.#el.style.left = `${Math.round((W - bw) / 2)}px`;
      this.#el.style.top = `${Math.round(H * 0.72)}px`;
    } else {
      this.#el.style.left = `${MARGIN * 2}px`;
      this.#el.style.top = `${H - bh - MARGIN * 2}px`;
    }
    this.#el.style.transform = "translate3d(0,20px,0)";
    void this.#el.offsetWidth;
    this.#el.style.opacity = "1";
    this.#el.style.transform = "translate3d(0,0,0)";
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

    const border = `${TAIL}px solid transparent`;
    if (side === "bottom") {
      t.style.cssText += `;left:${ax - TAIL}px; top:${by - TAIL}px;` +
        `border-left:${border}; border-right:${border}; border-bottom:${TAIL}px solid ${c}; border-top:0;`;
    } else if (side === "top") {
      t.style.cssText += `;left:${ax - TAIL}px; top:${by + bh}px;` +
        `border-left:${border}; border-right:${border}; border-top:${TAIL}px solid ${c}; border-bottom:0;`;
    } else if (side === "right") {
      t.style.cssText += `;left:${bx - TAIL}px; top:${ay - TAIL}px;` +
        `border-top:${border}; border-bottom:${border}; border-right:${TAIL}px solid ${c}; border-left:0;`;
    } else {
      t.style.cssText += `;left:${bx + bw}px; top:${ay - TAIL}px;` +
        `border-top:${border}; border-bottom:${border}; border-left:${TAIL}px solid ${c}; border-right:0;`;
    }
    t.style.opacity = "1";
  }

  hide(): void {
    this.#el.style.opacity = "0";
    this.#el.style.transform = "translate3d(0,20px,0)";
    this.#tail.style.opacity = "0";
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
