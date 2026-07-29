/**
 * Gets the project's dev server running, or adopts one that already is.
 *
 * Three decisions here, each of which has a wrong version that looks fine:
 *
 *  - **Adopt, never restart.** If something already answers on the port, use
 *    it. The operator probably has it open with their own state; killing it to
 *    start "our" copy would destroy their session and take a minute to rebuild.
 *  - **Believe the child's stdout, not the port table.** Vite silently moves to
 *    5174 when 5173 is taken, and every other framework has its own version of
 *    that. The URL it prints is the truth.
 *  - **Kill the process GROUP.** `npm run dev` spawns the real server as a
 *    child; killing the npm wrapper alone orphans it, and the orphan holds the
 *    port so the next run adopts a server nobody owns.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import type { ProjectScan } from "./scan.js";

export interface DevServer {
  url: string;
  /** False when an existing server was adopted — it must not be stopped. */
  started: boolean;
  stop: () => Promise<void>;
}

/** Is anything listening? A connect attempt, not an HTTP request: a server that
 *  is still compiling answers TCP long before it answers 200. */
export function portInUse(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** First `http://…` URL a dev server prints, if any. */
export function urlFromOutput(text: string): string | null {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s'"]*/i.exec(text);
  return m?.[0] ?? null;
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** SIGTERM the whole group, then SIGKILL. Never leaves the port held. */
function killGroup(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    const done = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 5000);
    done.unref();
    child.once("exit", () => {
      clearTimeout(done);
      resolve();
    });
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      clearTimeout(done);
      resolve();
    }
  });
}

export interface EnsureOptions {
  scan: ProjectScan;
  log: (line: string) => void;
  /** How long to wait for a server we started. */
  timeoutMs?: number;
}

export async function ensureDevServer(opts: EnsureOptions): Promise<DevServer> {
  const { scan, log } = opts;

  if (await portInUse(scan.port)) {
    const url = `http://localhost:${scan.port}`;
    log(`servidor já rodando em ${url} — vou usar esse, não vou derrubá-lo`);
    return { url, started: false, stop: async () => {} };
  }

  if (!scan.script) {
    throw new Error(
      `nada escutando na porta ${scan.port} e o package.json não tem script de dev. ` +
        `Suba o app e rode de novo, ou passe --url.`,
    );
  }

  log(`subindo: ${scan.packageManager} run ${scan.script}`);
  const child = spawn(scan.packageManager, ["run", scan.script], {
    cwd: scan.dir,
    // Its own process group, so the whole tree can be signalled at once.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" },
  });

  let printed: string | null = null;
  const watch = (chunk: Buffer): void => {
    printed ??= urlFromOutput(chunk.toString("utf8"));
  };
  child.stdout.on("data", watch);
  child.stderr.on("data", watch);

  const died = new Promise<never>((_, reject) => {
    child.once("exit", (code) =>
      reject(new Error(`o servidor de dev saiu com código ${code} antes de subir`)),
    );
    child.once("error", (e) => reject(e));
  });

  const up = waitForPort(scan.port, opts.timeoutMs ?? 90_000);
  const ok = await Promise.race([up, died]);

  const stop = async (): Promise<void> => {
    log("derrubando o servidor de dev que eu subi");
    await killGroup(child);
  };

  if (!ok) {
    await stop();
    throw new Error(`o servidor não respondeu na porta ${scan.port} a tempo`);
  }

  // Its own announcement beats our guess.
  const url = printed ?? `http://localhost:${scan.port}`;
  log(`servidor pronto em ${url}`);
  return { url, started: true, stop };
}
