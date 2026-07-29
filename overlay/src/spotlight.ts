/**
 * The spotlight: dim everything except the target.
 *
 * Uses an SVG path with a cut-out and `fill-rule: evenodd` — the technique
 * driver.js ships (MIT, ~7 KB gzip), verified by grepping their bundle: they
 * call `createElementNS(...)`, not a giant `box-shadow`.
 *
 * Why not the alternatives:
 *  - `box-shadow: 0 0 0 9999px rgba(0,0,0,.5)` (what Screenity does) is simpler
 *    but only ever cuts ONE rectangle and the `d` attribute cannot be animated.
 *  - `backdrop-filter: blur()` looks nice but is expensive to composite, and at
 *    60 fps during a screen recording it costs frames.
 *  - Popover `::backdrop` dims the whole viewport with no cut-out at all.
 *
 * The `d` attribute animates, so moving the spotlight from one element to
 * another is a single transition rather than a fade-out/fade-in.
 */
const NS = "http://www.w3.org/2000/svg";

export interface SpotlightStyle {
  dim: number;
  cutoutRadiusPx: number;
  paddingPx: number;
  ringPx: number;
  accent: string;
  pulse: { toScale: number; periodMs: number; cycles: number } | null;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Outer viewport rect plus an inner rounded rect, wound so `evenodd` punches the
 * hole. Corner radius is clamped to half the smaller side, otherwise the arcs
 * cross over each other and the shape inverts.
 */
export function cutoutPath(box: Box, radius: number, W: number, H: number): string {
  const r = Math.max(0, Math.min(radius, box.w / 2, box.h / 2));
  const { x, y, w, h } = box;
  return (
    `M0,0 H${W} V${H} H0 Z ` +
    `M${x + r},${y} ` +
    `H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} ` +
    `V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} ` +
    `H${x + r} A${r},${r} 0 0 1 ${x},${y + h - r} ` +
    `V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`
  );
}

export class Spotlight {
  #svg: SVGSVGElement;
  #path: SVGPathElement;
  #ring: SVGRectElement;
  #style: SpotlightStyle;
  #visible = false;

  constructor(root: ShadowRoot, style: SpotlightStyle) {
    this.#style = style;

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.cssText = "position:fixed; inset:0; pointer-events:none; opacity:0;" +
      "transition:opacity 200ms cubic-bezier(0,0,0,1);";

    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", `rgba(0,0,0,${style.dim})`);
    path.setAttribute("fill-rule", "evenodd");
    // The `d` transition is what makes the spotlight glide between targets
    // instead of blinking. Chromium interpolates path data when the command
    // sequence matches — which ours always does, by construction.
    path.style.transition = "d 420ms cubic-bezier(.4,0,.2,1)";

    const ring = document.createElementNS(NS, "rect");
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", style.accent);
    ring.setAttribute("stroke-width", String(style.ringPx));
    ring.style.cssText = "opacity:.9; transform-box:fill-box; transform-origin:center;" +
      "transition:x 420ms cubic-bezier(.4,0,.2,1), y 420ms cubic-bezier(.4,0,.2,1)," +
      "width 420ms cubic-bezier(.4,0,.2,1), height 420ms cubic-bezier(.4,0,.2,1);";

    svg.append(path, ring);
    root.append(svg);
    this.#svg = svg;
    this.#path = path;
    this.#ring = ring;
  }

  /** Aim at a viewport-space rect. Coordinates come from `getBoundingClientRect`. */
  moveTo(rect: Box): void {
    const pad = this.#style.paddingPx;
    // A target under ~24px reads as noise on video. Inflate it so the highlight
    // is visible without lying about where the element is.
    const w = Math.max(rect.w + pad * 2, 32);
    const h = Math.max(rect.h + pad * 2, 32);
    const box: Box = {
      x: rect.x - pad - (w - rect.w - pad * 2) / 2,
      y: rect.y - pad - (h - rect.h - pad * 2) / 2,
      w,
      h,
    };

    const W = document.documentElement.clientWidth;
    const H = document.documentElement.clientHeight;
    this.#path.setAttribute("d", cutoutPath(box, this.#style.cutoutRadiusPx, W, H));

    const r = Math.max(0, Math.min(this.#style.cutoutRadiusPx, box.w / 2, box.h / 2));
    this.#ring.setAttribute("x", String(box.x));
    this.#ring.setAttribute("y", String(box.y));
    this.#ring.setAttribute("width", String(box.w));
    this.#ring.setAttribute("height", String(box.h));
    this.#ring.setAttribute("rx", String(r));

    if (!this.#visible) {
      this.#svg.style.opacity = "1";
      this.#visible = true;
    }
    this.#startPulse();
  }

  /**
   * Pulse a fixed number of cycles, then hold static.
   *
   * WCAG 2.2.2 requires a control for anything moving past five seconds, and a
   * recorded video offers no controls — so the motion has to stop on its own.
   * The 1200ms period also sits between visionOS's 0.2 Hz nausea band and the
   * WCAG 3 Hz flash limit.
   */
  #startPulse(): void {
    const p = this.#style.pulse;
    this.#ring.style.animation = "none";
    if (!p) return;
    void this.#ring.getBoundingClientRect(); // reflow, so re-assigning restarts it
    this.#ring.style.animation = `demovid-pulse ${p.periodMs}ms ease-in-out ${p.cycles}`;
  }

  hide(): void {
    this.#svg.style.opacity = "0";
    this.#visible = false;
    this.#ring.style.animation = "none";
  }
}

export const SPOTLIGHT_KEYFRAMES = (toScale: number): string =>
  `@keyframes demovid-pulse {
     0%, 100% { transform: scale(1); opacity: .9 }
     50%      { transform: scale(${toScale}); opacity: .55 }
   }`;
