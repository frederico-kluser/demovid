/**
 * The injected overlay. Everything in this directory runs INSIDE the target
 * page, bundled to one IIFE and handed to `page.addInitScript()`.
 *
 * Two isolations, both required and neither substituting for the other:
 *
 *  - **Top layer** (`popover=manual`) isolates from the stage's `transform`.
 *    Guaranteed by CSS Position L4 §3: top-layer elements "generate boxes as if
 *    they were siblings of the root element… Ancestor elements with overflow,
 *    opacity, mask, etc. cannot affect it." Measured: with the stage at 1.6×,
 *    the overlay stayed exactly at its baseline size.
 *  - **Shadow root** isolates from the app's CSS, both directions.
 *
 * `popover`, never `dialog.showModal()` — `showModal` makes the rest of the
 * document inert, which would make the app unclickable.
 */
import { Balloon, type BalloonStyle, type Box } from "./balloon.js";
import { Cursor, type CursorStyle } from "./cursor.js";
import { Sequencer, type ClipRef } from "./sequencer.js";
import { SPOTLIGHT_KEYFRAMES, Spotlight, type SpotlightStyle } from "./spotlight.js";
import type { OverlayApi } from "../../src/overlay-api.js";
import { SPRINGS } from "../../src/generated/springs.js";
import {
  assertOverlayUnscaled,
  camFor,
  cameraTo,
  captureOverlayBaseline,
  fingerprint,
  getCamera,
  localRect,
  mountStage,
  setCamera,
  stageAnimationCount,
  type Camera,
} from "./stage.js";

const HOST_ID = "__demovid_overlay";

export interface OverlayStyle {
  cursor: CursorStyle;
  spotlight: SpotlightStyle;
  balloon: BalloonStyle;
}

/** Fallback so `mount()` with no arguments still produces something usable. */
const DEFAULT_STYLE: OverlayStyle = {
  cursor: {
    dotPx: 20,
    travelFactor: 1.25,
    // The baked Cap "Mellow" constants, so a styleless `mount()` still moves
    // like the product does rather than like a stand-in.
    spring: SPRINGS.cursorMellow,
    accent: "#3B82F6",
    ring: { toPx: 60, strokePx: 6, durationMs: 900 },
  },
  spotlight: {
    dim: 0.55,
    cutoutRadiusPx: 8,
    paddingPx: 12,
    ringPx: 2,
    accent: "#3B82F6",
    pulse: { toScale: 1.06, periodMs: 1200, cycles: 3 },
  },
  balloon: {
    maxWidthPx: 380,
    fontSizePx: 17,
    lineHeight: 1.5,
    fontWeight: 450,
    radiusPx: 12,
    paddingPx: [16, 20],
    bg: "rgba(15,23,42,.97)",
    fg: "#F1F5F9",
    accent: "#3B82F6",
    shadow: "0 1px 1px rgba(0,0,0,.10), 0 2px 3px rgba(0,0,0,.08), 1px 4px 8px rgba(0,0,0,.12)",
    placement: "anchored",
  },
};

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
/** The style `mount()` actually resolved. Read by `cursorBox()`. */
let activeStyle: OverlayStyle | null = null;
let cursor: Cursor | null = null;
let spotlight: Spotlight | null = null;
let balloon: Balloon | null = null;
const sequencer = new Sequencer();

/**
 * Mount the overlay host. Appended to `documentElement` (not `body`) so it is a
 * sibling of the stage even before the popover promotes it — belt and braces.
 */
function mountOverlay(style: OverlayStyle): HTMLElement {
  const existing = document.getElementById(HOST_ID);
  if (existing) return (host = existing);

  const el = document.createElement("div");
  el.id = HOST_ID;
  el.setAttribute("popover", "manual"); // manual: no light-dismiss, no Esc
  // Each declaration cancels one from Chromium's UA sheet for [popover], which
  // otherwise gives us `width:fit-content; margin:auto; border:solid;
  // padding:.25em; overflow:auto; background-color:Canvas`.
  el.style.cssText =
    "position:fixed; inset:0; width:100%; height:100%;" +
    "margin:0; border:0; padding:0; overflow:visible;" +
    "background:transparent; color:inherit; pointer-events:none;";

  document.documentElement.appendChild(el);
  const shadow = el.attachShadow({ mode: "open" }); // open: closed blocks our own tooling

  const sheet = document.createElement("style");
  sheet.textContent =
    ":host { all: initial }\n" +
    "* { box-sizing: border-box }\n" +
    SPOTLIGHT_KEYFRAMES(style.spotlight.pulse?.toScale ?? 1.06);
  shadow.append(sheet);

  el.showPopover();

  // Top-layer order is by activation, with no z-index control. If the app opens
  // its own popover or dialog afterwards, it lands ABOVE us. Re-promote.
  document.addEventListener(
    "toggle",
    (ev) => {
      if (ev.target !== el) repromote();
    },
    true,
  );

  root = shadow;
  activeStyle = style;
  spotlight = new Spotlight(shadow, style.spotlight);
  balloon = new Balloon(shadow, style.balloon);
  cursor = new Cursor(shadow, style.cursor);

  host = el;
  return el;
}

function repromote(): void {
  if (!host?.isConnected) return;
  try {
    host.hidePopover();
    host.showPopover();
  } catch {
    /* already in the desired state */
  }
}

/**
 * Viewport-space footprint of the synthetic cursor, or `null` when it is not on
 * screen yet.
 *
 * The box is the *visual* extent, not the hotspot: the ring is drawn around the
 * dot and reaches `ring.toPx`, so a balloon that only cleared the dot would still
 * land on top of the anticipation ring. `Cursor.position` starts at (-100,-100),
 * which falls outside any viewport and therefore stops overlapping anything on
 * its own — no separate "has it been shown" flag to keep in sync.
 */
function cursorBox(): Box | null {
  if (!cursor || !activeStyle) return null;
  const { x, y } = cursor.position;
  const c = activeStyle.cursor;
  const size = Math.max(c.dotPx, c.ring?.toPx ?? 0);
  return { x: x - size / 2, y: y - size / 2, w: size, h: size };
}

/** Viewport-space rect of a selector. Already camera-transformed by the browser. */
function rectOf(selector: string): Box | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

/** Everything the driver calls, exposed on one global. */
const api = {
  /**
   * Mount, and report what actually happened — never a hardcoded `true`.
   * An earlier version returned `{stage:true,overlay:true}` unconditionally; a
   * flaky run then failed three steps later with "cannot read scrollTo of null",
   * because a caller had been told the stage existed when it did not. A mount
   * that cannot fail visibly is a mount you debug from the wrong end.
   */
  mount(style?: OverlayStyle): { stage: boolean; overlay: boolean; adopted: number; why?: string } {
    if (!document.body) return { stage: false, overlay: false, adopted: 0, why: "document.body ainda não existe" };
    const st = mountStage();
    const el = mountOverlay(style ?? DEFAULT_STYLE);
    // Camera is at identity right now — this is the only correct moment to
    // record what "unscaled" looks like.
    captureOverlayBaseline(el);
    return {
      stage: st.isConnected && document.getElementById("__demovid_stage") === st,
      overlay: el.isConnected,
      adopted: st.childElementCount,
    };
  },

  repromote,
  fingerprint,
  getCamera,
  setCamera,
  stageAnimationCount,

  /**
   * Animate the camera and resolve when it has settled.
   *
   * The driver used to write `stage.style.transition` itself and then sleep for
   * a guessed duration. Owning the animation here means the promise is the
   * truth, and nothing is left parked on the stage afterwards.
   */
  cameraTo(c: Camera, spring: { stiffness: number; damping: number; mass: number }, hintMs?: number): Promise<void> {
    return cameraTo(c, spring, hintMs);
  },

  assertUnscaled(): { ok: boolean; detail: string } {
    if (!host) return { ok: false, detail: "overlay não montado" };
    return assertOverlayUnscaled(host);
  },

  /** Camera state that centres `selector` at zoom `k`. Does not apply it. */
  cameraFor(selector: string, k: number): { tx: number; ty: number; k: number } | null {
    const el = document.querySelector(selector);
    if (!el) return null;
    return camFor(localRect(el), k, window.innerWidth, window.innerHeight);
  },

  rectOf,

  // ── overlay ──────────────────────────────────────────────────────────────
  spotlightOn(selector: string): boolean {
    const r = rectOf(selector);
    if (!r || !spotlight) return false;
    spotlight.moveTo(r);
    return true;
  },
  spotlightOff(): void {
    spotlight?.hide();
  },

  say(text: string, selector?: string): void {
    balloon?.show(text, selector ? rectOf(selector) : null, cursorBox());
  },
  hush(): void {
    balloon?.hide();
  },

  showCursor(): void {
    cursor?.show();
  },
  hideCursor(): void {
    cursor?.hide();
  },
  cursorTo(x: number, y: number, targetW?: number): Promise<void> {
    return cursor?.moveTo(x, y, targetW) ?? Promise.resolve();
  },
  cursorPlace(x: number, y: number): void {
    cursor?.placeAt(x, y);
  },
  cursorClick(): Promise<void> {
    return cursor?.click() ?? Promise.resolve();
  },
  cursorZoom(k: number): void {
    cursor?.setStageZoom(k);
  },

  // ── narração ─────────────────────────────────────────────────────────────
  preloadClip(clip: ClipRef): Promise<void> {
    return sequencer.preload(clip);
  },
  playClip(clip: ClipRef, index: number): Promise<"ended" | "timeout" | "error"> {
    return sequencer.play(clip, index);
  },
  releaseClip(src: string): void {
    sequencer.release(src);
  },
  sequencerEvents(): readonly unknown[] {
    return sequencer.events;
  },

  get shadow(): ShadowRoot | null {
    return root;
  },
};

// `satisfies` e não `:` — o objeto guarda os tipos concretos de retorno para
// quem usa aqui dentro, mas qualquer método que suma ou mude de assinatura
// quebra o build em vez de falhar dentro do browser, onde o stack trace é inútil.
const _contract = api satisfies OverlayApi;
void _contract;

window.__demovid = api;

export type DemovidApi = typeof api;
export default api;
