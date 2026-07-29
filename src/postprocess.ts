/**
 * The one post-processing pass, and the reasons it stays exactly one.
 *
 * demovid's whole premise is a single pass: the audio plays live and the screen
 * is captured as-is, so there is no timeline to reconcile. That holds for every
 * format that fits on screen. It cannot hold for a 1080x1920 portrait video,
 * because no monitor here is 1920px tall — so for those, and only those, one
 * ffmpeg pass scales the capture up to the requested size.
 *
 * `-c:a copy` is load-bearing, not an optimisation. Re-encoding the audio would
 * resample it and shift every packet's presentation timestamp, which would
 * silently invalidate the millisecond offsets in the timeline JSON — the
 * artifact whose entire value is that its timestamps are trustworthy.
 */
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "./exec.js";

export interface VideoInfo {
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  videoCodec: string;
  hasAudio: boolean;
}

/** Read the real dimensions and duration of a container. */
export async function probeVideo(path: string): Promise<VideoInfo> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate",
    "-of",
    "json",
    path,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
    }>;
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const [num, den] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number);

  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    fps: den ? Number(((num ?? 0) / den).toFixed(3)) : 0,
    videoCodec: video?.codec_name ?? "?",
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

export interface FinalizeOptions {
  /** Remove browser chrome from the top before scaling. */
  crop?: { w: number; h: number; x: number; y: number };
  /** Resample to exactly this size. */
  scale?: { w: number; h: number };
  /**
   * Letterbox instead of distorting when the cropped aspect does not exactly
   * match `scale`. Costs a few black pixels; the alternative is a subtly
   * stretched app, which is far worse and much harder to notice.
   */
  pad?: boolean;
  onLog?: (line: string) => void;
}

export interface FinalizeResult {
  /** False when nothing needed doing — the capture was already correct. */
  changed: boolean;
  info: VideoInfo;
}

/**
 * Apply crop and/or scale in place. A no-op when neither is requested, which is
 * the path every landscape recording takes.
 *
 * Writes a sibling temp file and renames over the original, because ffmpeg
 * cannot read and write the same path.
 */
export async function finalizeVideo(path: string, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
  const filters: string[] = [];

  if (opts.crop) {
    const { w, h, x, y } = opts.crop;
    filters.push(`crop=${w}:${h}:${x}:${y}`);
  }
  if (opts.scale) {
    // lanczos because this is almost always an upscale of text, where bilinear
    // reads as blur and lanczos keeps the glyph edges defined.
    if (opts.pad) {
      filters.push(
        `scale=${opts.scale.w}:${opts.scale.h}:force_original_aspect_ratio=decrease:flags=lanczos`,
        `pad=${opts.scale.w}:${opts.scale.h}:(ow-iw)/2:(oh-ih)/2:black`,
      );
    } else {
      filters.push(`scale=${opts.scale.w}:${opts.scale.h}:flags=lanczos`);
    }
  }

  if (filters.length === 0) {
    return { changed: false, info: await probeVideo(path) };
  }

  const tmp = join(dirname(path), `.demovid-finalize-${process.pid}.mp4`);
  opts.onLog?.(`pós-processando: ${filters.join(", ")}`);

  try {
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      // See the module header: never re-encode the audio.
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      "-y",
      tmp,
    ]);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  return { changed: true, info: await probeVideo(path) };
}
