/**
 * Unit tests for the embedded recorder.
 *
 * These cover argument construction and the two `/proc` readers, which is
 * exactly the part that used to be bash and therefore had no tests at all. The
 * signal semantics and the real capture stay in `test/record.e2e.ts` — they
 * cannot be proven without a live encoder.
 *
 *   node --import tsx --test test/recorder.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ffmpegBackend } from "../src/recorder/backend-ffmpeg.js";
import { gsrBackend } from "../src/recorder/backend-gsr.js";
import { findRunningCaptures } from "../src/recorder/guard.js";
import { importSessionEnv, SESSION_ENV_KEYS } from "../src/recorder/session-env.js";
import { isRecorderBackend, type RecOptions } from "../src/recorder/types.js";

const base: RecOptions = {
  target: { kind: "window", windowId: "12345" },
  output: "/tmp/demovid-test.mp4",
};

/** Value of the flag immediately following `flag`, or undefined. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

test("isRecorderBackend is a real guard over the closed vocabulary", () => {
  assert.equal(isRecorderBackend("gsr"), true);
  assert.equal(isRecorderBackend("ffmpeg"), true);
  assert.equal(isRecorderBackend("obs"), false);
  assert.equal(isRecorderBackend(""), false);
});

test("gsr: a window target becomes -w <id>, and -o comes last", async () => {
  const { bin, args } = await gsrBackend.plan(base);
  assert.equal(bin, "gpu-screen-recorder");
  assert.equal(flagValue(args, "-w"), "12345");
  assert.equal(args.at(-2), "-o");
  assert.equal(args.at(-1), "/tmp/demovid-test.mp4");
});

test("gsr: audio codec is aac, never flac", async () => {
  // flac is disabled in gpu-screen-recorder 5.13.9 and fails at start. This is
  // the kind of constant that gets "improved" by someone reading the help text.
  const { args } = await gsrBackend.plan(base);
  assert.equal(flagValue(args, "-ac"), "aac");
});

test("gsr: frame mode is cfr, so ms map to frames unambiguously", async () => {
  const { args } = await gsrBackend.plan(base);
  assert.equal(flagValue(args, "-fm"), "cfr");
});

test("gsr: the CPU fallback is offered for h264 only", async () => {
  const h264 = await gsrBackend.plan({ ...base, codec: "h264" });
  assert.equal(flagValue(h264.args, "-fallback-cpu-encoding"), "yes");

  // gsr's CPU encoder implements H264 and nothing else, so advertising the
  // fallback for hevc/av1 would promise a path that cannot exist.
  const hevc = await gsrBackend.plan({ ...base, codec: "hevc" });
  assert.equal(hevc.args.includes("-fallback-cpu-encoding"), false);
});

test("gsr: system audio asks for the sink monitor; none asks for nothing", async () => {
  const withAudio = await gsrBackend.plan({ ...base, audio: "system" });
  assert.equal(flagValue(withAudio.args, "-a"), "default_output");

  const muted = await gsrBackend.plan({ ...base, audio: "none" });
  assert.equal(muted.args.includes("-a"), false);
});

test("gsr: the first-frame timestamp lands beside the video, as documented", async () => {
  const off = await gsrBackend.plan(base);
  assert.equal(off.firstFrameTsPath, undefined);

  const on = await gsrBackend.plan({ ...base, firstFrameTs: true });
  assert.equal(flagValue(on.args, "-write-first-frame-ts"), "yes");
  assert.equal(on.firstFrameTsPath, "/tmp/demovid-test.mp4.ts");
});

test("gsr: a region target needs both -w region and -region", async () => {
  const { args } = await gsrBackend.plan({
    ...base,
    target: { kind: "region", region: "800x600+10+20" },
  });
  assert.equal(flagValue(args, "-w"), "region");
  assert.equal(flagValue(args, "-region"), "800x600+10+20");
});

test("ffmpeg: the even-crop filter is always present", async () => {
  // Measured: libx264 refuses odd dimensions outright ("height not divisible
  // by 2") and leaves an MP4 with no moov atom. Real browser windows are
  // routinely odd once a title bar is involved, so this is not defensive.
  // Asserted for every encoder rung, because the crop is the first filter in
  // all of them — vaapi merely appends `format=nv12,hwupload` after it.
  for (const encoder of ["cpu", "nvenc", "vaapi"] as const) {
    process.env["DEMOVID_FFMPEG_ENCODER"] = encoder;
    const { args } = await ffmpegBackend.plan({ ...base, audio: "none" });
    const vf = flagValue(args, "-vf") ?? "";
    assert.match(vf, /^crop=trunc\(iw\/2\)\*2:trunc\(ih\/2\)\*2/, `encoder ${encoder}`);
  }
  delete process.env["DEMOVID_FFMPEG_ENCODER"];
});

test("ffmpeg: capabilities are reported honestly, not emulated", async () => {
  assert.equal(ffmpegBackend.capabilities.pause, false);
  assert.equal(ffmpegBackend.capabilities.followsWindow, false);
  assert.equal(gsrBackend.capabilities.pause, true);
  assert.equal(gsrBackend.capabilities.followsWindow, true);
});

test("ffmpeg: muted capture disables the audio stream explicitly", async () => {
  const { args } = await ffmpegBackend.plan({ ...base, audio: "none" });
  assert.ok(args.includes("-an"), "esperava -an numa captura muda");
  assert.equal(args.includes("-f") && args.includes("pulse"), false);
});

test("gsr reads its pause toggle off stderr; ffmpeg has no such state", () => {
  assert.equal(gsrBackend.readPauseState("Paused"), true);
  assert.equal(gsrBackend.readPauseState("Unpaused"), false);
  assert.equal(gsrBackend.readPauseState("encoding at 60 fps"), null);
  // "Unpaused" contains "Paused" — order of the checks is load-bearing.
  assert.equal(gsrBackend.readPauseState("Unpaused now"), false);
  // ffmpeg prints no pause state because it has none — even the line that
  // would mean "paused" on the other backend must read as null here.
  assert.equal(ffmpegBackend.readPauseState("Paused"), null);
});

test("importSessionEnv always guarantees XDG_RUNTIME_DIR and never throws", async () => {
  const result = await importSessionEnv();
  assert.ok(typeof result.applied === "object");
  assert.ok(process.env["XDG_RUNTIME_DIR"], "XDG_RUNTIME_DIR ficou vazio");
  // Only allowlisted keys may ever be written — the compositor's environ also
  // carries its PATH, and inheriting that would change binary resolution.
  for (const key of Object.keys(result.applied)) {
    assert.ok(
      (SESSION_ENV_KEYS as readonly string[]).includes(key),
      `chave fora da allowlist foi aplicada: ${key}`,
    );
  }
});

test("findRunningCaptures never reports our own process", async () => {
  const found = await findRunningCaptures();
  assert.ok(Array.isArray(found));
  assert.equal(
    found.some((c) => c.pid === process.pid),
    false,
  );
  for (const c of found) {
    assert.ok(c.kind === "gsr" || c.kind === "ffmpeg");
    assert.ok(c.argv.length > 0);
  }
});
