/**
 * One typed wrapper around `execFile` for every external binary
 * (rec / ffmpeg / ffprobe / xdotool). Array args, NO shell — so untrusted file
 * paths can never be interpreted as shell metacharacters. Maps the two failure
 * modes callers care about: a missing binary (`ENOENT`) vs a non-zero exit.
 *
 * Adapted from trackscribe/src/exec.ts, same contract.
 *
 * Consequence of "no shell": no pipes, no redirects. Use tool flags instead
 * (ffmpeg `-f null -`, rec `--dry-run`). For long-running children that must be
 * signalled rather than awaited — `rec` above all — use `src/rec.ts`, which owns
 * a `spawn`ed child directly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Max captured output bytes; defaults to 64 MiB (ffprobe JSON can be large). */
  maxBuffer?: number;
  /** Extra env on top of `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const INSTALL_HINTS: Record<string, string> = {
  rec: "Install the user's `rec` CLI: `~/Projects/rec/install.sh` (symlinks into ~/.local/bin).",
  recstop: "Ships with `rec` — run `~/Projects/rec/install.sh`.",
  "gpu-screen-recorder":
    "Install gpu-screen-recorder (it is `rec`'s backend). Prefer calling `rec`, which also fixes the session env.",
  ffmpeg: "Install ffmpeg (e.g. `sudo apt install ffmpeg`).",
  ffprobe: "Install ffmpeg — it provides ffprobe (e.g. `sudo apt install ffmpeg`).",
  xdotool: "Install xdotool (`sudo apt install xdotool`) — needed to resolve the browser window id on X11.",
};

/** Thrown when the binary is not on PATH. Carries an install hint. */
export class BinaryNotFoundError extends Error {
  constructor(
    public readonly bin: string,
    public readonly hint: string,
  ) {
    super(`Required binary "${bin}" was not found on PATH. ${hint}`);
    this.name = "BinaryNotFoundError";
  }
}

/** Thrown when the binary ran but exited non-zero. Carries a trimmed stderr tail. */
export class CommandFailedError extends Error {
  constructor(
    public readonly bin: string,
    public readonly code: number | null,
    public readonly stderrTail: string,
  ) {
    super(`"${bin}" exited with code ${code ?? "null"}.\n${stderrTail}`);
    this.name = "CommandFailedError";
  }
}

/**
 * Run `bin` with `args` (no shell). Returns captured stdout/stderr on success;
 * throws {@link BinaryNotFoundError} or {@link CommandFailedError} otherwise.
 */
export async function run(
  bin: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      encoding: "utf8",
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
      code?: string | number;
    };
    if (e.code === "ENOENT") {
      throw new BinaryNotFoundError(
        bin,
        INSTALL_HINTS[bin] ?? "Install it and ensure it is on PATH.",
      );
    }
    const stderrStr = e.stderr ? e.stderr.toString() : "";
    const tail = stderrStr.split("\n").filter(Boolean).slice(-20).join("\n");
    const code = typeof e.code === "number" ? e.code : null;
    throw new CommandFailedError(bin, code, tail || e.message || String(err));
  }
}
