/**
 * The `gpu-screen-recorder` backend — the good one.
 *
 * A direct translation of what the bash wrapper exec'd, with the interactive
 * parts dropped because demovid always knows its target. Three choices carried
 * over verbatim because they were paid for upstream:
 *
 *  - `-ac aac`, never flac: flac is disabled in gsr 5.13.9 and fails at start.
 *  - Stop is SIGINT. SIGKILL leaves an MP4 with no moov atom — unplayable.
 *  - Pause is SIGUSR2 and it is a TOGGLE, reported on stderr as `Paused` /
 *    `Unpaused`. A toggle you cannot query is a toggle you will desynchronise,
 *    so the state is tracked AND reconciled against those lines.
 *
 * One deliberate change from the wrapper: `-fm cfr`. gsr defaults to `vfr`, and
 * a variable frame rate makes the millisecond→frame mapping in the timeline
 * ambiguous and the final scale pass lossier. This repository already measured
 * a 50 s capture at a 16.66 ms median frame interval against an ideal 16.67,
 * σ = 0.67 ms — there is no jitter worth preserving by staying on vfr.
 */
import type { BackendPlan, RecChild, RecOptions, RecorderBackend } from "./types.js";

/** `-w` takes the target directly; only `region` needs a second flag. */
function targetArgs(o: RecOptions): string[] {
  switch (o.target.kind) {
    case "window":
      return ["-w", o.target.windowId];
    case "monitor":
      return ["-w", o.target.name];
    case "screen":
      return ["-w", "screen"];
    case "region":
      return ["-w", "region", "-region", o.target.region];
  }
}

export const gsrBackend: RecorderBackend = {
  name: "gsr",

  capabilities: { pause: true, followsWindow: true, firstFrameTs: true },

  plan(o: RecOptions): Promise<BackendPlan> {
    const codec = o.codec ?? "h264";
    const args: string[] = [
      ...targetArgs(o),
      "-f",
      String(o.fps ?? 60),
      "-k",
      codec,
      "-ac",
      "aac",
      "-q",
      o.quality ?? "very_high",
      // NO real cursor. demovid draws a synthetic one, aimed and timed to the
      // narration; capturing the OS pointer too puts two cursors in the frame,
      // and the real one sits wherever the operator last left it — which is how
      // a browser tab hover-card ended up in the middle of a recording.
      "-cursor",
      "no",
      "-fm",
      "cfr",
    ];

    // gsr's CPU fallback only implements H264, so offering it for hevc/av1
    // would advertise a path that cannot exist.
    if (codec === "h264") args.push("-encoder", "gpu", "-fallback-cpu-encoding", "yes");

    if (o.audio !== "none") args.push("-a", "default_output");

    const plan: BackendPlan = { bin: "gpu-screen-recorder", args };

    if (o.firstFrameTs) {
      args.push("-write-first-frame-ts", "yes");
      // Documented in gpu-screen-recorder(1): a sidecar with the extra
      // extension `.ts`, holding `monotonic_microsec realtime_microsec`.
      plan.firstFrameTsPath = `${o.output}.ts`;
    }

    args.push("-o", o.output);
    return Promise.resolve(plan);
  },

  requestStop(child: RecChild): void {
    child.kill("SIGINT");
  },

  readPauseState(line: string): boolean | null {
    if (line.includes("Unpaused")) return false;
    if (line.includes("Paused")) return true;
    return null;
  },
};
