/**
 * Decides the window to open and whether the result needs a scale pass.
 *
 * The constraint that shapes this module: capture is of a real OS window, so
 * the video's pixels are physical pixels. On the reference machine the tallest
 * usable content box is 1531px, which means a 1080x1920 portrait video — the
 * Reels/Shorts format — *cannot* be captured natively. Pretending otherwise
 * would silently deliver a 9:16 video letterboxed inside a landscape frame.
 *
 * So: capture the largest window with the requested aspect ratio that actually
 * fits, and scale once at the end when the target is bigger. A target that
 * already fits gets no post-processing at all, which keeps the one-pass promise
 * for every landscape format.
 *
 * `deviceScaleFactor` is the lever that keeps the upscale from looking soft.
 * With `--force-device-scale-factor=k`, an 882px-wide window renders a 390 CSS
 * px viewport at 2.26x — the text is rasterised for the destination size, so
 * the final scale resamples an already-dense image rather than magnifying a
 * coarse one.
 */
import { devices } from "playwright-core";
import {
  pickMonitor,
  usableContentBox,
  type FrameExtents,
  type Monitor,
  type Rect,
} from "./x11.js";

export interface ResolutionPreset {
  w: number;
  h: number;
  /**
   * CSS pixels the app should see across. Absent means "same as `w`", i.e. a
   * device scale factor of 1 — the desktop case.
   */
  cssWidth?: number;
  /** Emulate a touch device: touch events, mobile UA, no hover. */
  mobile?: boolean;
  label: string;
}

/**
 * The named formats. Deliberately short: every entry has to be a shape someone
 * actually publishes, or it is just a number that invites a wrong choice.
 */
export const RESOLUTIONS: Record<string, ResolutionPreset> = {
  "720p": { w: 1280, h: 720, label: "720p paisagem" },
  "1080p": { w: 1920, h: 1080, label: "1080p paisagem" },
  "1440p": { w: 2560, h: 1440, label: "1440p paisagem" },
  desktop: { w: 1600, h: 1000, label: "janela de desktop" },
  square: { w: 1080, h: 1080, label: "quadrado (feed)" },
  reels: { w: 1080, h: 1920, cssWidth: 390, mobile: true, label: "9:16 vertical (Reels/Shorts/TikTok)" },
  mobile: { w: 720, h: 1280, cssWidth: 360, mobile: true, label: "9:16 vertical, mais leve" },
  tablet: { w: 1536, h: 2048, cssWidth: 768, mobile: true, label: "tablet retrato" },
};

/** `1920x1080`, a preset name, or a Playwright device name. */
export function parseResolutionSpec(spec: string): ResolutionPreset | null {
  const preset = RESOLUTIONS[spec.toLowerCase()];
  if (preset) return preset;

  const wh = /^(\d{2,5})x(\d{2,5})$/i.exec(spec.trim());
  if (wh?.[1] && wh[2]) {
    const w = Number(wh[1]);
    const h = Number(wh[2]);
    return { w, h, label: `${w}x${h}` };
  }

  return deviceToPreset(spec);
}

/**
 * Turn a Playwright device into a target.
 *
 * Its `viewport` is in CSS pixels and its `deviceScaleFactor` is the phone's
 * real density, so their product is the phone's actual screen resolution —
 * which is the video we want.
 */
export function deviceToPreset(name: string): ResolutionPreset | null {
  const d = devices[name];
  if (!d) return null;
  const dsf = d.deviceScaleFactor || 1;
  return {
    w: Math.round(d.viewport.width * dsf),
    h: Math.round(d.viewport.height * dsf),
    cssWidth: d.viewport.width,
    mobile: d.isMobile,
    label: name,
  };
}

export interface CapturePlan {
  /** What the user asked for; the final file will be exactly this. */
  target: { w: number; h: number };
  /** The OS window to open, in physical pixels. */
  window: { w: number; h: number; x: number; y: number };
  /**
   * The box on the chosen monitor the window may occupy — the monitor clipped to
   * `_NET_WORKAREA`, minus the WM's decoration.
   *
   * Published because `window` describes the CONTENT and the real OS window is
   * content **plus the browser's own UI**, whose height is only knowable after
   * launch. Whoever measures that height clamps against this box; a hardcoded
   * allowance here was tried and was wrong on the first machine that ran it (see
   * `chromeHeightPx` in `src/browser.ts`).
   */
  usable: Rect;
  /** Launch-flag density. Always 1 for mobile — see below. */
  deviceScaleFactor: number;
  /** What the page will believe its viewport is, in CSS pixels. */
  cssViewport: { w: number; h: number };
  mobile: boolean;
  /**
   * CSS width the app must see when emulating a phone. The physical size of
   * that viewport is only decided after launch, because it depends on how tall
   * the browser's own UI turned out to be.
   *
   * Measured, and the reason mobile does not simply open a narrow window:
   * **Chromium refuses to make a window narrower than roughly 500 logical
   * pixels.** Asking for a 390px-wide window silently produces a ~532px one, so
   * the app is never actually phone-width and blind-cropping the sides cuts
   * content off. The fix is to emulate the viewport over CDP inside a
   * comfortably sized window, then crop the video to exactly that viewport —
   * which is what DevTools device mode does.
   */
  cssWidth?: number;
  /** True when a final ffmpeg scale is required to reach `target`. */
  scaleNeeded: boolean;
  monitor: string;
  label: string;
  warnings: string[];
}

/** Encoders reject odd dimensions; always land on an even number. */
const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

export interface PlanOptions {
  monitors: Monitor[];
  area: Rect | null;
  frame: FrameExtents;
  /** Restrict to a named output. */
  monitorName?: string;
}

export function planCapture(target: ResolutionPreset, opts: PlanOptions): CapturePlan {
  const warnings: string[] = [];
  const monitor = pickMonitor(opts.monitors, opts.monitorName);

  if (!monitor) {
    // Honour the request literally and let the window manager clamp — better
    // than inventing a box out of nothing. Two different ways to get here, and
    // saying the wrong one sends the reader to the wrong place:
    //
    //  - the monitor list is EMPTY: no X11 information at all, so there is no
    //    origin to fall back to either and (0,0) is the only honest answer;
    //  - `--monitor` named an output that does not exist: the monitors were read
    //    perfectly well, so place the window on the primary rather than nowhere.
    //    `opts.monitors[0]` was used here and is not the primary — `pickMonitor`
    //    prefers `m.primary` precisely because the first entry often is not.
    const fallback = opts.monitors.find((m) => m.primary) ?? opts.monitors[0] ?? null;
    warnings.push(
      fallback
        ? `não achei o monitor "${opts.monitorName}" — usando ${fallback.name} e a resolução pedida sem verificar se cabe`
        : "não consegui ler os monitores — usando a resolução pedida sem verificar se cabe",
    );
    const fallbackX = fallback?.x ?? 0;
    const fallbackY = fallback?.y ?? 0;
    return {
      target: { w: target.w, h: target.h },
      window: { w: even(target.w), h: even(target.h), x: fallbackX, y: fallbackY },
      usable: { x: fallbackX, y: fallbackY, w: even(target.w), h: even(target.h) },
      deviceScaleFactor: 1,
      cssViewport: { w: target.cssWidth ?? target.w, h: 0 },
      mobile: target.mobile ?? false,
      ...(target.cssWidth !== undefined ? { cssWidth: target.cssWidth } : {}),
      scaleNeeded: target.mobile ?? false,
      monitor: "(desconhecido)",
      label: target.label,
      warnings,
    };
  }

  const box = usableContentBox(monitor, opts.area, opts.frame);

  // ── phones: a big window, an emulated viewport, and a crop ────────────────
  //
  // The window is deliberately NOT phone-shaped. Chromium clamps narrow
  // windows, so the phone-ness comes from `Emulation.setDeviceMetricsOverride`
  // and the video is cropped to exactly that emulated rectangle afterwards.
  // The final size can only be settled once the browser's own UI has been
  // measured, so this stage just reserves the room.
  if (target.mobile) {
    const cssWidth = target.cssWidth ?? target.w;
    const aspect = target.h / target.w;

    // Measured, and the single most important number here: the emulated
    // viewport's PHYSICAL footprint is `cssWidth x launch device scale factor`.
    // The `deviceScaleFactor` passed to `Emulation.setDeviceMetricsOverride`
    // changes what the page reports as `devicePixelRatio` but does NOT raster
    // it any larger — a first version cropped `cssWidth * overrideDsf` pixels
    // and got half app, half empty grey.
    //
    // So the density has to come from the launch flag, and it is bounded by
    // having to fit the phone's full height plus the browser's own UI inside
    // the usable box. CHROME_LOGICAL is deliberately generous: overestimating
    // wastes a few pixels, underestimating clips the bottom of the phone.
    const CHROME_LOGICAL = 220;
    const dsf = Math.max(1, Number((box.h / (cssWidth * aspect + CHROME_LOGICAL)).toFixed(3)));

    const windowW = even(Math.min(box.w, Math.max(cssWidth * dsf, 500 * dsf)));
    const windowH = even(box.h);

    warnings.push(
      `${target.w}x${target.h} é formato de celular: viewport emulado de ${cssWidth} CSS px ` +
        `a ${dsf}x, recortado da janela e ajustado ao final.`,
    );

    return {
      target: { w: target.w, h: target.h },
      window: { w: windowW, h: windowH, x: box.x, y: box.y },
      usable: box,
      deviceScaleFactor: dsf,
      cssViewport: { w: cssWidth, h: Math.round(cssWidth * aspect) },
      mobile: true,
      cssWidth,
      scaleNeeded: true,
      monitor: monitor.name,
      label: target.label,
      warnings,
    };
  }

  // ── desktop: the window IS the video ──────────────────────────────────────
  //
  // Uniform fit: never distort. `1` when it already fits, so every landscape
  // format takes the zero-post-processing path.
  const fit = Math.min(1, box.w / target.w, box.h / target.h);
  const windowW = even(target.w * fit);
  const windowH = even(target.h * fit);
  const scaleNeeded = windowW !== target.w || windowH !== target.h;

  if (scaleNeeded) {
    const factor = (target.h / windowH).toFixed(2);
    warnings.push(
      `${target.w}x${target.h} não cabe em ${monitor.name} (área útil ${box.w}x${box.h}). ` +
        `Capturando ${windowW}x${windowH} e ampliando ${factor}x no final — o arquivo terá a ` +
        `resolução pedida, com a nitidez de ${windowH}p.`,
    );
  }

  return {
    target: { w: target.w, h: target.h },
    window: { w: windowW, h: windowH, x: box.x, y: box.y },
    usable: box,
    deviceScaleFactor: 1,
    cssViewport: { w: windowW, h: windowH },
    mobile: false,
    scaleNeeded,
    monitor: monitor.name,
    label: target.label,
    warnings,
  };
}

/** Names accepted by `--res`, for the CLI's error message. */
export function resolutionNames(): string[] {
  return Object.keys(RESOLUTIONS);
}
