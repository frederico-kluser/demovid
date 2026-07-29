/**
 * Owns the `rec` child process.
 *
 * Three facts about `rec` (~/Projects/rec) shape this whole module, all verified
 * by reading its source:
 *
 * 1. `bin/rec` ends with `exec gpu-screen-recorder …` — so the PID we spawn *is*
 *    the recorder. No `pgrep`, no `pkill`, no PID file. We signal the child
 *    directly, which is the only way to be safe when the user may have their own
 *    recording running.
 * 2. Stop is **SIGINT**. It finalizes the container; SIGKILL would leave a
 *    truncated file with no moov atom.
 * 3. Pause is **SIGUSR2**, and it is a *toggle*, not set/clear. The backend
 *    prints `Paused` / `Unpaused` on stderr. We track state ourselves and also
 *    reconcile against those lines — a toggle you cannot query is a toggle you
 *    will eventually desynchronise.
 *
 * We always invoke `rec`, never `gpu-screen-recorder` directly, because
 * `rec_import_session_env()` scrapes DISPLAY, XAUTHORITY, the XDG_ vars and
 * DBUS_SESSION_BUS_ADDRESS out of the compositor's `/proc/<pid>/environ`.
 * Without it, capture from an agent or cron context fails with
 * `for_each_active_monitor_output_drm failed`.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { BinaryNotFoundError } from "./exec.js";

/** What `spawn(…, { stdio: ["ignore", "pipe", "pipe"] })` actually returns. */
type RecChild = ChildProcessByStdio<null, Readable, Readable>;

/** What to capture. Mirrors `rec`'s target flags. */
export type RecTarget =
  | { kind: "window"; windowId: string }
  | { kind: "monitor"; name: string }
  | { kind: "screen" }
  | { kind: "region"; region: `${number}x${number}+${number}+${number}` };

export interface RecOptions {
  target: RecTarget;
  /** Absolute path of the MP4/MKV to write. */
  output: string;
  fps?: number;
  /** `very_high` is `rec`'s default and what we want for text-heavy UI. */
  quality?: "medium" | "high" | "very_high" | "ultra";
  codec?: "h264" | "hevc" | "av1";
  /**
   * Audio. `system` = `-a default_output`, the monitor of the default sink:
   * computer sound, no microphone. That is the whole point — the narration is
   * played by the browser and captured back through the sink monitor.
   */
  audio?: "system" | "none";
  /** Print the final command and exit without recording (`rec --dry-run`). */
  dryRun?: boolean;
  /** Called for every stderr line, for progress plumbing. */
  onLine?: (line: string) => void;
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

function buildArgs(o: RecOptions): string[] {
  const args: string[] = ["-y"]; // never open the fzf menu, even on a TTY

  switch (o.target.kind) {
    case "window":
      args.push("--window-id", o.target.windowId);
      break;
    case "monitor":
      args.push("--monitor", o.target.name);
      break;
    case "screen":
      args.push("--screen");
      break;
    case "region":
      args.push("--region", o.target.region);
      break;
  }

  args.push(o.audio === "none" ? "--mute" : "--system-only");
  args.push("--fps", String(o.fps ?? 60));
  args.push("--quality", o.quality ?? "very_high");
  args.push("--codec", o.codec ?? "h264");
  if (o.dryRun) args.push("--dry-run");
  args.push("-o", o.output);

  return args;
}

/** A live recording. Returned by {@link startRecording}. */
export class Recording {
  #child: RecChild;
  #paused = false;
  #stderr: string[] = [];
  #exited: Promise<number | null>;
  #output: string;

  constructor(child: RecChild, output: string, onLine?: (l: string) => void) {
    this.#child = child;
    this.#output = output;

    let buf = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        this.#stderr.push(line);
        if (this.#stderr.length > 400) this.#stderr.shift();
        // Reconcile our toggle bookkeeping against what the backend actually did.
        if (line.includes("Paused")) this.#paused = true;
        else if (line.includes("Unpaused")) this.#paused = false;
        onLine?.(line);
      }
    });

    this.#exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  }

  get paused(): boolean {
    return this.#paused;
  }

  get output(): string {
    return this.#output;
  }

  /**
   * Deliberately NOT `!child.killed`.
   *
   * Node sets `killed = true` after any *successful signal delivery*, not after
   * the child dies — the docs say "set to true after subprocess.kill() is used
   * to successfully send a signal". Since pause is SIGUSR2, the first pause made
   * `killed` true and every later call believed the recording was dead. Caught
   * by the recording e2e: `Paused` was on stderr while `setPaused(false)` threw
   * "recording is not running".
   *
   * Exit is the only thing that means exit, and it shows up as a non-null
   * `exitCode` (normal exit) or `signalCode` (killed by a signal).
   */
  get running(): boolean {
    return this.#child.exitCode === null && this.#child.signalCode === null;
  }

  get stderrTail(): string {
    return this.#stderr.slice(-20).join("\n");
  }

  /**
   * Pause or resume. The backend signal is a toggle, so we only send it when the
   * desired state differs from what we believe the current state to be.
   */
  setPaused(want: boolean): void {
    if (!this.running) throw new RecError("recording is not running", this.stderrTail);
    if (want === this.#paused) return;
    this.#child.kill("SIGUSR2");
    this.#paused = want;
  }

  /**
   * Stop with SIGINT and wait for the container to be finalized. Resolves with
   * the output path and its size on disk.
   */
  async stop(timeoutMs = 15_000): Promise<{ output: string; bytes: number }> {
    if (this.running) {
      // Un-pause first: stopping while paused has never been exercised upstream,
      // and a paused encoder has no reason to flush promptly.
      if (this.#paused) this.setPaused(false);
      this.#child.kill("SIGINT");
    }

    const timer = new Promise<"timeout">((r) => {
      const t = setTimeout(() => r("timeout"), timeoutMs);
      t.unref();
    });
    const outcome = await Promise.race([this.#exited, timer]);

    if (outcome === "timeout") {
      this.#child.kill("SIGKILL");
      throw new RecError(
        `rec did not exit ${timeoutMs}ms after SIGINT; killed. The file is probably truncated.`,
        this.stderrTail,
      );
    }

    const st = await stat(this.#output).catch(() => null);
    if (!st || st.size === 0) {
      throw new RecError(`rec exited but produced no usable file at ${this.#output}`, this.stderrTail);
    }
    return { output: this.#output, bytes: st.size };
  }

  /**
   * Unconditional, idempotent teardown for `finally` blocks. Never throws.
   *
   * Deliberately does NOT consult `running` first. An early version of the
   * recording e2e guarded cleanup with `if (recording.running)`, a bug made that
   * getter lie, and a `gpu-screen-recorder` was left capturing the desktop after
   * the test process exited. Cleanup that trusts our own bookkeeping is cleanup
   * that fails exactly when the bookkeeping is what broke.
   */
  async dispose(): Promise<void> {
    try {
      this.#child.kill("SIGINT");
    } catch {
      /* already gone */
    }
    const timer = new Promise<void>((r) => {
      const t = setTimeout(r, 8000);
      t.unref();
    });
    await Promise.race([this.#exited, timer]);
    try {
      this.#child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Start recording. Resolves once the recorder has survived its startup window —
 * `rec` refuses to start when another capture is already live (`bin/rec:142`),
 * and that failure is immediate, so a short grace period distinguishes "running"
 * from "died on launch" without polling anything.
 */
export async function startRecording(opts: RecOptions): Promise<Recording> {
  const args = buildArgs(opts);

  const child = spawn("rec", args, {
    stdio: ["ignore", "pipe", "pipe"],
    // Detached would survive us — exactly what we do not want. If demovid dies,
    // the recorder must die with it, or the user is left with a stray
    // gpu-screen-recorder filling the disk.
    detached: false,
  });

  const spawnErr = new Promise<Error>((resolve) => child.once("error", resolve));
  const rec = new Recording(child, opts.output, opts.onLine);

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
      throw new BinaryNotFoundError(
        "rec",
        "Install the user's `rec` CLI: `~/Projects/rec/install.sh` (symlinks into ~/.local/bin).",
      );
    }
    throw settled;
  }
  if (settled === "died") {
    throw new RecError(
      `rec exited immediately (code ${child.exitCode}). ` +
        `The usual cause is another capture already running — stop it with \`recstop\`.`,
      rec.stderrTail,
    );
  }

  return rec;
}

/** Build the command line without running it. For `--dry-run` and for logs. */
export function previewCommand(opts: RecOptions): string {
  return ["rec", ...buildArgs(opts)]
    .map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a))
    .join(" ");
}
