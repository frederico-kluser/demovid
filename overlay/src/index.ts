/**
 * The injected overlay. Everything in this directory runs INSIDE the target
 * page, bundled to one IIFE and handed to `page.addInitScript()`.
 *
 * Two isolations, both required and neither substituting for the other:
 *
 *  - **Top layer** (`popover=manual`) isolates from the stage's `transform`.
 *    Guaranteed by CSS Position L4 §3: top-layer elements "generate boxes as if
 *    they were siblings of the root element… Ancestor elements with overflow,
 *    opacity, mask, etc. cannot affect it." Measured: with the stage at 1.5×,
 *    the overlay stayed 1353px wide while the stage content was at 2007px.
 *  - **Shadow root** isolates from the app's CSS, both directions.
 *
 * `popover`, never `dialog.showModal()` — `showModal` makes the rest of the
 * document inert, which would make the app unclickable.
 */
import {
  assertOverlayUnscaled,
  camFor,
  captureOverlayBaseline,
  fingerprint,
  getCamera,
  localRect,
  mountStage,
  setCamera,
  type Camera,
} from "./stage.js";

const HOST_ID = "__demovid_overlay";

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;

/**
 * Mount the overlay host. Appended to `documentElement` (not `body`) so it is a
 * sibling of the stage even before the popover promotes it — belt and braces.
 */
function mountOverlay(): HTMLElement {
  const existing = document.getElementById(HOST_ID);
  if (existing) return (host = existing);

  const el = document.createElement("div");
  el.id = HOST_ID;
  el.setAttribute("popover", "manual"); // manual: no light-dismiss, no Esc
  // Each declaration cancels one from Chromium's UA sheet for [popover], which
  // otherwise gives us `width:fit-content; margin:auto; border:solid; padding:.25em;
  // overflow:auto; background-color:Canvas`.
  el.style.cssText =
    "position:fixed; inset:0; width:100%; height:100%;" +
    "margin:0; border:0; padding:0; overflow:visible;" +
    "background:transparent; color:inherit; pointer-events:none;";

  document.documentElement.appendChild(el);
  root = el.attachShadow({ mode: "open" }); // open: closed blocks our own tooling
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

/** Everything the driver calls, exposed on one global. */
const api = {
  /**
   * Mount, and report what actually happened — never a hardcoded `true`.
   * An earlier version returned `{stage:true,overlay:true}` unconditionally; a
   * flaky run then failed three steps later with "cannot read scrollTo of null",
   * because a caller had been told the stage existed when it did not. A mount
   * that cannot fail visibly is a mount you debug from the wrong end.
   */
  mount(): { stage: boolean; overlay: boolean; adopted: number; why?: string } {
    if (!document.body) return { stage: false, overlay: false, adopted: 0, why: "document.body ainda não existe" };
    const st = mountStage();
    const el = mountOverlay();
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
  assertUnscaled(): { ok: boolean; detail: string } {
    if (!host) return { ok: false, detail: "overlay não montado" };
    return assertOverlayUnscaled(host);
  },
  /** Camera state that centres `selector` at zoom `k`. Does not apply it. */
  cameraFor(selector: string, k: number): Camera | null {
    const el = document.querySelector(selector);
    if (!el) return null;
    return camFor(localRect(el), k, window.innerWidth, window.innerHeight);
  },
  get shadow(): ShadowRoot | null {
    return root;
  },
};

declare global {
  interface Window {
    __demovid?: typeof api;
  }
}

window.__demovid = api;

export type DemovidApi = typeof api;
export default api;
