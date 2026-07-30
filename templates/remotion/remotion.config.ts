/**
 * Render defaults for this project.
 *
 * Deliberately short: every value here is one the CLI would otherwise ask for on
 * each render, and nothing else. Overriding webpack is not needed — the
 * composition imports only `remotion`, `@remotion/media` and
 * `@remotion/transitions`, all of which the default bundler already understands.
 *
 * Nothing here sets CRF: Remotion's default for h264 is already 18.
 */
import { Config } from "@remotion/cli/config";

Config.setCodec("h264");

/**
 * `png`, not `jpeg`, and it is not the trade-off it looks like.
 *
 * Remotion screenshots every frame and pipes it to ffmpeg, so `jpeg` (the default,
 * at quality 80) compresses each frame *before* h264 compresses it again. The source
 * here is a screen recording — hard-edged UI text, which is exactly what JPEG rings
 * around — and the encoder then spends bits reproducing that ringing.
 *
 * Measured on 2026-07-30, 90 frames at 1280×720, this project's own composition with
 * a real `<Video>` in it: jpeg 3852 ms → 261 KB, png 4046 ms → 209 KB. So png cost
 * about 5% more wall clock, inside run-to-run noise, and produced a file **20%
 * smaller** — clean input gives the encoder less to encode. It is also what
 * Remotion's own `--color-space` docs ask for alongside `bt709` below.
 *
 * Flip it back to `"jpeg"` if you are rendering something photographic and long,
 * where the sizes invert.
 */
Config.setVideoImageFormat("png");

/**
 * `bt709`, explicitly.
 *
 * Remotion 4's default is `"default"`, which is the same as `bt601` — and since
 * v4.0.83 it actually *converts*, not just tags. The recording is sRGB/bt709 like
 * every other screen capture, so the default quietly shifts the brand colours on the
 * way out. `bt709` is also what Remotion 5 will default to, so this line is what the
 * upgrade would have written anyway.
 */
Config.setColorSpace("bt709");

Config.setOverwriteOutput(true);
