/**
 * The recorder contract, shared by both backends.
 *
 * demovid used to shell out to `rec`, a bash wrapper living outside this
 * repository, which meant the package could not be installed anywhere. Reading
 * that wrapper end to end established that only three of its 277 lines are
 * load-bearing here — importing the graphical-session env, refusing to start
 * when another capture is live, and translating arguments. Those three moved
 * into `src/recorder/`; the menus, fzf pickers, microphone tracks and container
 * selection were never reachable from demovid and did not come along.
 *
 * Two backends implement this contract and they are NOT interchangeable:
 * `gpu-screen-recorder` encodes on the GPU and can pause; the ffmpeg fallback
 * cannot pause at all and cannot follow a window that moves. `capabilities`
 * exists so callers branch on that explicitly instead of discovering it when a
 * recording silently comes out wrong.
 */
import type { Readable, Writable } from "node:stream";
import type { ChildProcessByStdio } from "node:child_process";

/**
 * Every child is spawned with all three streams piped, even for the backend
 * that ignores stdin, so one type describes both. The gsr backend closes its
 * stdin immediately; the ffmpeg backend needs it, because writing `q` is the
 * only way to make ffmpeg finalize a capture cleanly.
 */
export type RecChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** What to capture. */
export type RecTarget =
  | { kind: "window"; windowId: string }
  | { kind: "monitor"; name: string }
  | { kind: "screen" }
  | { kind: "region"; region: `${number}x${number}+${number}+${number}` };

export const RECORDER_BACKENDS = ["gsr", "ffmpeg"] as const;
export type RecorderBackendName = (typeof RECORDER_BACKENDS)[number];

export function isRecorderBackend(v: string): v is RecorderBackendName {
  return (RECORDER_BACKENDS as readonly string[]).includes(v);
}

export interface RecOptions {
  target: RecTarget;
  /** Absolute path of the MP4 to write. */
  output: string;
  fps?: number;
  /** `very_high` is what text-heavy UI needs; it maps to a CRF on ffmpeg. */
  quality?: "medium" | "high" | "very_high" | "ultra";
  codec?: "h264" | "hevc" | "av1";
  /**
   * `system` captures the default sink's monitor: computer sound, no
   * microphone. That is the whole point — the narration is played by the
   * browser and captured back through the sink monitor.
   */
  audio?: "system" | "none";
  /** Force a backend. Otherwise: gsr if present, else ffmpeg. */
  backend?: RecorderBackendName;
  /**
   * Ask the backend to write the wall-clock timestamp of the first encoded
   * frame beside the output. It is the only exact anchor between the
   * orchestrator's clock and the video's t=0; see `src/timeline.ts`.
   */
  firstFrameTs?: boolean;
  /** Called for every stderr line, for progress plumbing. */
  onLine?: (line: string) => void;
}

export interface RecorderCapabilities {
  /** gsr toggles with SIGUSR2. ffmpeg has no equivalent — none at all. */
  pause: boolean;
  /** gsr follows a window that moves. ffmpeg's x11grab fixes geometry at init. */
  followsWindow: boolean;
  /** gsr can write the first frame's wall-clock timestamp. */
  firstFrameTs: boolean;
}

export class RecError extends Error {
  constructor(
    message: string,
    public readonly stderrTail: string,
  ) {
    super(stderrTail ? `${message}\n${stderrTail}` : message);
    this.name = "RecError";
  }
}

/**
 * Thrown when a caller asks a backend for something it structurally cannot do.
 * Separate from `RecError` because it is a programming/UX decision, not a
 * runtime failure: there is no retry that makes ffmpeg pause.
 */
export class RecCapabilityError extends Error {
  constructor(
    public readonly backend: RecorderBackendName,
    public readonly capability: keyof RecorderCapabilities,
    message: string,
  ) {
    super(message);
    this.name = "RecCapabilityError";
  }
}

/** The command a backend wants to run, plus how its stdin must be wired. */
export interface BackendPlan {
  bin: string;
  args: string[];
  /** Path the backend will write the first-frame timestamp to, if asked. */
  firstFrameTsPath?: string;
}

export interface RecorderBackend {
  readonly name: RecorderBackendName;
  readonly capabilities: RecorderCapabilities;
  /** Build the command. May probe the system (audio sink, window geometry). */
  plan(opts: RecOptions): Promise<BackendPlan>;
  /** Ask the child to finalize the container. Must not be SIGKILL. */
  requestStop(child: RecChild): void;
  /** Called once per stderr line, to reconcile pause bookkeeping. */
  readPauseState(line: string): boolean | null;
}
