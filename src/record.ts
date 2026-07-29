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
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import "./overlay-api.js"; // traz a declaração de `window.__demovid`
import { launchBrowser, type LaunchedBrowser } from "./browser.js";
import { synthesize, type Clip } from "./openai/tts.js";
import { applyLocale, dwellFor, LOCALES, PRESETS, type Preset } from "./presets/index.js";
import { startRecording, type Recording } from "./rec.js";
import { splitSentences } from "./openai/tts.js";
import type { Step, Storyboard } from "./storyboard.js";

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
  /** Skip `rec` entirely — drives the browser and reports, records nothing. */
  rehearse?: boolean;
  onLog?: (line: string) => void;
}

export interface RecordReport {
  output: string | null;
  bytes: number;
  steps: StepReport[];
  cameraRung: "R1" | "R3";
  warnings: string[];
}

export interface StepReport {
  index: number;
  action: string;
  target?: string | undefined;
  ok: boolean;
  detail?: string;
  ms: number;
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
    return preset;
  }
  return applyLocale(preset, locale);
}

/** Playwright locator for a step's target. Accepts CSS or `text=` / `role=`. */
function locatorFor(page: Page, target: string): Locator {
  return page.locator(target).first();
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
  const cacheDir = opts.cacheDir ?? join(process.cwd(), ".demovid-cache");
  await mkdir(cacheDir, { recursive: true });

  const perStep = sb.steps.map((s) => (s.say ? splitSentences(s.say) : []));
  const clips = await synthesize(perStep.flat(), {
    cacheDir,
    profile: { voice: preset.voice.voice, instructions: preset.voice.instructions, targetWpm: preset.voice.targetWpm },
    onProgress: (d, t, cached) => log(`voz ${d}/${t}${cached ? " (cache)" : ""}`),
  });

  // Map each step back to its clips, in order.
  const clipsByStep: Clip[][] = [];
  let cursorIdx = 0;
  for (const sentences of perStep) {
    clipsByStep.push(clips.slice(cursorIdx, cursorIdx + sentences.length));
    cursorIdx += sentences.length;
  }

  // ── 2. browser ────────────────────────────────────────────────────────────
  const browser = await launchBrowser({
    width: opts.width ?? 1600,
    height: opts.height ?? 1000,
    ...(opts.x !== undefined ? { x: opts.x } : {}),
    ...(opts.y !== undefined ? { y: opts.y } : {}),
  });
  await serveClips(browser, clips);

  let recording: Recording | null = null;
  const steps: StepReport[] = [];
  let cameraRung: "R1" | "R3" = "R1";

  try {
    const page = browser.page;
    await page.goto(sb.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {
      warnings.push("a página não chegou a `load` em 30s — seguindo com o que carregou");
    });

    const mounted = await page.evaluate((style) => window.__demovid?.mount(style), {
      cursor: { ...preset.cursor, accent: preset.balloon.accent },
      spotlight: { ...preset.spotlight, accent: preset.balloon.accent },
      balloon: preset.balloon,
    } as never);

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
    if (!opts.rehearse) {
      recording = await startRecording({
        target: { kind: "window", windowId: browser.windowId },
        output: opts.output,
        audio: "system",
        fps: 60,
        onLine: (l) => {
          if (BENIGN_REC_NOISE.some((re) => re.test(l))) return;
          if (/error|failed|warning/i.test(l)) log(`rec: ${l}`);
        },
      });
      log(`gravando janela ${browser.windowId} → ${opts.output}`);
      await sleep(600); // deixa o encoder estabilizar antes do primeiro movimento
    }

    // ── 4. os passos ────────────────────────────────────────────────────────
    for (const [i, step] of sb.steps.entries()) {
      const t0 = Date.now();
      const report: StepReport = { index: i, action: step.action, target: step.target, ok: true, ms: 0 };
      try {
        await runStep(page, step, preset, clipsByStep[i] ?? [], cameraRung, log);
      } catch (err) {
        report.ok = false;
        report.detail = (err as Error).message;
        warnings.push(`passo ${i} (${step.action}): ${report.detail}`);
        log(`passo ${i} FALHOU: ${report.detail}`);
      }
      report.ms = Date.now() - t0;
      steps.push(report);
      await sleep(preset.pacing.gapMs);
    }

    // Land the camera and clear the overlay before the final frames, so the
    // video does not end mid-zoom with a balloon still up.
    await page.evaluate(() => {
      window.__demovid!.hush();
      window.__demovid!.spotlightOff();
      window.__demovid!.setCamera({ tx: 0, ty: 0, k: 1 });
      window.__demovid!.cursorZoom(1);
    });
    await sleep(900);

    if (recording) {
      const stopped = await recording.stop();
      recording = null;
      return { output: stopped.output, bytes: stopped.bytes, steps, cameraRung, warnings };
    }
    return { output: null, bytes: 0, steps, cameraRung, warnings };
  } finally {
    // Unconditional — never `if (recording.running)`. That guard once left a
    // gpu-screen-recorder capturing the desktop after the process exited.
    await recording?.dispose();
    await browser.close();
  }
}

/** One step: aim, narrate, act. */
async function runStep(
  page: Page,
  step: Step,
  preset: Preset,
  clips: Clip[],
  rung: "R1" | "R3",
  log: (s: string) => void,
): Promise<void> {
  // ── aim ──────────────────────────────────────────────────────────────────
  if (step.target) {
    const loc = locatorFor(page, step.target);
    await loc.waitFor({ state: "visible", timeout: 10_000 });
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
        await page.evaluate(
          ([c, dur, ease]) => {
            const st = document.getElementById("__demovid_stage");
            if (st) st.style.transition = `transform ${dur as number}ms ${ease as string}`;
            window.__demovid!.setCamera(c as never);
            window.__demovid!.cursorZoom((c as { k: number }).k);
          },
          [cam, preset.camera.spring.durationMs, preset.camera.spring.easing] as const,
        );
        // Hold until the spring has visually settled, plus the compositor's
        // re-raster window — text is soft mid-move and crisp once it lands.
        await sleep(preset.camera.spring.perceivedMs + 180);
      }
    }

    await page.evaluate((sel) => window.__demovid!.spotlightOn(sel), step.target);

    const box = await page.evaluate((sel) => window.__demovid!.rectOf(sel), step.target);
    if (box) {
      await page.evaluate(
        ([x, y, w]) => window.__demovid!.cursorTo(x as number, y as number, w as number),
        [box.x + box.w / 2, box.y + box.h / 2, Math.min(box.w, box.h)] as const,
      );
    }
  } else {
    await page.evaluate(() => window.__demovid!.spotlightOff());
  }

  // ── narrate ──────────────────────────────────────────────────────────────
  if (step.say) {
    await page.evaluate(
      ([text, sel]) => window.__demovid!.say(text as string, (sel as string | undefined) ?? undefined),
      [step.say, step.target] as const,
    );
  }

  let audioMs = 0;
  for (const [ci, clip] of clips.entries()) {
    const ref = { src: `${CLIP_ORIGIN}/${clip.id}.mp3`, durationMs: Math.round(clip.durationS * 1000), text: clip.text };
    await page.evaluate((c) => window.__demovid!.preloadClip(c as never), ref as never);
    const outcome = await page.evaluate(
      ([c, idx]) => window.__demovid!.playClip(c as never, idx as number),
      [ref, ci] as const,
    );
    if (outcome !== "ended") log(`áudio ${clip.id} terminou como "${outcome}"`);
    audioMs += ref.durationMs;
  }

  // ── act ──────────────────────────────────────────────────────────────────
  // Trusted events, always. The synthetic cursor already drew where this lands.
  switch (step.action) {
    case "click": {
      await page.evaluate(() => window.__demovid!.cursorClick());
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
      await page.evaluate(() => window.__demovid?.mount());
      break;
    case "wait": {
      if (step.target) await locatorFor(page, step.target).waitFor({ state: "visible", timeout: 15_000 });
      else await sleep(Math.min(Number(step.value ?? 0), 15_000));
      break;
    }
  }

  // ── dwell ────────────────────────────────────────────────────────────────
  const dwell = dwellFor(preset, audioMs, step.say ?? "");
  await sleep(Math.max(0, dwell - audioMs) + (step.holdMs ?? 0));
  await page.evaluate(() => window.__demovid!.hush());
}
