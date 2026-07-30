/**
 * Render defaults for this project.
 *
 * Deliberately short: every value here is one the CLI would otherwise ask for on
 * each render, and nothing else. Overriding webpack is not needed — the
 * composition imports only `remotion`, `@remotion/media` and
 * `@remotion/transitions`, all of which the default bundler already understands.
 */
import { Config } from "@remotion/cli/config";

// The source is h264 and the output is h264; nothing here needs alpha.
Config.setVideoImageFormat("jpeg");
Config.setCodec("h264");

// The recording is already the right size — see `width`/`height` in the EDL.
Config.setOverwriteOutput(true);
