/**
 * Finds captures already running, so demovid refuses to start a second one.
 *
 * The bash wrapper used `pgrep -f 'gpu-screen-recorder -w'`. That is both a
 * dependency on another binary and a substring match against the whole command
 * line, which would also match `--list-monitors` or a grep for the same string.
 * Reading `/proc/<pid>/cmdline` gives the real argv, so the check becomes
 * "argv[0] is the recorder AND it was given a capture target".
 *
 * This only ever *reports*. Signalling a process demovid did not spawn is
 * exactly the mistake `pkill -f` makes: the user may be recording something of
 * their own, and killing it would destroy their file, not ours.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface RunningCapture {
  pid: number;
  argv: string[];
  kind: "gsr" | "ffmpeg";
}

/** Read `/proc/<pid>/cmdline` as an argv array; `[]` when unreadable. */
async function argvOf(pid: number): Promise<string[]> {
  const buf = await readFile(`/proc/${pid}/cmdline`).catch(() => null);
  if (!buf) return [];
  return buf.toString("utf8").split("\0").filter(Boolean);
}

function classify(argv: string[]): RunningCapture["kind"] | null {
  const bin = basename(argv[0] ?? "");
  // gsr with a real target: `-w <something>`. `--list-monitors` has no `-w`.
  if (bin === "gpu-screen-recorder" && argv.includes("-w")) return "gsr";
  // Our own ffmpeg fallback, identified by the screen-grab input it must carry.
  if (bin === "ffmpeg" && argv.includes("x11grab")) return "ffmpeg";
  return null;
}

export async function findRunningCaptures(): Promise<RunningCapture[]> {
  const entries = await readdir("/proc").catch(() => [] as string[]);
  const self = process.pid;
  const found: RunningCapture[] = [];

  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === self) continue;
    const argv = await argvOf(pid);
    if (argv.length === 0) continue;
    const kind = classify(argv);
    if (kind) found.push({ pid, argv, kind });
  }

  return found;
}
