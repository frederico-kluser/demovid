/**
 * Installs the generated project's dependencies and opens the Remotion Studio.
 *
 * ## Why the Studio is not launched through `run()`
 *
 * `run()` is `execFile` and awaits the child's exit. The Studio never exits — it is
 * a dev server. So this is the third documented long-lived child in the repo, after
 * the recorder and the project's dev server, and it follows the same pattern as
 * `src/project/devserver.ts`: `spawn`, `detached: true`, its own process group.
 *
 * ## Why it OUTLIVES demovid, unlike the dev server
 *
 * The dev server is torn down because demovid started it only to record against it.
 * The Studio is the deliverable: the point of `--format remotion` is that the
 * operator ends up looking at their commercial. So the child is `unref`'d and never
 * signalled — demovid exits, the Studio stays. That is also why the port is pinned
 * and pre-checked rather than read back from stdout: the process this function
 * returns from is going away, so there is nobody left to listen.
 *
 * `stderr` is captured only until the port answers. It exists for the failure case —
 * a Studio that never comes up would otherwise report "timeout" and nothing else —
 * and is released the moment it is no longer needed, because a pipe nobody reads is
 * how a detached child eventually dies on EPIPE.
 */
import { spawn } from "node:child_process";
import { run, which } from "../exec.js";
import { portInUse } from "../project/devserver.js";

/** Remotion's own default. Incremented until something is free. */
const FIRST_PORT = 3000;
const PORT_ATTEMPTS = 20;

export class StudioError extends Error {
  constructor(
    message: string,
    public readonly stderrTail?: string,
  ) {
    super(message);
    this.name = "StudioError";
  }
}

/** First free port at or above {@link FIRST_PORT}. */
export async function freePort(): Promise<number> {
  for (let p = FIRST_PORT; p < FIRST_PORT + PORT_ATTEMPTS; p++) {
    if (!(await portInUse(p))) return p;
  }
  throw new StudioError(
    `nenhuma porta livre entre ${FIRST_PORT} e ${FIRST_PORT + PORT_ATTEMPTS - 1} para o Studio`,
  );
}

/**
 * `npm install` in the generated project.
 *
 * Loud on purpose. This downloads a few hundred megabytes — Remotion bundles its own
 * Chromium — and a silent multi-minute pause after a recording finishes reads as a
 * hang, not as progress.
 */
export async function installDeps(dir: string, log: (line: string) => void): Promise<void> {
  const npm = await which("npm");
  if (!npm) throw new StudioError("npm não está no PATH — sem ele não dá para instalar o Remotion");

  log("instalando o Remotion no projeto gerado (algumas centenas de MB, uma vez só)");
  await run(npm, ["install", "--no-audit", "--no-fund", "--loglevel", "error"], {
    cwd: dir,
    maxBuffer: 32 * 1024 * 1024,
  });
  log("dependências instaladas");
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export interface StudioHandle {
  url: string;
  port: number;
  pid: number | undefined;
}

export interface OpenStudioOptions {
  dir: string;
  log: (line: string) => void;
  /** Let Remotion open the browser itself. */
  open?: boolean;
  timeoutMs?: number;
}

export async function openStudio(opts: OpenStudioOptions): Promise<StudioHandle> {
  const npm = await which("npm");
  if (!npm) throw new StudioError("npm não está no PATH — sem ele não dá para abrir o Studio");

  const port = await freePort();
  const args = ["run", "studio", "--", "--port", String(port)];
  if (opts.open === false) args.push("--no-open");

  opts.log(`abrindo o Remotion Studio na porta ${port}`);

  const child = spawn(npm, args, {
    cwd: opts.dir,
    // Its own process group, so a future `stop` could signal the whole tree — and
    // so that Ctrl-C in demovid's terminal does not take the Studio with it.
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", BROWSER: opts.open === false ? "none" : (process.env["BROWSER"] ?? "") },
  });

  let tail = "";
  const collect = (chunk: Buffer): void => {
    tail = (tail + chunk.toString("utf8")).slice(-4000);
  };
  child.stderr.on("data", collect);

  const died = new Promise<never>((_, reject) => {
    child.once("exit", (code) =>
      reject(new StudioError(`o Studio saiu com código ${code} antes de subir`, tail)),
    );
    child.once("error", (e) => reject(new StudioError(e.message, tail)));
  });

  const up = waitForPort(port, opts.timeoutMs ?? 120_000).then((ok) => {
    if (!ok) throw new StudioError(`o Studio não respondeu na porta ${port} a tempo`, tail);
    return true;
  });

  try {
    await Promise.race([up, died]);
  } catch (err) {
    // The child is the thing that failed; do not leave it holding the port.
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    throw err;
  }

  // Up and serving. Release everything that would keep this process alive: the
  // Studio is meant to outlive the command that started it.
  child.stderr.off("data", collect);
  // Node types a piped stdio stream as `Readable`, but it is really a `net.Socket`,
  // and the socket is what carries `unref`. Both calls are load-bearing and for
  // different reasons: `resume()` keeps draining the pipe so the Studio never blocks
  // writing into a buffer nobody reads, and `unref()` stops that same pipe from
  // holding demovid's event loop open forever.
  const pipe = child.stderr as unknown as { resume: () => void; unref?: () => void };
  pipe.resume();
  pipe.unref?.();
  child.removeAllListeners("exit");
  child.removeAllListeners("error");
  child.unref();

  const url = `http://localhost:${port}`;
  opts.log(`Studio no ar em ${url} — ele continua rodando depois que o demovid sair`);
  return { url, port, pid: child.pid };
}
