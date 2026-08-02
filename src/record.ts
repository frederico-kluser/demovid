/**
 * The conductor: storyboard in, MP4 out, one pass.
 *
 * Order of operations is load-bearing:
 *
 *   1. Narration is synthesised and cached BEFORE the browser opens. Playing a
 *      clip during the take must be instant — that is the whole reason the audio
 *      is pre-rendered rather than streamed.
 *   2. `rec` starts only once the page is loaded and the overlay is mounted, so
 *      the first frame of the video is already the finished composition.
 *   3. Every wait is bounded. Advance is driven by `audio.onended`, so an audio
 *      that never ends would otherwise hang forever with `rec` filling the disk.
 *
 * Actions are dispatched through Playwright's `page.mouse` / `locator`, never
 * `element.click()` from injected JS: the former produces *trusted* events, and
 * some apps ignore untrusted ones. The synthetic cursor is only ever the visual
 * half — it draws where the real, trusted click is about to land.
 */
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import "./overlay-api.js"; // traz a declaração de `window.__demovid`
import { chromeHeightPx, launchBrowser, setContentSize, type LaunchedBrowser } from "./browser.js";
import { installEmulation } from "./emulate.js";
import { synthesize, type Clip, type VoiceEngine } from "./openai/tts.js";
import { encodeAnimation, type AnimationFormat } from "./gif.js";
import { MODE_CAPS, type ModeCaps, type OutputMode } from "./output-mode.js";
import { buildRemotionProject } from "./remotion/index.js";
import { finalizeVideo, probeVideo, type VideoInfo } from "./postprocess.js";
import { applyLocale, dwellFor, LOCALES, PRESETS, type Preset } from "./presets/index.js";
import { startRecording, type Recording } from "./rec.js";
import type { CapturePlan } from "./resolution.js";
import { splitSentences } from "./openai/tts.js";
import { balloonTextOf, DEFAULT_STEP_TIMEOUT_MS, type Step, type Storyboard } from "./storyboard.js";
import { buildTimeline, timelinePathFor, TimelineRecorder, writeTimeline } from "./timeline.js";
import {
  clampIntoBox,
  fitWindowOnScreen,
  moveWindow,
  parkPointer,
  usableBoxFor,
  windowGeometry,
} from "./x11.js";

/** Clips are served to the page from disk over an intercepted virtual origin. */
const CLIP_ORIGIN = "https://demovid.invalid";

/**
 * `rec` stderr lines that look alarming and are not. A log that cries wolf on
 * every run trains the operator to ignore the run that actually failed.
 *
 * The ffmpeg one is measured, not assumed: gsr warns that ffmpeg < 8 lacks
 * working `hybrid_fragmented` movflags and MP4 may stutter. On this machine
 * (ffmpeg 6.1.1) a 50 s capture came out at a 16.66 ms median frame interval
 * against an ideal of 16.67, σ = 0.67 ms, with one 31 ms hiccup in 3000 frames
 * (0.03 %) and no duplicated frames. There is no stutter to chase.
 */
const BENIGN_REC_NOISE = [
  /FFmpeg version is known to be buggy/i,
  /ignoring invalid SAR/i,
];

export interface RecordOptions {
  storyboard: Storyboard;
  output: string;
  cacheDir?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  /**
   * Resolution, density and emulation. Overrides `width`/`height`/`x`/`y`.
   * Built by `planCapture` in `src/resolution.ts`, which is the only place that
   * knows whether the requested format physically fits on this screen.
   */
  capture?: CapturePlan;
  /**
   * Whether the browser's own UI belongs in the video. `auto` crops it only
   * when emulating a phone, where a desktop tab strip around a 390px viewport
   * reads as a mistake.
   */
  chrome?: "keep" | "crop" | "auto";
  /** Skip the recorder entirely — drives the browser and reports, records nothing. */
  rehearse?: boolean;
  /**
   * What is being produced. Drives narration, audio capture and the balloon
   * through `MODE_CAPS` — see `src/output-mode.ts` for why one boolean could not.
   * Defaults to the animation's format, then to `mp4`, so the two older callers
   * keep their exact behaviour.
   */
  mode?: OutputMode;
  /**
   * Encoder settings for `gif`/`webp`. Only the knobs — the *decision* to go
   * silent belongs to `mode`.
   */
  animate?: AnimateOptions;
  /** `remotion` mode: open the Studio when the project is ready. Defaults to true. */
  openStudio?: boolean;
  /** Which synthesiser narrates. Defaults to `speech`; see `src/openai/tts-audio.ts`. */
  voiceEngine?: VoiceEngine;
  /**
   * Selectors that mean "this app is busy", on top of `LOADING_SELECTORS`.
   *
   * Comes from the `readiness` block `pi` writes into the target project's
   * `.demovid.json`. Additive rather than a replacement: the generic ARIA and
   * class-name patterns cost nothing when an app does not use them, and an agent
   * that found one project-specific spinner has not thereby proven the others
   * absent.
   */
  loadingSelectors?: string[];
  onLog?: (line: string) => void;
}

export interface AnimateOptions {
  format: AnimationFormat;
  /** Hard ceiling in bytes. Frames are dropped until the file fits. */
  maxBytes?: number;
  fps?: number;
  width?: number;
}

export interface RecordReport {
  output: string | null;
  bytes: number;
  steps: StepReport[];
  cameraRung: "R1" | "R3";
  warnings: string[];
  /** What the file actually is, probed after any post-processing. */
  video?: VideoInfo;
  /** Path of the `.timeline.json` written beside the video. */
  timeline?: string;
  /** Only in `remotion` mode: the generated project and the Studio serving it. */
  remotion?: { dir: string; edl: string; url?: string };
}

export interface StepReport {
  index: number;
  action: string;
  target?: string | undefined;
  ok: boolean;
  detail?: string;
  ms: number;
  /** Wall clock, for the timeline. */
  startedAtMs: number;
  endedAtMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Resolve the preset + locale the storyboard asks for, falling back loudly. */
export function resolvePreset(sb: Storyboard, warn: (s: string) => void): Preset {
  const base = (PRESETS as Record<string, Preset | undefined>)[sb.preset];
  if (!base) {
    warn(`preset "${sb.preset}" não existe — usando boardroom. Disponíveis: ${Object.keys(PRESETS).join(", ")}`);
  }
  const preset = base ?? PRESETS.boardroom;
  const locale = (LOCALES as Record<string, (typeof LOCALES)["pt-BR"] | undefined>)[sb.locale];
  if (!locale) {
    warn(`locale "${sb.locale}" sem overlay — seguindo sem ajuste de ritmo`);
    return withVoiceOverrides(preset, sb);
  }
  return withVoiceOverrides(applyLocale(preset, locale), sb);
}

/**
 * Apply the storyboard's `voice` / `wpm` on top of the resolved preset.
 *
 * Runs **after** `applyLocale` on purpose: the locale overlay appends the accent
 * lock to `instructions`, and these overrides touch only `voice` and `targetWpm`.
 * Reversed, choosing a voice would silently drop the accent instruction.
 */
function withVoiceOverrides(preset: Preset, sb: Storyboard): Preset {
  if (sb.voice === undefined && sb.wpm === undefined) return preset;
  return {
    ...preset,
    voice: {
      ...preset.voice,
      ...(sb.voice !== undefined ? { voice: sb.voice } : {}),
      ...(sb.wpm !== undefined ? { targetWpm: sb.wpm } : {}),
    },
  };
}

/** Playwright locator for a step's target. Accepts CSS or `text=` / `role=`. */
function locatorFor(page: Page, target: string): Locator {
  return page.locator(target).first();
}

/**
 * Loading indicators every frontend agrees on, whatever it is built with.
 *
 * ARIA first, because it is the only part of this list an app is *supposed* to
 * get right, and the class-name patterns after it, because most apps do not. A
 * false positive here — a permanently visible element whose class happens to
 * contain "loading" — costs the settle ceiling and a log line, never the take:
 * `settle` is best-effort by construction, for exactly this reason.
 *
 * Project-specific selectors are appended by the caller from the `readiness`
 * block that `pi` writes into `.demovid.json`; these are the floor, not the
 * whole answer.
 */
export const LOADING_SELECTORS = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '[data-loading="true"]',
  '[data-state="loading"]',
  '[class*="spinner" i]',
  '[class*="skeleton" i]',
  '[class*="loading" i]',
  '[class*="loader" i]',
];

/**
 * Ceiling for the automatic settle when the step does not set `timeoutMs`.
 *
 * Exported so the plan shown for approval can state the real number instead of
 * a second copy of it — an operator approving "espera até 8s" is approving this
 * constant, and two constants that mean the same thing drift.
 */
export const SETTLE_DEFAULT_MS = 8_000;

/**
 * Actions that can leave the app busy, and therefore get an automatic settle.
 *
 * `hover` and `focus` are excluded because they change nothing the app has to go
 * and fetch, and `wait` because a step that just finished waiting on an explicit
 * condition does not need to be second-guessed by a heuristic. `scroll` is IN:
 * lazy lists and infinite scroll are loading triggered by scrolling, and the
 * screenshot of a half-populated list is the artifact this whole mechanism is
 * about.
 */
export const SETTLING_ACTIONS: ReadonlySet<string> = new Set(["click", "type", "goto", "scroll"]);

/**
 * Wait for the app to stop being busy after an action.
 *
 * This is the whole answer to "the demo recorded the spinner". Before it, an
 * action was followed straight by the preset's `dwell` — a FIXED time that knows
 * nothing about whether the app finished. A click that opened a repository got
 * the same 3 seconds as a click that toggled a checkbox, so the fast one held an
 * idle frame and the slow one was cut off mid-load and blamed on the app.
 *
 * Three signals, weakest first, and none of them fatal:
 *
 *  1. `networkidle`, best-effort and on a short leash. Playwright itself
 *     discourages it and an app holding a WebSocket open — which is most of the
 *     apps worth demoing, GitCraque included — may never reach it. It is here
 *     because when it does fire it is the cheapest possible confirmation, not
 *     because anything depends on it.
 *  2. **No loading indicator visible.** The load-bearing one. Waiting for the
 *     spinner to LEAVE is the only signal in this list that describes the thing
 *     the operator actually cares about.
 *  3. A short quiet period, so a repaint that lands one frame after the spinner
 *     leaves is inside the take rather than one frame outside it.
 *
 * Returns what happened so the timeline can show it — a step that timed out
 * waiting is a real editorial fact about the recording, not an internal detail.
 */
/**
 * Which of `selectors` currently match a visible element.
 *
 * Used once, on the app at rest, to throw away the ones that are always on
 * screen. `LOADING_SELECTORS` matches on substrings — `[class*="loading" i]` hits
 * a permanent `loadingContainer` just as happily as a spinner — and a selector
 * that never goes away makes every single step wait out its full ceiling. Eight
 * steps into a demo that is a minute of dead air produced by a heuristic.
 *
 * Measuring beats guessing here, and the measurement is nearly free: whatever is
 * still visible after the app has finished loading is, by definition, not a
 * loading indicator.
 */
async function visibleLoaders(page: Page, selectors: string[]): Promise<string[]> {
  return page
    .evaluate(
      (sels: string[]) =>
        sels.filter((sel) => {
          try {
            return Array.from(document.querySelectorAll(sel)).some((el) => {
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) return false;
              const st = getComputedStyle(el);
              return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05;
            });
          } catch {
            return false;
          }
        }),
      selectors,
    )
    .catch(() => [] as string[]);
}

async function settle(
  page: Page,
  selectors: string[],
  timeoutMs: number,
): Promise<"quiet" | "timeout" | "skipped"> {
  await page.waitForLoadState("networkidle", { timeout: Math.min(2_000, timeoutMs) }).catch(() => {});

  if (selectors.length === 0) return "skipped";

  try {
    // Anonymous arrows only, never a named inner function: under tsx, esbuild's
    // `keepNames` rewrites a named function to `__name(fn, "fn")` and the helper
    // does not travel into the page. See `installNameShim` in project/inventory.ts.
    await page.waitForFunction(
      (sels: string[]) =>
        !sels.some((sel) => {
          try {
            return Array.from(document.querySelectorAll(sel)).some((el) => {
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) return false;
              const st = getComputedStyle(el);
              return (
                st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05
              );
            });
          } catch {
            // An invalid selector must not be able to hang the settle forever.
            return false;
          }
        }),
      selectors,
      { timeout: timeoutMs, polling: 120 },
    );
  } catch {
    return "timeout";
  }

  await sleep(180);
  return "quiet";
}

/**
 * Serve the cached MP3s to the page.
 *
 * Route interception rather than data: URLs — a 20-step demo would otherwise
 * push a megabyte of base64 through `evaluate`, and the clips would be
 * unreadable in a trace.
 */
async function serveClips(browser: LaunchedBrowser, clips: Clip[]): Promise<Map<string, string>> {
  const byUrl = new Map<string, string>();
  for (const c of clips) byUrl.set(`${CLIP_ORIGIN}/${c.id}.mp3`, c.path);

  await browser.ctx.route(`${CLIP_ORIGIN}/**`, async (route) => {
    const path = byUrl.get(route.request().url());
    if (!path) return route.abort();
    await route.fulfill({ status: 200, contentType: "audio/mpeg", path });
  });

  return byUrl;
}

export async function record(opts: RecordOptions): Promise<RecordReport> {
  const sb = opts.storyboard;
  const warnings: string[] = [];
  const log = opts.onLog ?? ((): void => {});
  const preset = resolvePreset(sb, (w) => {
    warnings.push(w);
    log(`aviso: ${w}`);
  });

  // ── 1. narração, antes de qualquer coisa ──────────────────────────────────
  //
  // Silent output takes this whole block out. Not "synthesises and mutes" —
  // `synthesize` is where the money is spent, so a GIF that paid for audio it
  // then threw away would be the expensive version of free.
  const mode: OutputMode = opts.mode ?? opts.animate?.format ?? "mp4";
  const caps = MODE_CAPS[mode];
  const cacheDir = opts.cacheDir ?? join(process.cwd(), ".demovid-cache");

  // Deduplicated: `pi` is asked for the app's loading indicators and will
  // sometimes answer with `[aria-busy="true"]`, which is already in the floor.
  // A repeat costs a redundant `querySelectorAll` on every poll of every settle.
  let loaders = [...new Set([...LOADING_SELECTORS, ...(opts.loadingSelectors ?? [])])];

  // The recorder only ever writes an MP4; a GIF is a conversion of one. The
  // intermediate is a dotfile beside the real output rather than in /tmp, so it
  // lands on the same filesystem — a rename or a large write across devices is
  // exactly where a 200 MB capture runs out of room in the least helpful way.
  const capturePath = opts.animate
    ? join(dirname(opts.output), `.demovid-capture-${process.pid}.mp4`)
    : opts.output;

  const perStep = caps.voice
    ? sb.steps.map((s) => (s.say ? splitSentences(s.say) : []))
    : sb.steps.map(() => [] as string[]);

  let clips: Clip[] = [];
  if (!caps.voice) {
    log("modo silencioso: nenhuma chamada de TTS, o balão é o único canal");
  } else {
    await mkdir(cacheDir, { recursive: true });
    clips = await synthesize(perStep.flat(), {
      cacheDir,
      profile: { voice: preset.voice.voice, instructions: preset.voice.instructions, targetWpm: preset.voice.targetWpm },
      ...(opts.voiceEngine ? { engine: opts.voiceEngine } : {}),
      onProgress: (d, t, cached) => log(`voz ${d}/${t}${cached ? " (cache)" : ""}`),
      onWarn: (w) => {
        warnings.push(w);
        log(w);
      },
    });
  }

  // Map each step back to its clips, in order.
  const clipsByStep: Clip[][] = [];
  let cursorIdx = 0;
  for (const sentences of perStep) {
    clipsByStep.push(clips.slice(cursorIdx, cursorIdx + sentences.length));
    cursorIdx += sentences.length;
  }

  // ── 2. browser ────────────────────────────────────────────────────────────
  const plan = opts.capture;
  for (const w of plan?.warnings ?? []) {
    warnings.push(w);
    log(`aviso: ${w}`);
  }

  // Without a capture plan nothing has fitted the request to a monitor, so do it
  // here. Position alone is not enough: the primary monitor's origin ignores the
  // panel and the title bar, and a size nobody compared to the screen is the
  // other half of the same bug.
  const fallback = plan ? null : await fitWindowOnScreen(opts.width ?? 1600, opts.height ?? 1000);

  const browser = await launchBrowser({
    width: plan?.window.w ?? fallback?.w ?? opts.width ?? 1600,
    height: plan?.window.h ?? fallback?.h ?? opts.height ?? 1000,
    x: plan?.window.x ?? opts.x ?? fallback?.x ?? 0,
    y: plan?.window.y ?? opts.y ?? fallback?.y ?? 0,
    ...(plan ? { deviceScaleFactor: plan.deviceScaleFactor } : {}),
  });
  await serveClips(browser, clips);

  // ── 2b. geometria real, medida antes de navegar ───────────────────────────
  //
  // Measured on the blank page, because the emulated viewport has to be in
  // place BEFORE the app loads — an app that boots at desktop width and is then
  // told it is a phone is a different app.
  //
  // The window is measured rather than assumed: Chromium clamps sizes it
  // dislikes, and the recorder captures what the window manager actually
  // produced, not what was requested.
  const dsfPlan = plan?.deviceScaleFactor ?? 1;
  let chromePx = await chromeHeightPx(browser.page, dsfPlan).catch(() => 0);

  // Removing the browser's own UI costs a re-encode, and that is the cheaper
  // half of the trade.
  //
  // The tempting alternative — capturing a screen REGION instead of the window
  // — was built, measured, and removed. Region capture reads the framebuffer,
  // so it records whatever is stacked above the browser: a test take came out
  // containing the operator's chat client, private conversations and all.
  // Raising the window first does not fix it, because any window can take the
  // foreground mid-recording. Window capture reads the window's own buffer and
  // is structurally immune to that, which makes this a safety property rather
  // than a quality one. demovid captures windows. Always.
  //
  // `auto` drops it. Everything the browser decides to draw up there lands in
  // that same band — the "unsupported command-line flag" warning, a privacy
  // notice, a translate bubble — and no combination of flags reliably silences
  // them. One deterministic crop removes the whole class. `keep` is there for
  // when the true single pass matters more than the frame.
  const chromeMode = opts.chrome ?? "auto";
  const dropChrome = chromeMode !== "keep";

  if (dropChrome && plan && !plan.mobile) {
    // Make the content area as close to the requested resolution as FITS, so the
    // region needs no scaling either.
    //
    // "As fits", not "exactly": this asked for `plan.target` and that is how the
    // window ended up hanging off the monitor. `planCapture` has already fitted
    // the request to the screen and put the result in `plan.window` — when the
    // two differ it is because the target was measured not to fit, so re-asking
    // for `target` here re-created exactly the size that was rejected, and the
    // upscale it was trying to avoid happened in post anyway.
    //
    // The second clamp is the browser's own UI. `plan.usable` bounds the whole OS
    // window while `plan.window` describes only the content, so the chrome has to
    // come out of the height or the window overflows the bottom of the work area
    // even when the content itself fits. It is measured here rather than reserved
    // in `planCapture` because its height is not knowable before launch.
    //
    // Iterated, because the browser's UI height is not stable across the
    // resize: measured, a first pass landed 20px short because an infobar the
    // browser decided to show appeared between the measurement and the resize.
    // Two passes converge; the third is insurance. `finalizeCapture` re-derives
    // whether a scale is needed from the geometry that actually resulted, so
    // giving up pixels here still delivers the requested resolution.
    for (let attempt = 0; attempt < 3; attempt++) {
      const wantW = Math.min(plan.window.w, plan.usable.w);
      const wantH = Math.min(plan.window.h, Math.max(2, plan.usable.h - chromePx));
      await setContentSize(browser.page, wantW, wantH, dsfPlan).catch(() => {});
      await sleep(280);
      chromePx = await chromeHeightPx(browser.page, dsfPlan).catch(() => chromePx);
      const g = await windowGeometry(browser.windowId);
      if (!g) break;
      if (Math.abs(g.h - chromePx - wantH) <= 2) break;
    }
  }

  // ── 2c. trazer a janela de volta para dentro da tela ──────────────────────
  //
  // The window is positioned exactly once, by `--window-position` at launch, and
  // then RESIZED — by the loop above, and by whatever Chromium does about a size
  // it dislikes. A resize keeps the top-left corner, so growing the window pushes
  // its bottom-right off the work area, and nothing here ever looked. Observed on
  // a real take: the recorded window hung off the operator's screen.
  //
  // Checked against the usable box — `planCapture`'s when there is a plan, the
  // fitted fallback's otherwise — and corrected with `xdotool windowmove`, the
  // only mechanism that can move a mapped window.
  //
  // Two corrections, in this order, because they fix different halves and moving
  // a window that is too big cannot succeed:
  //
  //  1. SHRINK when the window is larger than the box. Moving alone was the
  //     first version of this and it could only pick which edge to sacrifice —
  //     it emitted a warning and recorded a window hanging off the screen.
  //     Giving up pixels is safe here: `finalizeCapture` re-derives the scale
  //     from the geometry that actually resulted, so the file still lands on the
  //     requested resolution, just softer. A silently cropped take does not.
  //  2. MOVE what is now the right size back inside.
  //
  // The 2px tolerance is not cosmetic: Chromium rounds window bounds and the
  // reels plan lands exactly 1px over, so a strict comparison would resize on
  // every run and fight the compositor for nothing.
  //
  // Silent when it is already inside, which is the common case: a log line every
  // run would train the operator to ignore the one run where it mattered.
  // Re-measured against the window we actually opened. The planned box was built
  // from the decoration of whatever window was focused at the time, which is a
  // guess that is off by a whole title bar whenever it guesses wrong.
  const measured = await usableBoxFor(browser.windowId, plan?.monitor);
  const usable = measured ?? plan?.usable ?? fallback?.usable ?? null;
  if (usable) {
    let before = await windowGeometry(browser.windowId);

    if (before && (before.w > usable.w + 2 || before.h > usable.h + 2)) {
      const wantW = Math.min(before.w, usable.w);
      const wantH = Math.max(2, Math.min(before.h, usable.h) - chromePx);
      await setContentSize(browser.page, wantW, wantH, dsfPlan).catch(() => {});
      await sleep(280);
      log(
        `a janela (${before.w}x${before.h}) não cabia na área útil ` +
          `(${usable.w}x${usable.h}) — reduzida para caber inteira na tela`,
      );
      before = await windowGeometry(browser.windowId);
    }

    if (before) {
      const { x, y } = clampIntoBox(before, usable);
      if (x !== before.x || y !== before.y) {
        await moveWindow(browser.windowId, x, y);
        log(`a janela estava fora da área útil — movida de (${before.x},${before.y}) para (${x},${y})`);
      }
      const after = (await windowGeometry(browser.windowId)) ?? before;
      if (after.w > usable.w + 2 || after.h > usable.h + 2) {
        const w =
          `a janela (${after.w}x${after.h}) continua maior que a área útil ` +
          `(${usable.w}x${usable.h}) — parte dela fica fora da tela`;
        warnings.push(w);
        log(`aviso: ${w}`);
      }
    }
  }

  const actual = (await windowGeometry(browser.windowId)) ?? {
    x: 0,
    y: 0,
    w: plan?.window.w ?? opts.width ?? 1600,
    h: plan?.window.h ?? opts.height ?? 1000,
  };

  /** Rectangle to keep, relative to the captured window. Applied in post. */
  let cropRect: { w: number; h: number; x: number; y: number } | null = null;

  if (plan?.mobile) {
    const dsf = plan.deviceScaleFactor;
    const cssWidth = plan.cssWidth ?? plan.target.w;
    const aspect = plan.target.h / plan.target.w;
    const contentH = actual.h - chromePx;

    // The footprint is `cssWidth * launch dsf`; the override's own
    // deviceScaleFactor only sets what the page reports. See src/resolution.ts.
    const vpW = even(Math.min(cssWidth * dsf, actual.w));
    const vpH = even(Math.min(vpW * aspect, contentH));
    const cssHeight = Math.round(vpH / dsf);

    await installEmulation(
      browser.ctx,
      { mobile: true },
      { cssWidth, cssHeight, deviceScaleFactor: dsf },
    );
    cropRect = { x: 0, y: chromePx, w: vpW, h: vpH };
    log(
      `celular: viewport ${cssWidth}x${cssHeight} CSS @${dsf}x → ${vpW}x${vpH} px, ` +
        `recortado da janela a partir de y=${chromePx}`,
    );
    if (vpH < vpW * aspect - 2) {
      const w = `a janela não coube na proporção pedida — o vídeo sai com barras pretas em vez de esticado`;
      warnings.push(w);
      log(`aviso: ${w}`);
    }
  } else if (dropChrome && chromePx > 0 && chromePx < actual.h) {
    cropRect = { x: 0, y: chromePx, w: even(actual.w), h: even(actual.h - chromePx) };
    log(`sem a barra do browser: recorte ${cropRect.w}x${cropRect.h} a partir de y=${chromePx}`);
  }

  let recording: Recording | null = null;
  const steps: StepReport[] = [];
  let cameraRung: "R1" | "R3" = "R1";
  const tl = new TimelineRecorder();

  // Uma morte do browser aparecia como "Target page … has been closed" no passo
  // SEGUINTE, fazendo depurar o passo errado. Registrar a causa quando ela
  // acontece, e checar antes de cada passo, transforma isso numa mensagem única
  // e no lugar certo. (Vi duas falhas assim, não consegui reproduzir; a causa
  // continua desconhecida — o que dá para garantir é o diagnóstico.)
  let died: string | null = null;

  try {
    const page = browser.page;
    page.on("crash", () => (died ??= "a página crashou (out-of-memory ou o renderer morreu)"));
    page.on("close", () => (died ??= "a página foi fechada"));
    browser.ctx.on("close", () => (died ??= "o contexto do browser foi fechado"));
    page.on("pageerror", (e) => log(`erro na página: ${e.message.slice(0, 200)}`));

    await page.goto(sb.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {
      warnings.push("a página não chegou a `load` em 30s — seguindo com o que carregou");
    });

    // ── calibrar os indicadores de carregamento ─────────────────────────────
    //
    // Let the app finish booting, then throw away every "loading indicator" that
    // is STILL on screen. Those are false positives by definition — the app is at
    // rest and they did not go away — and each one left in would make every
    // subsequent step wait out its whole ceiling for something that never moves.
    //
    // This is what makes the substring patterns in `LOADING_SELECTORS` safe to
    // ship. Without it, one permanent `<div class="loadingContainer">` turns an
    // eight-step demo into a minute of dead air, and the operator has no way to
    // tell that from a genuinely slow app.
    if (loaders.length > 0) {
      await settle(page, loaders, 10_000);
      const stuck = await visibleLoaders(page, loaders);
      if (stuck.length > 0) {
        loaders = loaders.filter((s) => !stuck.includes(s));
        log(`${stuck.length} indicador(es) sempre visíveis — ignorados: ${stuck.join(", ")}`);
      }
    }

    const mounted = await page.evaluate(
      (style) => window.__demovid?.mount(style),
      overlayStyleOf(preset) as never,
    );

    if (!mounted?.stage) {
      // The stage is the only optional layer. Without it there is no zoom, but
      // spotlight, cursor and balloons still work — so degrade rather than fail.
      cameraRung = "R3";
      warnings.push(`palco não montou (${mounted?.why ?? "motivo desconhecido"}) — câmera rebaixada para R3, sem zoom`);
      log(`aviso: câmera em R3, sem zoom`);
    }
    if (!mounted?.overlay) throw new Error("o overlay não montou — sem ele não há demo a gravar");

    await page.evaluate(() => window.__demovid!.showCursor());
    await page.evaluate(() => window.__demovid!.cursorPlace(window.innerWidth / 2, window.innerHeight * 0.75));

    // ── 3. gravação ─────────────────────────────────────────────────────────
    // Get the physical pointer out of the frame before the first frame exists:
    // Playwright never moves it, so it sits wherever the operator left it, and
    // over the tab strip it makes Chromium draw a hover card mid-take.
    await parkPointer(actual);
    await sleep(150);

    if (!opts.rehearse) {
      recording = await startRecording({
        // Always the window, never a screen region. See the note above.
        target: { kind: "window", windowId: browser.windowId },
        output: capturePath,
        // Silent output captures no audio at all. Beyond saving an encode, this
        // is a privacy property: the captured source is the default sink's
        // monitor, so a "silent" take that still recorded system audio would
        // pick up whatever else the machine happens to be playing.
        audio: caps.captureAudio ? "system" : "none",
        fps: 60,
        // The exact anchor between this process's clock and the video's t=0.
        firstFrameTs: true,
        onLine: (l) => {
          if (BENIGN_REC_NOISE.some((re) => re.test(l))) return;
          if (/error|failed|warning/i.test(l)) log(`rec: ${l}`);
        },
      });
      log(`gravando janela ${browser.windowId} → ${opts.output}`);
      const leadIn = tl.mark("lead-in", { reason: "estabilização do encoder" });
      await sleep(600); // deixa o encoder estabilizar antes do primeiro movimento
      tl.end(leadIn);
    }

    // ── 4. os passos ────────────────────────────────────────────────────────
    for (const [i, step] of sb.steps.entries()) {
      const t0 = Date.now();
      const report: StepReport = {
        index: i,
        action: step.action,
        target: step.target,
        ok: true,
        ms: 0,
        startedAtMs: t0,
        endedAtMs: t0,
      };
      const stepEvent = tl.mark("step-start", { action: step.action, target: step.target }, i);
      try {
        if (died) throw new Error(`o browser morreu antes deste passo: ${died}`);
        await runStep(page, step, preset, clipsByStep[i] ?? [], cameraRung, log, tl, i, caps, loaders);
      } catch (err) {
        report.ok = false;
        report.detail = (err as Error).message;
        warnings.push(`passo ${i} (${step.action}): ${report.detail}`);
        log(`passo ${i} FALHOU: ${report.detail}`);
        tl.mark("error", { message: report.detail }, i);
      }
      tl.end(stepEvent);
      tl.mark("step-end", { ok: report.ok }, i);
      report.ms = Date.now() - t0;
      report.endedAtMs = Date.now();
      steps.push(report);
      await sleep(preset.pacing.gapMs);
    }

    // Land the camera and clear the overlay before the final frames, so the
    // video does not end mid-zoom with a balloon still up.
    if (!died) {
      const leadOut = tl.mark("lead-out", { reason: "câmera volta à identidade, overlay limpo" });
      await page
        .evaluate(async (s) => {
          window.__demovid!.hush();
          window.__demovid!.spotlightOff();
          window.__demovid!.cursorZoom(1);
          await window.__demovid!.cameraTo({ tx: 0, ty: 0, k: 1 }, s as never, 900);
        }, springConstants(preset))
        .catch(() => {});
      await sleep(500);
      tl.end(leadOut);
    }

    if (died) warnings.push(`o browser morreu durante a gravação: ${died}`);

    if (recording) {
      const rec = recording;
      const stopped = await rec.stop();
      recording = null;

      // Read before finalizing: the sidecar is deleted as it is consumed, and
      // the post-processing pass renames the video out from under it.
      const firstFrame = await rec.readFirstFrameTs().catch(() => null);
      const finished = await finalizeCapture(stopped.output, plan, cropRect, log);
      for (const w of finished.warnings) warnings.push(w);

      // Beside the file the operator ends up holding, not beside the throwaway
      // capture — `demo.gif` gets `demo.timeline.json`.
      const timelinePath = timelinePathFor(opts.output);
      const timeline = buildTimeline({
        outputPath: opts.output,
        video: finished.info,
        backend: rec.backend,
        scaled: plan?.scaleNeeded ?? false,
        storyboard: { title: sb.title, url: sb.url, locale: sb.locale, preset: sb.preset },
        cameraRung,
        clock: {
          stoppedAtMs: rec.stoppedAtMs,
          startedAtMs: rec.startedAtMs,
          durationMs: finished.info.durationMs,
          firstFrameRealtimeUs: firstFrame?.realtimeUs ?? null,
        },
        recorder: tl,
        steps,
        warnings,
      });
      await writeTimeline(timelinePath, timeline);
      log(
        `timeline: ${timelinePath} (relógio ${timeline.clock.method}, ±${timeline.clock.residualMs}ms, ` +
          `${timeline.cuts.length} ponto(s) de corte)`,
      );

      // ── 5. o GIF, quando foi ele o pedido ─────────────────────────────────
      //
      // `buildTimeline` above deliberately used the *capture's* info: every
      // timestamp in the sidecar is in capture time, and the animation's own
      // frame rate is a property of the file, not of the clock.
      if (opts.animate) {
        const enc = await encodeAnimation({
          input: stopped.output,
          output: opts.output,
          format: opts.animate.format,
          ...(opts.animate.fps !== undefined ? { fps: opts.animate.fps } : {}),
          ...(opts.animate.width !== undefined ? { width: opts.animate.width } : {}),
          ...(opts.animate.maxBytes !== undefined ? { maxBytes: opts.animate.maxBytes } : {}),
          onLog: log,
        });

        if (!enc.withinBudget) {
          const w =
            `o ${opts.animate.format} ficou em ${(enc.bytes / 1024 / 1024).toFixed(1)} MB mesmo a ` +
            `${enc.fps}fps, o mínimo da escala. Para caber: menos passos, texto mais curto, ` +
            `ou --format webp (mede uma ordem de grandeza menor no mesmo clipe)`;
          warnings.push(w);
          log(`aviso: ${w}`);
        }

        await rm(stopped.output, { force: true }).catch(() => {
          warnings.push(`não consegui apagar a captura intermediária ${stopped.output}`);
        });

        return {
          output: opts.output,
          bytes: enc.bytes,
          steps,
          cameraRung,
          warnings,
          video: await probeVideo(opts.output),
          timeline: timelinePath,
        };
      }

      // ── 6. a montagem, quando o pedido foi o Remotion ─────────────────────
      //
      // Depois do timeline e não antes: o EDL é construído A PARTIR dele. Toda a
      // decisão de corte vem de `timeline.cuts` e `timeline.narration`, que só
      // existem agora — é por isso que este passo não pode ser um pré-processo.
      let remotion: RecordReport["remotion"];
      if (mode === "remotion") {
        remotion = await buildRemotionProject({
          output: opts.output,
          timeline,
          clips,
          title: sb.title,
          open: opts.openStudio !== false,
          log,
          warn: (w) => {
            warnings.push(w);
            log(`aviso: ${w}`);
          },
        });
      }

      return {
        output: stopped.output,
        bytes: finished.bytes,
        steps,
        cameraRung,
        warnings,
        video: finished.info,
        timeline: timelinePath,
        ...(remotion ? { remotion } : {}),
      };
    }
    return { output: null, bytes: 0, steps, cameraRung, warnings };
  } finally {
    // Unconditional — never `if (recording.running)`. That guard once left a
    // gpu-screen-recorder capturing the desktop after the process exited.
    await recording?.dispose();
    await browser.close();
  }
}

/** Encoders reject odd dimensions; crop geometry must land on even numbers. */
const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/**
 * The overlay style for a preset.
 *
 * Extracted because `mount()` is called from two places — once after the initial
 * `goto` and again after every `goto` *step* — and the second one used to pass no
 * style at all. `mountOverlay` early-returns on an existing host, so on a fresh
 * document (which is what a navigation produces) the styleless call rebuilt the
 * whole overlay from `DEFAULT_STYLE`: after any navigation the balloon silently
 * reverted to 17px and lost `avoidCursor`, which for silent output means the only
 * channel to the viewer shrank mid-demo.
 */
function overlayStyleOf(preset: Preset): unknown {
  return {
    cursor: { ...preset.cursor, accent: preset.balloon.accent },
    spotlight: { ...preset.spotlight, accent: preset.balloon.accent },
    balloon: preset.balloon,
  };
}

/**
 * The camera spring, as physical constants for the overlay to rebuild.
 *
 * The baked `linear()` easing is a frozen sample of this spring: fine for a
 * transition that runs start to finish, useless for one that has to resume from
 * an interruption. The overlay needs the spring itself.
 */
function springConstants(preset: Preset): { stiffness: number; damping: number; mass: number } {
  const s = preset.camera.spring;
  return { stiffness: s.stiffness, damping: s.damping, mass: s.mass };
}

/**
 * Largest rectangle with `target`'s aspect ratio that fits in `w x h`.
 *
 * This is where the phone-shaped video actually gets its shape: the window is
 * whatever Chromium would give us, and this carves the 9:16 (or 3:4, or
 * whatever was asked for) region out of it.
 */
export function fitViewport(
  w: number,
  h: number,
  target: { w: number; h: number },
): { w: number; h: number } {
  const aspect = target.w / target.h;
  let vw = h * aspect;
  let vh = h;
  if (vw > w) {
    vw = w;
    vh = w / aspect;
  }
  return { w: even(vw), h: even(vh) };
}

/**
 * Turn the raw capture into the file that was asked for.
 *
 * Does nothing at all in the common case — a landscape format that fits on
 * screen is already correct the moment the recorder stops, and that is the
 * whole point of the one-pass design. Work happens only when the browser's own
 * UI has to come off, or when the requested resolution was physically
 * impossible to capture and has to be scaled up.
 *
 * Cropping the browser UI changes the aspect ratio, so what remains is
 * centre-cropped back to the target's aspect before scaling. Skipping that step
 * would stretch the app vertically — subtly enough to ship, obviously enough to
 * look wrong.
 */
async function finalizeCapture(
  path: string,
  plan: CapturePlan | undefined,
  cropRect: { w: number; h: number; x: number; y: number } | null,
  log: (s: string) => void,
): Promise<{ bytes: number; info: VideoInfo; warnings: string[] }> {
  const warnings: string[] = [];
  const before = await probeVideo(path);

  // The crop was decided while the browser was alive, against the window's real
  // geometry. Re-deriving it from the file would only re-guess what was already
  // measured — but it must still be checked against what actually got captured.
  let crop = cropRect;
  if (crop && (crop.x + crop.w > before.width || crop.y + crop.h > before.height)) {
    warnings.push(
      `o recorte planejado (${crop.w}x${crop.h}+${crop.x}+${crop.y}) não cabe no vídeo ` +
        `de ${before.width}x${before.height} — saindo sem recortar`,
    );
    crop = null;
  }

  const w = crop?.w ?? before.width;
  const h = crop?.h ?? before.height;
  const needScale = plan !== undefined && (w !== plan.target.w || h !== plan.target.h);

  const info =
    crop || needScale
      ? (
          await finalizeVideo(path, {
            ...(crop ? { crop } : {}),
            ...(needScale && plan ? { scale: { w: plan.target.w, h: plan.target.h } } : {}),
            // Letterbox rather than distort: the crop's aspect can be a pixel
            // or two off the target once everything has been rounded to even.
            ...(plan?.mobile ? { pad: true } : {}),
            onLog: log,
          })
        ).info
      : before;

  const st = await stat(path).catch(() => null);
  return { bytes: st?.size ?? 0, info, warnings };
}

/** One step: aim, narrate, act. */
async function runStep(
  page: Page,
  step: Step,
  preset: Preset,
  clips: Clip[],
  rung: "R1" | "R3",
  log: (s: string) => void,
  tl: TimelineRecorder,
  index: number,
  caps: ModeCaps,
  loaders: string[],
): Promise<void> {
  const timeout = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  // A step waiting for something to LEAVE must not aim at it first. The aim block
  // below waits for `target` to be visible, so a `waitFor: "hidden"` step whose
  // spinner had already gone would fail on the aim — the step doing its job
  // perfectly is the case that would have thrown.
  const vanishing = step.action === "wait" && (step.waitFor === "hidden" || step.waitFor === "detached");

  // ── aim ──────────────────────────────────────────────────────────────────
  if (step.target && !vanishing) {
    const loc = locatorFor(page, step.target);
    await loc.waitFor({ state: "visible", timeout: Math.min(timeout, 10_000) });
    // `scrollIntoViewIfNeeded` waits for the element's box to be stable across
    // two consecutive frames — placing a balloon against a moving rect is what
    // produces the "balloon floating in space" artifact.
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});

    const zoom = step.zoom ?? preset.camera.zoom;
    if (rung === "R1" && zoom > 1) {
      const cam = await page.evaluate(
        ([sel, k]) => window.__demovid!.cameraFor(sel as string, k as number),
        [step.target, zoom] as const,
      );
      if (cam) {
        const move = tl.mark("camera-move", { to: cam, selector: step.target, zoom }, index);
        // The overlay owns the animation now. Writing `stage.style.transition`
        // from here left that string parked on the element forever, so the
        // final reset to identity either transitioned or snapped depending on
        // whether the last step had zoomed — the ending was not deterministic.
        await page.evaluate(
          ([c, s, hint]) => {
            window.__demovid!.cursorZoom((c as { k: number }).k);
            return window.__demovid!.cameraTo(c as never, s as never, hint as number);
          },
          [cam, springConstants(preset), preset.camera.spring.perceivedMs] as const,
        );
        // Hold for the compositor's re-raster window only — the promise above
        // already covers the movement. Text is soft mid-move, crisp once landed.
        await sleep(preset.camera.rasterHoldMs ?? 180);
        tl.end(move);
      }
    }

    await page.evaluate((sel) => window.__demovid!.spotlightOn(sel), step.target);
    tl.mark("spotlight-on", { selector: step.target }, index);

    const box = await page.evaluate((sel) => window.__demovid!.rectOf(sel), step.target);
    if (box) {
      const travel = tl.mark("cursor-travel", { to: { x: box.x + box.w / 2, y: box.y + box.h / 2 } }, index);
      await page.evaluate(
        ([x, y, w]) => window.__demovid!.cursorTo(x as number, y as number, w as number),
        [box.x + box.w / 2, box.y + box.h / 2, Math.min(box.w, box.h)] as const,
      );
      tl.end(travel);
    }
  } else {
    await page.evaluate(() => window.__demovid!.spotlightOff());
    tl.mark("spotlight-off", undefined, index);
  }

  // ── narrate ──────────────────────────────────────────────────────────────
  // Balloon off means the text has another renderer downstream, so it must not
  // reach the dwell budget either: a reading allowance for text nobody displays
  // would hold a frame for no reason.
  const balloonText = caps.balloon ? balloonTextOf(step, caps.text) : undefined;
  if (balloonText) {
    await page.evaluate(
      ([text, sel]) => window.__demovid!.say(text as string, (sel as string | undefined) ?? undefined),
      // Unanchored on a step waiting for something to LEAVE: the balloon would be
      // pinned to an element that is about to be removed, or is already gone.
      [balloonText, vanishing ? undefined : step.target] as const,
    );
    tl.mark("balloon-show", { text: balloonText }, index);
  }

  let audioMs = 0;
  for (const [ci, clip] of clips.entries()) {
    const ref = { src: `${CLIP_ORIGIN}/${clip.id}.mp3`, durationMs: Math.round(clip.durationS * 1000), text: clip.text };
    await page.evaluate((c) => window.__demovid!.preloadClip(c as never), ref as never);

    // Observed, not predicted. The span brackets the actual `play()`→`onended`
    // round trip, which is what `measured: true` in the timeline claims.
    const startedAt = Date.now();
    const outcome = await page.evaluate(
      ([c, idx]) => window.__demovid!.playClip(c as never, idx as number),
      [ref, ci] as const,
    );
    const endedAt = Date.now();

    tl.span("clip-start", startedAt, endedAt, { id: clip.id, text: clip.text, outcome }, index);
    tl.narrate({
      id: clip.id,
      stepIndex: index,
      sentenceIndex: ci,
      text: clip.text,
      startMs: startedAt,
      endMs: endedAt,
      measured: outcome === "ended",
    });

    if (outcome !== "ended") log(`áudio ${clip.id} terminou como "${outcome}"`);
    audioMs += ref.durationMs;
  }

  // ── act ──────────────────────────────────────────────────────────────────
  // Trusted events, always. The synthetic cursor already drew where this lands.
  const act = tl.mark(
    step.action === "goto" ? "navigate" : (step.action as never),
    { target: step.target, value: step.value },
    index,
  );
  switch (step.action) {
    case "click": {
      await page.evaluate(() => window.__demovid!.cursorClick());
      tl.mark("cursor-click", { target: step.target }, index);
      await locatorFor(page, step.target!).click({ timeout: 10_000 });
      break;
    }
    case "type": {
      await locatorFor(page, step.target!).click({ timeout: 10_000 });
      // A human-ish cadence: instant text on screen reads as a bug, not a demo.
      await locatorFor(page, step.target!).pressSequentially(step.value ?? "", { delay: 55 });
      break;
    }
    case "hover":
      await locatorFor(page, step.target!).hover({ timeout: 10_000 });
      break;
    case "focus":
      await locatorFor(page, step.target!).focus({ timeout: 10_000 });
      break;
    case "scroll":
      if (step.target) await locatorFor(page, step.target).scrollIntoViewIfNeeded({ timeout: 5000 });
      break;
    case "goto":
      await page.goto(step.value!, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // WITH the style. A navigation gives a fresh document, so this rebuilds the
      // overlay from scratch — and a styleless rebuild fell back to DEFAULT_STYLE.
      await page.evaluate(
        (style) => window.__demovid?.mount(style),
        overlayStyleOf(preset) as never,
      );
      break;
    case "wait": {
      // `waitFor` defaults to `visible`, which is what this did before the field
      // existed — an old storyboard keeps its exact behaviour.
      if (step.target) {
        await locatorFor(page, step.target).waitFor({ state: step.waitFor ?? "visible", timeout });
      } else {
        await sleep(Math.min(Number(step.value ?? 0), timeout));
      }
      break;
    }
  }

  // ── settle ───────────────────────────────────────────────────────────────
  //
  // Between the action and the dwell, because the dwell is the shot: time spent
  // waiting here is time the viewer does not spend looking at a spinner, and the
  // preset's pacing then applies to a finished screen instead of a loading one.
  //
  // Never fatal. A settle that times out means the app is still busy, and the
  // recording that shows that honestly is more useful than a failed step — so it
  // is logged, marked on the timeline, and the take goes on.
  if (SETTLING_ACTIONS.has(step.action)) {
    const outcome = await settle(page, loaders, step.timeoutMs ?? SETTLE_DEFAULT_MS);
    if (outcome !== "skipped") tl.mark("settle", { outcome }, index);
    if (outcome === "timeout") {
      log(`passo ${index}: o app ainda estava carregando depois de ${step.timeoutMs ?? SETTLE_DEFAULT_MS}ms`);
    }
  }

  // `expect` is checked AFTER the settle, so it only pays for what the settle
  // could not see: a result that needs a second round trip, a list repainted by a
  // websocket frame. Unlike `target` it is not constrained to the inventory —
  // the element usually does not exist yet at crawl time, which is the point.
  if (step.expect) {
    const wait = tl.mark("expect", { target: step.expect }, index);
    await locatorFor(page, step.expect).waitFor({ state: "visible", timeout });
    tl.end(wait);
  }

  tl.end(act);

  // ── dwell ────────────────────────────────────────────────────────────────
  //
  // With `audioMs` at 0 — every silent step — `dwellFor` falls through to its
  // text floors, which is what they were written for: `max(byWords, byReading)`.
  // No separate silent-pacing path is needed, and adding one would be a second
  // place for the two numbers to disagree.
  const dwell = dwellFor(preset, audioMs, balloonText ?? "");
  const holdMs = Math.max(0, dwell - audioMs) + (step.holdMs ?? 0);
  if (holdMs > 0) {
    const wait = tl.mark("dwell", { reason: step.holdMs ? "holdMs" : "ritmo do preset", holdMs }, index);
    await sleep(holdMs);
    tl.end(wait);
  }
  await page.evaluate(() => window.__demovid!.hush());
  tl.mark("balloon-hide", undefined, index);
}
