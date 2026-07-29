/**
 * Owns the recorder child process.
 *
 * demovid spawns the encoder directly now, so the PID it holds IS the recorder.
 * That is what makes the teardown safe: every signal goes to a child this
 * process created, never to a pattern match. `pkill -f gpu-screen-recorder`
 * would also kill a capture the user started themselves.
 *
 * The rules below each replaced an implementation that looked correct:
 *
 *  - `running` is `exitCode === null && signalCode === null`, NEVER
 *    `!child.killed`. Node sets `killed` after any *successful signal delivery*,
 *    not after the child dies — and since pause is SIGUSR2, the first pause made
 *    `killed` true and every later call believed the recording was dead.
 *  - `dispose()` never consults `running`. An early version guarded cleanup with
 *    `if (recording.running)`, a bug made that getter lie, and a recorder was
 *    left capturing the desktop after the process exited. Cleanup that trusts
 *    our own bookkeeping fails exactly when the bookkeeping is what broke.
 *  - Stopping is a staged escalation, never an immediate SIGKILL: a killed
 *    encoder leaves an MP4 with no moov atom, which no player will open.
 */
import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { BinaryNotFoundError, which } from "../exec.js";
import { ffmpegBackend } from "./backend-ffmpeg.js";
import { gsrBackend } from "./backend-gsr.js";
import { findRunningCaptures } from "./guard.js";
import {
  isRecorderBackend,
  RecCapabilityError,
  RecError,
  type RecChild,
  type RecOptions,
  type RecorderBackend,
  type RecorderBackendName,
  type RecorderCapabilities,
} from "./types.js";

export * from "./types.js";
export { findRunningCaptures, type RunningCapture } from "./guard.js";
export { importSessionEnv, SESSION_ENV_KEYS, type SessionEnvResult } from "./session-env.js";

const BACKENDS: Record<RecorderBackendName, RecorderBackend> = {
  gsr: gsrBackend,
  ffmpeg: ffmpegBackend,
};

export interface ResolvedBackend {
  backend: RecorderBackend;
  binPath: string;
  /** Human sentence, in Portuguese, explaining the choice. For `doctor`. */
  why: string;
}

/**
 * Choose a backend: an explicit preference, else the best one installed.
 *
 * `DEMOVID_RECORDER` exists so the ffmpeg path can be exercised on a machine
 * that has gsr — otherwise the fallback is only ever tested where it cannot be
 * compared against the good one.
 */
export async function resolveBackend(pref?: RecorderBackendName): Promise<ResolvedBackend> {
  const envPref = process.env["DEMOVID_RECORDER"] ?? "";
  const wanted = pref ?? (isRecorderBackend(envPref) ? envPref : undefined);

  if (wanted) {
    const backend = BACKENDS[wanted];
    const binPath = await which(backend.name === "gsr" ? "gpu-screen-recorder" : "ffmpeg");
    if (!binPath) {
      throw new BinaryNotFoundError(
        backend.name === "gsr" ? "gpu-screen-recorder" : "ffmpeg",
        `Backend "${wanted}" foi pedido explicitamente mas não está instalado.`,
      );
    }
    return { backend, binPath, why: `pedido explicitamente (${wanted})` };
  }

  const gsr = await which("gpu-screen-recorder");
  if (gsr) return { backend: gsrBackend, binPath: gsr, why: "gpu-screen-recorder presente (GPU, com pausa)" };

  const ff = await which("ffmpeg");
  if (ff) {
    return {
      backend: ffmpegBackend,
      binPath: ff,
      why: "gpu-screen-recorder ausente — fallback ffmpeg (sem pausa, não segue a janela)",
    };
  }

  throw new BinaryNotFoundError(
    "gpu-screen-recorder",
    "Nem gpu-screen-recorder nem ffmpeg foram encontrados — não há como gravar.",
  );
}

/** A live recording. Returned by {@link startRecording}. */
export class Recording {
  #child: RecChild;
  #backend: RecorderBackend;
  #paused = false;
  #stderr: string[] = [];
  #exited: Promise<number | null>;
  #output: string;
  #firstFrameTsPath: string | undefined;
  #stoppedAtMs: number | null = null;

  /** `Date.now()` at spawn. The coarse anchor when nothing better exists. */
  readonly startedAtMs: number;

  constructor(
    child: RecChild,
    backend: RecorderBackend,
    output: string,
    firstFrameTsPath?: string,
    onLine?: (l: string) => void,
  ) {
    this.#child = child;
    this.#backend = backend;
    this.#output = output;
    this.#firstFrameTsPath = firstFrameTsPath;
    this.startedAtMs = Date.now();

    let buf = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        this.#stderr.push(line);
        if (this.#stderr.length > 400) this.#stderr.shift();
        const state = this.#backend.readPauseState(line);
        if (state !== null) this.#paused = state;
        onLine?.(line);
      }
    });

    this.#exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  }

  get backend(): RecorderBackendName {
    return this.#backend.name;
  }

  get capabilities(): RecorderCapabilities {
    return this.#backend.capabilities;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get output(): string {
    return this.#output;
  }

  /** `Date.now()` captured immediately before the stop request was issued. */
  get stoppedAtMs(): number | null {
    return this.#stoppedAtMs;
  }

  /** See the module header: this is deliberately not `!child.killed`. */
  get running(): boolean {
    return this.#child.exitCode === null && this.#child.signalCode === null;
  }

  get stderrTail(): string {
    return this.#stderr.slice(-20).join("\n");
  }

  /**
   * Pause or resume. On gsr the signal is a TOGGLE, so it is only sent when the
   * desired state differs from what we believe the current state to be, and the
   * belief is continuously reconciled against the backend's own stderr.
   */
  setPaused(want: boolean): void {
    if (!this.#backend.capabilities.pause) {
      throw new RecCapabilityError(
        this.#backend.name,
        "pause",
        `o backend ${this.#backend.name} não tem pausa — não existe forma de pausar e retomar no mesmo arquivo`,
      );
    }
    if (!this.running) throw new RecError("recording is not running", this.stderrTail);
    if (want === this.#paused) return;
    this.#child.kill("SIGUSR2");
    this.#paused = want;
  }

  /** Resolve when the child exits, or after `ms`. Never rejects. */
  async #waitExit(ms: number): Promise<boolean> {
    const timer = new Promise<"timeout">((r) => {
      const t = setTimeout(() => r("timeout"), ms);
      t.unref();
    });
    return (await Promise.race([this.#exited, timer])) !== "timeout";
  }

  /**
   * Stop and wait for the container to be finalized.
   *
   * The ladder matters: the backend's own clean stop first (SIGINT for gsr, `q`
   * on stdin for ffmpeg), then signals of increasing violence. SIGKILL is last
   * and is already a failure — it is only there so demovid never hangs.
   */
  async stop(timeoutMs = 15_000): Promise<{ output: string; bytes: number }> {
    if (this.running) {
      // Un-pause first: a paused encoder has no reason to flush promptly.
      if (this.#paused && this.#backend.capabilities.pause) this.setPaused(false);
      this.#stoppedAtMs = Date.now();
      this.#backend.requestStop(this.#child);
    }

    let exited = await this.#waitExit(timeoutMs);
    for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
      if (exited) break;
      try {
        this.#child.kill(signal);
      } catch {
        /* already gone */
      }
      exited = await this.#waitExit(signal === "SIGKILL" ? 2000 : 3000);
    }

    if (!exited) {
      throw new RecError(
        `o gravador não saiu ${timeoutMs}ms depois do pedido de parada, nem após SIGKILL.`,
        this.stderrTail,
      );
    }

    const st = await stat(this.#output).catch(() => null);
    if (!st || st.size === 0) {
      throw new RecError(
        `o gravador saiu mas não produziu arquivo utilizável em ${this.#output}`,
        this.stderrTail,
      );
    }
    return { output: this.#output, bytes: st.size };
  }

  /**
   * The wall-clock instant of the first encoded frame, when the backend could
   * write it. This is the only exact anchor between the orchestrator's clock
   * and the video's t=0.
   *
   * The sidecar is consumed and deleted: left in place, a file called
   * `demo.mp4.ts` sitting next to the video reads as a stray TypeScript file.
   */
  async readFirstFrameTs(): Promise<{ monotonicUs: number; realtimeUs: number } | null> {
    const path = this.#firstFrameTsPath;
    if (!path) return null;
    const raw = await readFile(path, "utf8").catch(() => null);
    await rm(path, { force: true }).catch(() => {});
    if (!raw) return null;
    // Two whitespace-separated integers, after a header line naming them.
    const m = /(\d{6,})\s+(\d{6,})/.exec(raw);
    if (!m?.[1] || !m[2]) return null;
    return { monotonicUs: Number(m[1]), realtimeUs: Number(m[2]) };
  }

  /**
   * Unconditional, idempotent teardown for `finally` blocks. Never throws, and
   * deliberately does NOT consult `running` first — see the module header.
   */
  async dispose(): Promise<void> {
    try {
      this.#backend.requestStop(this.#child);
    } catch {
      /* already gone */
    }
    await this.#waitExit(8000);
    try {
      this.#child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Start recording. Resolves once the recorder has survived its startup window.
 *
 * Both backends fail fast and loudly when they fail at all — a busy target, a
 * missing display, an unwritable path — so a short grace period distinguishes
 * "running" from "died on launch" without polling anything.
 */
export async function startRecording(opts: RecOptions): Promise<Recording> {
  const { backend, binPath } = await resolveBackend(opts.backend);

  const busy = await findRunningCaptures();
  if (busy.length > 0) {
    throw new RecError(
      `já há captura rodando (pid ${busy.map((b) => b.pid).join(", ")}). ` +
        `Pare-a antes — demovid não sinaliza processos que não iniciou.`,
      "",
    );
  }

  const plan = await backend.plan(opts);

  const child = spawn(binPath, plan.args, {
    // All three piped so one type describes both backends; gsr's stdin is
    // closed immediately below. Detached would survive us — exactly what we do
    // not want: if demovid dies, the recorder must die with it.
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  }) as RecChild;

  if (backend.name === "gsr") child.stdin.end();
  // A closed pipe on a child that keeps writing raises EPIPE on this process.
  child.stdin.on("error", () => {});

  const spawnErr = new Promise<Error>((resolve) => child.once("error", resolve));
  const rec = new Recording(child, backend, opts.output, plan.firstFrameTsPath, opts.onLine);

  const settled = await Promise.race([
    spawnErr,
    new Promise<"ok" | "died">((resolve) => {
      const t = setTimeout(() => resolve("ok"), 1200);
      t.unref();
      child.once("exit", () => {
        clearTimeout(t);
        resolve("died");
      });
    }),
  ]);

  if (settled instanceof Error) {
    const e = settled as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new BinaryNotFoundError(plan.bin, "Foi resolvido no PATH mas sumiu antes do spawn.");
    }
    throw settled;
  }
  if (settled === "died") {
    throw new RecError(
      `${plan.bin} saiu imediatamente (código ${child.exitCode}).`,
      rec.stderrTail,
    );
  }

  return rec;
}

/** Build the command line without running it. For `--dry-run` and for logs. */
export async function previewCommand(opts: RecOptions): Promise<string> {
  const { backend, binPath } = await resolveBackend(opts.backend);
  const plan = await backend.plan(opts);
  return [binPath, ...plan.args]
    .map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a))
    .join(" ");
}
