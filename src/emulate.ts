/**
 * Mobile emulation, applied over CDP rather than through Playwright's context
 * options — because those two are mutually exclusive here.
 *
 * The capture is of an OS window, so `viewport: null` is mandatory: the window
 * has to drive the viewport, otherwise the recorded pixels and the page's idea
 * of its own size drift apart. Playwright rejects `deviceScaleFactor` and
 * `isMobile` outright when `viewport` is null (`"deviceScaleFactor" option is
 * not supported with null "viewport"`), so neither can come from
 * `launchPersistentContext`.
 *
 * The split that works:
 *  - **density** is a browser launch flag (`--force-device-scale-factor`), which
 *    acts on the window and leaves the viewport OS-driven;
 *  - **touch, mobile flag and user agent** come from `Emulation.*` over CDP,
 *    with zeros for the metrics so the natural window size is preserved.
 *
 * Re-applied per page: an override set on one page does not follow a
 * navigation that opens another.
 */
import type { BrowserContext, Page } from "playwright-core";

export interface EmulationOptions {
  /** Report as a touch device: `mobile: true`, touch events, mobile UA. */
  mobile: boolean;
  /** Override the UA string. Defaults to a current Android Chrome UA. */
  userAgent?: string;
}

/**
 * A generic modern Android UA. Deliberately not an iPhone string: Safari-only
 * code paths in the app under demo would then be exercised by a Chromium that
 * does not implement them, and the demo would break in ways the real device
 * would not.
 */
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

export interface DeviceMetrics {
  /** Viewport width in CSS pixels — the number the app's media queries see. */
  cssWidth: number;
  cssHeight: number;
  /** Pixel density of the emulated device. */
  deviceScaleFactor: number;
}

export async function applyEmulation(
  page: Page,
  opts: EmulationOptions,
  metrics?: DeviceMetrics,
): Promise<void> {
  if (!opts.mobile) return;

  const cdp = await page.context().newCDPSession(page);
  try {
    // With explicit metrics the emulated viewport is rendered at the top-left
    // of the content area at exactly `cssWidth x cssHeight` — that rectangle is
    // what gets cropped out of the capture. Zeros mean "keep the natural window
    // size" and only flip the mobile bit.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: metrics?.cssWidth ?? 0,
      height: metrics?.cssHeight ?? 0,
      deviceScaleFactor: metrics?.deviceScaleFactor ?? 0,
      mobile: true,
      screenWidth: metrics?.cssWidth ?? 0,
      screenHeight: metrics?.cssHeight ?? 0,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: opts.userAgent ?? MOBILE_UA,
      platform: "Linux armv8l",
    });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Apply to every page the context has now, and to every page it opens later. */
export async function installEmulation(
  ctx: BrowserContext,
  opts: EmulationOptions,
  metrics?: DeviceMetrics,
): Promise<void> {
  if (!opts.mobile) return;
  for (const page of ctx.pages()) await applyEmulation(page, opts, metrics);
  ctx.on("page", (page) => {
    void applyEmulation(page, opts, metrics).catch(() => {});
  });
}
