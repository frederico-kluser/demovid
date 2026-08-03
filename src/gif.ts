/**
 * The animated-image encoder: the captured MP4 in, a GIF (or animated WebP) out.
 *
 * This is a second post-processing pass, and the one-pass invariant deserves an
 * explicit answer rather than a quiet exception. The invariant is about the
 * *timeline*: audio plays live and `audio.onended` advances the step, so there is
 * only ever one clock and nothing to reconcile. Silent output has no audio clock
 * at all, so transcoding the finished capture introduces no second clock — it
 * re-containers a file whose timing is already settled. `src/postprocess.ts`
 * takes the same exception for portrait video, for the same reason.
 *
 * Two things about GIF drive every parameter below:
 *
 *  - **256 colours, chosen once.** A single global palette across a whole demo
 *    posterises gradients and UI shadows. `palettegen=stats_mode=diff` weights
 *    the histogram toward the pixels that actually *change*, which is where the
 *    eye is, and `paletteuse=diff_mode=rectangle` restricts re-dithering to the
 *    changed rectangle so a static background does not shimmer between frames.
 *    That shimmer is the classic "why is my GIF 40 MB" cause: it makes every
 *    frame differ from the last, defeating the format's only compression.
 *
 *  - **No inter-frame compression worth the name.** Size is driven by how many
 *    frames *differ*, not by resolution. So the budget lever is the frame rate,
 *    not the dimensions: dropping 15→10 fps removes a third of the frames while
 *    scaling down would blur the text the caption is pointing at.
 *
 * Palette handoff goes through a real temp file, not a pipe, because `run()`
 * spawns without a shell on purpose (see `src/exec.ts`). Two invocations plus a
 * file is the price of that, and it is worth paying.
 */
import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "./exec.js";

export type AnimationFormat = "gif" | "webp";

export const ANIMATION_FORMATS: readonly AnimationFormat[] = ["gif", "webp"];

export const isAnimationFormat = (s: string): s is AnimationFormat =>
  (ANIMATION_FORMATS as readonly string[]).includes(s);

/** 5 MB. GitHub caps images in issues and PR comments at 10 MB; half of that
 *  keeps a README GIF comfortable on a phone connection too. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** 960px reads a UI screenshot fine inside GitHub's ~880px content column. */
export const DEFAULT_WIDTH = 960;

/**
 * Frame rates to try, in order.
 *
 * 15 is where UI motion still reads as motion; below 8 a cursor travel starts to
 * look like teleporting, which is why the ladder stops at 5 rather than going to
 * 2 — past that the file is small and the demo is unreadable, which is not a
 * trade the operator asked for.
 */
const FPS_LADDER = [15, 12, 10, 8, 6, 5] as const;

/**
 * The rungs still available when starting from `fps`, highest first.
 *
 * Exported because it is the whole budget policy expressed as a pure function,
 * and the alternative — asserting it through a real encode — would make the
 * cheap test suite depend on ffmpeg. The two properties worth pinning are that
 * `--fps 10` never encodes at 15 first (it would be paid for and thrown away),
 * and that the result is never empty, because the caller dereferences its last
 * result.
 */
export function ladderFrom(fps?: number): readonly number[] {
  if (fps === undefined) return FPS_LADDER;
  const i = FPS_LADDER.findIndex((f) => f <= fps);
  // Asked for something below the floor: the floor is what it gets, not nothing.
  return i === -1 ? FPS_LADDER.slice(-1) : FPS_LADDER.slice(i);
}

export interface EncodeOptions {
  /** The captured MP4. Not modified. */
  input: string;
  /** Where the animation goes. Extension should match `format`. */
  output: string;
  format: AnimationFormat;
  /** Starting frame rate. Clamped into the ladder. */
  fps?: number;
  /** Long edge in px. Never upscales beyond the source width. */
  width?: number;
  /** Hard ceiling. Frames are dropped until the file fits. */
  maxBytes?: number;
  onLog?: (line: string) => void;
}

export interface EncodeResult {
  bytes: number;
  /** The frame rate that actually shipped. */
  fps: number;
  width: number;
  /** How many encodes it took. >1 means the budget forced a retry. */
  attempts: number;
  /** False when even the slowest rung stayed over budget. */
  withinBudget: boolean;
}

/**
 * Encode, then keep dropping frames until the file fits the budget.
 *
 * Returns rather than throws when the ladder runs out: the operator asked for a
 * GIF, and a 6 MB GIF plus a loud warning is more useful than no GIF at all. The
 * caller decides how loudly to complain.
 */
export async function encodeAnimation(opts: EncodeOptions): Promise<EncodeResult> {
  const log = opts.onLog ?? ((): void => {});
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const width = opts.width ?? DEFAULT_WIDTH;

  const ladder = ladderFrom(opts.fps);

  let attempts = 0;
  let last: EncodeResult | null = null;

  for (const fps of ladder) {
    attempts += 1;
    await encodeOnce(opts.input, opts.output, opts.format, fps, width, log);
    const bytes = (await stat(opts.output)).size;
    last = { bytes, fps, width, attempts, withinBudget: bytes <= maxBytes };

    const mb = (bytes / 1024 / 1024).toFixed(2);
    if (bytes <= maxBytes) {
      log(`${opts.format} a ${fps}fps: ${mb} MB — dentro do limite de ${mbOf(maxBytes)} MB`);
      return last;
    }
    log(`${opts.format} a ${fps}fps: ${mb} MB — acima de ${mbOf(maxBytes)} MB, tirando quadros`);
  }

  // The ladder is exhausted. `last` cannot be null: `ladderFrom` never returns
  // an empty list, which is the property its unit test pins.
  return last!;
}

/** One decimal below 10 MB, none above. A budget printed as "0 MB" reads as a bug. */
const mbOf = (bytes: number): string => {
  const mb = bytes / 1024 / 1024;
  return mb < 10 ? mb.toFixed(1) : mb.toFixed(0);
};

/**
 * One encode at a fixed frame rate.
 *
 * `scale=w='min(W,iw)'` rather than a bare width: upscaling a 800px capture to
 * 960 would spend bytes inventing pixels, and in a palette format invented pixels
 * are invented palette entries.
 */
async function encodeOnce(
  input: string,
  output: string,
  format: AnimationFormat,
  fps: number,
  width: number,
  log: (line: string) => void,
): Promise<void> {
  // The comma inside `min()` needs NO backslash: it is already inside single
  // quotes, and ffmpeg's filter parser treats a backslash *literally* within
  // them. Escaping it produces `min(960\,iw)`, which is not a valid expression,
  // and the parser reports it as `No such filter: ''` — an error message that
  // points at the graph separators instead of at the argument that is wrong.
  const chain = `fps=${fps},scale=w='min(${width},iw)':h=-2:flags=lanczos`;

  if (format === "webp") {
    // `-lossless 0` with q 72: measured smaller than lossless by an order of
    // magnitude on UI footage, and UI footage is where lossless WebP is supposed
    // to shine. Text stays crisp because the quantiser is not the blurry part —
    // chroma subsampling is, and libwebp keeps 4:2:0 either way.
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-vf", chain,
      "-c:v", "libwebp_anim",
      "-lossless", "0",
      "-q:v", "72",
      "-compression_level", "6",
      "-loop", "0",
      "-an",
      "-y", output,
    ]);
    return;
  }

  // GIF: palette first, then apply it. `stats_mode=diff` and `diff_mode=rectangle`
  // are the pair that keeps a static background from re-dithering every frame.
  const palette = join(dirname(output), `.demovid-palette-${process.pid}.png`);
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-vf", `${chain},palettegen=stats_mode=diff`,
      "-y", palette,
    ]);
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-i", palette,
      "-lavfi", `${chain}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      "-loop", "0",
      "-an",
      "-y", output,
    ]);
  } finally {
    await rm(palette, { force: true }).catch(() => {
      log("não consegui apagar a paleta temporária — inofensivo, mas ficou no disco");
    });
  }
}

export interface SilentMp4Options {
  /** The captured MP4. Not modified. */
  input: string;
  /** Where the re-encoded MP4 goes. */
  output: string;
  /** Long edge in px. Never upscales beyond the source width. */
  width?: number;
  onLog?: (line: string) => void;
}

/**
 * Re-encode a captured MP4 for silent output.
 *
 * The contract is different from the animation encoder: there is no budget, no
 * frame-rate ladder, and no size ceiling. The goal is a small-but-readable file,
 * not a file that fits inside N megabytes. The research-backed defaults are
 * CRF 30 (readable UI text, small file), preset veryslow (best compression per
 * bit), tune stillimage (preserve sharp edges), and a sparse keyframe interval
 * (low-motion screen content does not need frequent intra frames).
 */
export async function encodeSilentMp4(opts: SilentMp4Options): Promise<{ bytes: number; width: number }> {
  const log = opts.onLog ?? ((): void => {});
  const width = opts.width ?? DEFAULT_WIDTH;

  const chain = `scale=w='min(${width},iw)':h=-2:flags=lanczos`;

  log("reencodando para MP4 silencioso (CRF 30, tune stillimage, sem áudio)");

  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", opts.input,
    "-vf", chain,
    "-c:v", "libx264",
    "-crf", "30",
    "-preset", "veryslow",
    "-tune", "stillimage",
    "-g", "300",
    "-pix_fmt", "yuv420p",
    "-an",
    "-y", opts.output,
  ]);

  const bytes = (await stat(opts.output)).size;
  const mb = (bytes / 1024 / 1024).toFixed(2);
  log(`mp4-silent: ${mb} MB, ${width}px wide`);
  return { bytes, width };
}
