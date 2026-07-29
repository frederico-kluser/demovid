/**
 * The ffmpeg fallback, for machines without `gpu-screen-recorder`.
 *
 * Everything here was measured on this codebase's reference machine rather than
 * assumed, because two of the four findings contradict the obvious command:
 *
 *  1. **x11grab really does take `-window_id`** and derives the geometry
 *     itself, so the common case is not a fixed region after all.
 *  2. **libx264 refuses odd dimensions.** Capturing a real browser window at
 *     1920x1163 fails outright with `height not divisible by 2`, producing an
 *     MP4 with no moov atom. Browser windows are routinely odd once a title bar
 *     is involved, so the even-crop is mandatory, not defensive. Crop rather
 *     than scale: it drops at most one row/column instead of resampling every
 *     pixel.
 *  3. `default_output` is a gpu-screen-recorder alias, NOT a PulseAudio source.
 *     The real name is `<default sink>.monitor`, which has to be asked for.
 *  4. Both `h264_nvenc` and `h264_vaapi` encode correctly here, so the fallback
 *     is not automatically a CPU fallback.
 *
 * Two capabilities are genuinely missing versus gsr, and they are reported
 * rather than emulated: x11grab fixes its geometry at init, so a window moved
 * mid-capture silently keeps recording the old rectangle; and ffmpeg has no
 * pause that can resume into the same file.
 */
import { access, constants } from "node:fs/promises";
import { run } from "../exec.js";
import type { BackendPlan, RecChild, RecOptions, RecorderBackend } from "./types.js";

/** Constant-quality target per quality rung, for both CRF and NVENC's CQ. */
const QUALITY_CQ: Record<NonNullable<RecOptions["quality"]>, number> = {
  ultra: 15,
  very_high: 18,
  high: 21,
  medium: 25,
};

/**
 * Above this the CPU encoder cannot keep up while Chromium is compositing the
 * very frames being captured, and the result is dropped frames rather than a
 * slow encode. Clamped with a warning instead of silently producing a stuttery
 * file.
 */
const CPU_MAX_PIXELS = 1920 * 1080;
const CPU_MAX_FPS = 30;

type EncoderKind = "nvenc" | "vaapi" | "cpu";

const CPU_ENCODER: Record<NonNullable<RecOptions["codec"]>, string> = {
  h264: "libx264",
  hevc: "libx265",
  av1: "libsvtav1",
};

const VAAPI_DEVICE = "/dev/dri/renderD128";

async function fileExists(path: string): Promise<boolean> {
  return access(path, constants.R_OK).then(
    () => true,
    () => false,
  );
}

let encoderList: string | null = null;
async function hasEncoder(name: string): Promise<boolean> {
  if (encoderList === null) {
    encoderList = await run("ffmpeg", ["-hide_banner", "-encoders"])
      .then((r) => r.stdout)
      .catch(() => "");
  }
  return new RegExp(`\\b${name}\\b`).test(encoderList);
}

/**
 * Pick the best encoder that is both compiled in AND has its device node.
 * `ffmpeg -encoders` listing `h264_vaapi` proves nothing on a machine with no
 * render node, which is the usual way this choice goes wrong.
 */
async function pickEncoder(codec: NonNullable<RecOptions["codec"]>): Promise<EncoderKind> {
  const override = process.env["DEMOVID_FFMPEG_ENCODER"];
  if (override === "nvenc" || override === "vaapi" || override === "cpu") return override;

  if ((await fileExists("/dev/nvidia0")) && (await hasEncoder(`${codec}_nvenc`))) return "nvenc";
  if ((await fileExists(VAAPI_DEVICE)) && (await hasEncoder(`${codec}_vaapi`))) return "vaapi";
  return "cpu";
}

/** Absolute geometry of an X11 window, or null when xdotool cannot say. */
async function windowGeometry(
  windowId: string,
): Promise<{ w: number; h: number; x: number; y: number } | null> {
  try {
    const { stdout } = await run("xdotool", ["getwindowgeometry", "--shell", windowId]);
    const read = (key: string): number => {
      const m = new RegExp(`^${key}=(-?\\d+)$`, "m").exec(stdout);
      return m?.[1] ? Number(m[1]) : NaN;
    };
    const w = read("WIDTH");
    const h = read("HEIGHT");
    const x = read("X");
    const y = read("Y");
    if ([w, h, x, y].some(Number.isNaN)) return null;
    return { w, h, x, y };
  } catch {
    return null;
  }
}

/** `:1` and `:1.0` are both valid inputs; region syntax needs the screen part. */
function displaySpec(offset?: { x: number; y: number }): string {
  const raw = process.env["DISPLAY"] ?? ":0";
  const withScreen = /^:\d+$/.test(raw) ? `${raw}.0` : raw;
  return offset ? `${withScreen}+${offset.x},${offset.y}` : withScreen;
}

export const ffmpegBackend: RecorderBackend = {
  name: "ffmpeg",

  capabilities: { pause: false, followsWindow: false, firstFrameTs: false },

  async plan(o: RecOptions): Promise<BackendPlan> {
    const codec = o.codec ?? "h264";
    const encoder = await pickEncoder(codec);
    const cq = QUALITY_CQ[o.quality ?? "very_high"];
    let fps = o.fps ?? 60;

    // ── input: video ────────────────────────────────────────────────────────
    // `-draw_mouse 0` for the same reason gsr gets `-cursor no`: demovid draws
    // its own cursor, and the real one would be a second, stale pointer.
    const video: string[] = ["-f", "x11grab", "-draw_mouse", "0", "-thread_queue_size", "1024"];
    let pixels = Number.POSITIVE_INFINITY;

    if (o.target.kind === "window") {
      const geo = await windowGeometry(o.target.windowId);
      if (geo) pixels = geo.w * geo.h;
      video.push("-window_id", o.target.windowId, "-framerate", String(fps), "-i", displaySpec());
    } else if (o.target.kind === "region") {
      const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(o.target.region);
      const [, w, h, x, y] = m ?? [];
      if (!w || !h || !x || !y) throw new Error(`região inválida: ${o.target.region}`);
      pixels = Number(w) * Number(h);
      video.push(
        "-video_size",
        `${w}x${h}`,
        "-framerate",
        String(fps),
        "-i",
        displaySpec({ x: Number(x), y: Number(y) }),
      );
    } else {
      // `screen` and `monitor` both mean "the whole X display" here; x11grab has
      // no per-monitor concept, so a monitor name cannot be honoured.
      video.push("-framerate", String(fps), "-i", displaySpec());
    }

    // ── clamp, loudly ───────────────────────────────────────────────────────
    const warnings: string[] = [];
    if (encoder === "cpu" && (fps > CPU_MAX_FPS || pixels > CPU_MAX_PIXELS)) {
      if (fps > CPU_MAX_FPS) {
        warnings.push(
          `encoder por CPU: fps reduzido de ${fps} para ${CPU_MAX_FPS} para não derrubar frames`,
        );
        fps = CPU_MAX_FPS;
        const i = video.indexOf("-framerate");
        if (i >= 0) video[i + 1] = String(fps);
      }
      if (pixels > CPU_MAX_PIXELS) {
        warnings.push(
          "encoder por CPU acima de 1080p: espere frames derrubados. Instale gpu-screen-recorder.",
        );
      }
    }

    // ── input: audio ────────────────────────────────────────────────────────
    const audio: string[] = [];
    if (o.audio !== "none") {
      const { stdout } = await run("pactl", ["get-default-sink"]);
      const sink = stdout.trim();
      if (!sink) throw new Error("pactl não devolveu um sink padrão — sem isso a narração não entra");
      audio.push("-f", "pulse", "-thread_queue_size", "1024", "-i", `${sink}.monitor`);
    }

    // ── filters and encoder ─────────────────────────────────────────────────
    // The even-crop is not optional; see the module header.
    const filters = ["crop=trunc(iw/2)*2:trunc(ih/2)*2"];
    const encode: string[] = [];

    switch (encoder) {
      case "nvenc":
        encode.push("-c:v", `${codec}_nvenc`, "-preset", "p4", "-rc", "vbr", "-cq", String(cq));
        break;
      case "vaapi":
        // The device flag must precede the input, so it is prepended below.
        filters.push("format=nv12", "hwupload");
        encode.push("-c:v", `${codec}_vaapi`, "-qp", String(cq));
        break;
      case "cpu":
        encode.push("-c:v", CPU_ENCODER[codec], "-preset", "veryfast", "-crf", String(cq));
        break;
    }

    const args: string[] = [
      "-hide_banner",
      "-loglevel",
      "warning",
      ...(encoder === "vaapi" ? ["-vaapi_device", VAAPI_DEVICE] : []),
      ...video,
      ...audio,
      "-vf",
      filters.join(","),
      ...encode,
      ...(encoder === "vaapi" ? [] : ["-pix_fmt", "yuv420p"]),
      "-fps_mode",
      "cfr",
      ...(o.audio === "none" ? ["-an"] : ["-c:a", "aac", "-b:a", "192k"]),
      "-movflags",
      "+faststart",
      "-y",
      o.output,
    ];

    const plan: BackendPlan = { bin: "ffmpeg", args };
    for (const w of warnings) o.onLine?.(`aviso: ${w}`);
    return plan;
  },

  /**
   * `q` on stdin is ffmpeg's clean shutdown: it finalizes the container the way
   * SIGINT does for gsr. The escalation to signals lives in `Recording.stop()`,
   * which already owns the timeout.
   */
  requestStop(child: RecChild): void {
    try {
      child.stdin.write("q");
    } catch {
      child.kill("SIGINT");
    }
  },

  readPauseState(): null {
    return null;
  },
};
