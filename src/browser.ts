/**
 * Launches the browser we record, and resolves its X11 window id so `rec` can
 * capture that window and nothing else.
 *
 * Two choices here are not negotiable:
 *
 *  - **A disposable `--user-data-dir`.** Never the user's real profile. Their
 *    bookmarks, extensions and signed-in accounts would be in the video, Brave
 *    Shields would fight the target app, and Chromium locks a profile to one
 *    process — we would have to close the browser they are using.
 *  - **`reducedMotion: 'no-preference'`.** Playwright's default leaves it
 *    unset, but if the machine ever reports `reduce`, WAAPI flattens our camera
 *    moves and the demo silently loses every animation.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { resolveBrowser } from "./doctor.js";
import { run } from "./exec.js";
import { OVERLAY_BUNDLE } from "./generated/overlay-bundle.js";

export interface LaunchOptions {
  /** Size of the recorded window, in physical pixels. */
  width?: number;
  height?: number;
  /** Where to put the window. Defaults to the primary monitor's origin. */
  x?: number;
  y?: number;
  /** Override the browser binary. Falls back to `DEMOVID_BROWSER`, then autodetect. */
  browser?: string;
  /**
   * Pixel density. Cannot be a Playwright context option here — it is rejected
   * alongside `viewport: null`, which the OS-window capture requires — so it
   * goes in as a launch flag. See `src/emulate.ts`.
   */
  deviceScaleFactor?: number;
  /**
   * Skip the X11 window hunt and the overlay injection.
   *
   * For the crawl, which drives the page but records nothing: resolving the
   * window id costs an 8s xdotool poll and the overlay would only get in the
   * way of measuring the app's own DOM.
   */
  probe?: boolean;
}

export interface LaunchedBrowser {
  ctx: BrowserContext;
  page: Page;
  /** X11 window id, decimal — ready for `rec --window-id`. */
  windowId: string;
  browserPath: string;
  close: () => Promise<void>;
}

/** Every Chromium-family window currently mapped, by X11 id. */
async function braveWindowIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const { stdout } = await run("xdotool", ["search", "--class", "brave"]);
    for (const l of stdout.split("\n")) if (l.trim()) ids.add(l.trim());
  } catch {
    /* nenhuma janela ainda — conjunto vazio é a resposta certa */
  }
  try {
    const { stdout } = await run("xdotool", ["search", "--class", "chrom"]);
    for (const l of stdout.split("\n")) if (l.trim()) ids.add(l.trim());
  } catch {
    /* idem */
  }
  return ids;
}

/**
 * Find the window we just opened by diffing the window list against a snapshot
 * taken before launch.
 *
 * Deliberately not `xdotool search --name <title>`: the title is the page's, so
 * matching on it would mean either depending on the target app's title or
 * temporarily rewriting `document.title` — and that rewrite would be visible in
 * the recorded tab strip.
 */
async function findNewWindow(before: Set<string>, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = new Set<string>();
  while (Date.now() < deadline) {
    const now = await braveWindowIds();
    last = now;
    const fresh = [...now].filter((id) => !before.has(id));
    if (fresh.length === 1) return fresh[0]!;
    if (fresh.length > 1) {
      // More than one appeared. Prefer the one that is actually viewable and
      // biggest — Chromium also maps small utility windows.
      let best: { id: string; area: number } | null = null;
      for (const id of fresh) {
        try {
          const { stdout } = await run("xdotool", ["getwindowgeometry", "--shell", id]);
          const w = Number(/^WIDTH=(\d+)$/m.exec(stdout)?.[1] ?? 0);
          const h = Number(/^HEIGHT=(\d+)$/m.exec(stdout)?.[1] ?? 0);
          if (!best || w * h > best.area) best = { id, area: w * h };
        } catch {
          /* janela sumiu no meio da busca */
        }
      }
      if (best) return best.id;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(
    `não consegui identificar a janela do browser no X11 em ${timeoutMs}ms ` +
      `(antes: ${before.size} janelas, agora: ${last.size}). ` +
      `Sem o window id o \`rec\` não sabe o que gravar.`,
  );
}

export async function launchBrowser(opts: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const browserPath = opts.browser ?? (await resolveBrowser());
  if (!browserPath) {
    throw new Error(
      "nenhum browser Chromium encontrado. Instale o Brave ou o Chrome, ou aponte DEMOVID_BROWSER.",
    );
  }

  // Measured: `--window-size` and `--window-position` are in LOGICAL pixels.
  // With `--force-device-scale-factor=2`, `--window-size=800,600` produces an
  // X11 window of 1600x1200. Callers here think in physical pixels, because
  // that is what the recorder captures and what the output file measures, so
  // the conversion happens once, here.
  const dsf = opts.deviceScaleFactor && opts.deviceScaleFactor > 0 ? opts.deviceScaleFactor : 1;
  const width = Math.round((opts.width ?? 1600) / dsf);
  const height = Math.round((opts.height ?? 1000) / dsf);
  const x = Math.round((opts.x ?? 0) / dsf);
  const y = Math.round((opts.y ?? 0) / dsf);

  const profile = await mkdtemp(join(tmpdir(), "demovid-profile-"));
  const before = await braveWindowIds();

  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: false, // the whole point is that a real window gets captured
    viewport: null, // let the OS window drive the viewport
    reducedMotion: "no-preference",
    args: [
      // Without --no-sandbox Chromium can abort with a V8 fatal that takes the
      // whole Node process down — not a catchable exception.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--window-size=${width},${height}`,
      `--window-position=${x},${y}`,
      ...(dsf !== 1 ? [`--force-device-scale-factor=${dsf}`] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-brave-update",
      "--hide-crash-restore-bubble",
      // Without these, Chromium draws a yellow infobar reading "You are using an
      // unsupported command-line flag: --no-sandbox. Stability and security will
      // suffer." across the top of the page — and straight into the video.
      // `--test-type` is what suppresses it; `--disable-infobars` covers the rest.
      "--test-type",
      "--disable-infobars",
      "--disable-features=Translate,MediaRouter,InfiniteSessionRestore",
      // The narration is an <audio> element that nobody clicked. Chromium's
      // autoplay policy needs a user gesture, and the profile is disposable, so no
      // gesture will ever have happened — `play()` rejects and the take ships
      // silent with a perfectly healthy-looking audio track.
      // `overlay/src/sequencer.ts` treats that rejection as fatal precisely so it
      // cannot pass unnoticed; this flag is what keeps it from happening at all.
      "--autoplay-policy=no-user-gesture-required",
      // Keep the renderer at full speed even if the window loses focus mid-take.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
  });

  // On the CONTEXT, not the page: an init script added to a page only applies to
  // that page's later navigations, and `setContent` is not a full navigation.
  if (!opts.probe) await ctx.addInitScript({ content: OVERLAY_BUNDLE });

  const page = ctx.pages()[0] ?? (await ctx.newPage());

  let windowId = "";
  if (!opts.probe) {
    try {
      windowId = await findNewWindow(before);
    } catch (err) {
      await ctx.close().catch(() => {});
      await rm(profile, { recursive: true, force: true });
      throw err;
    }
  }

  const close = async (): Promise<void> => {
    await ctx.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  };

  return { ctx, page, windowId, browserPath, close };
}

/**
 * Height of the browser's own UI — tab strip, omnibox, any bookmark bar —
 * inside the captured window, in PHYSICAL pixels.
 *
 * Measured rather than assumed: it varies with the browser, its version, and
 * whether the user's profile shows a bookmark bar. A hardcoded 88px was the
 * first version of this and was wrong on the first machine that tried it.
 */
export async function chromeHeightPx(page: Page, deviceScaleFactor = 1): Promise<number> {
  const logical = await page.evaluate(() => window.outerHeight - window.innerHeight);
  return Math.max(0, Math.round(logical * deviceScaleFactor));
}

/**
 * Resize the window so its *content* area is exactly `w x h` physical pixels.
 *
 * Used when the browser's own UI is going to be excluded from the capture: the
 * window has to be that much taller so the region left over is precisely the
 * requested resolution, and no scaling is needed afterwards.
 *
 * `Browser.setWindowBounds` works in logical pixels and covers the whole
 * window, so the browser UI has to be added back in logical units.
 */
export async function setContentSize(
  page: Page,
  w: number,
  h: number,
  deviceScaleFactor = 1,
): Promise<void> {
  const chromeLogical = await page.evaluate(() => window.outerHeight - window.innerHeight);
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        width: Math.round(w / deviceScaleFactor),
        height: Math.round(h / deviceScaleFactor) + chromeLogical,
      },
    });
  } finally {
    await cdp.detach().catch(() => {});
  }
}
