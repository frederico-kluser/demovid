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
import { chromium, type BrowserContext, type Page } from "playwright";
import { resolveBrowser } from "./doctor.js";
import { run } from "./exec.js";
import { OVERLAY_BUNDLE } from "./generated/overlay-bundle.js";

export interface LaunchOptions {
  /** Inner size of the recorded window. */
  width?: number;
  height?: number;
  /** Where to put the window. Defaults to the primary monitor's origin. */
  x?: number;
  y?: number;
  /** Override the browser binary. Falls back to `DEMOVID_BROWSER`, then autodetect. */
  browser?: string;
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

  const width = opts.width ?? 1600;
  const height = opts.height ?? 1000;
  const x = opts.x ?? 0;
  const y = opts.y ?? 0;

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
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-brave-update",
      "--hide-crash-restore-bubble",
      // Keep the renderer at full speed even if the window loses focus mid-take.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
  });

  // On the CONTEXT, not the page: an init script added to a page only applies to
  // that page's later navigations, and `setContent` is not a full navigation.
  await ctx.addInitScript({ content: OVERLAY_BUNDLE });

  const page = ctx.pages()[0] ?? (await ctx.newPage());

  let windowId: string;
  try {
    windowId = await findNewWindow(before);
  } catch (err) {
    await ctx.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
    throw err;
  }

  const close = async (): Promise<void> => {
    await ctx.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  };

  return { ctx, page, windowId, browserPath, close };
}
