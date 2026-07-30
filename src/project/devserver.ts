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
 *
 * The second rule used to be a comment rather than behaviour. The announced URL
 * was captured into a variable that was only read *after* `waitForPort(scan.port)`
 * had already succeeded — so in the one case it was written for, a guessed port
 * that nobody listens on, the 90s timeout expired first and the announcement was
 * never consulted. Measured 2026-07-30 on GitCraque: scan guessed 3000, Vite
 * announced 5273 within a second, demovid waited 90s and then killed the
 * operator's dev server. The announcement now *races* the guess.
 *
 * Which one wins a tie depends on how the guess was made. A port read from the
 * script or from `vite.config.ts` outranks the announcement, because a dev
 * command that starts several processes announces whichever printed first — for
 * GitCraque that is the API on 5271, not the app on 5273. A port that came from
 * the framework default table is only a guess, so the announcement outranks it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import type { ProjectScan } from "./scan.js";

export interface DevServer {
  url: string;
  /** False when an existing server was adopted — it must not be stopped. */
  started: boolean;
  stop: () => Promise<void>;
}

/** One connect attempt against one address family. */
function probeHost(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
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

/**
 * Is anything listening? A connect attempt, not an HTTP request: a server that
 * is still compiling answers TCP long before it answers 200.
 *
 * **Both loopback families, because one of them is not enough.** Measured
 * 2026-07-30: Vite 7 bound `[::1]:5273` and nothing on `127.0.0.1`, so probing
 * IPv4 alone reported the port free while the app was serving 200. demovid then
 * started a second dev server against a port that was already taken. The reverse
 * happens too — plenty of servers bind IPv4 only — so neither family can be the
 * one we ask. Probed in parallel and OR-ed, which also keeps the 400 ms ceiling
 * from becoming 800 ms per tick.
 */
export async function portInUse(port: number, timeoutMs = 400): Promise<boolean> {
  const [v4, v6] = await Promise.all([
    probeHost("127.0.0.1", port, timeoutMs),
    probeHost("::1", port, timeoutMs),
  ]);
  return v4 || v6;
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s'"]*/gi;

/** First `http://…` URL a dev server prints, if any. */
export function urlFromOutput(text: string): string | null {
  return urlsFromOutput(text)[0] ?? null;
}

/**
 * Every local URL in a chunk of dev-server output, in order.
 *
 * All of them rather than the first, because a `dev` script that starts an API
 * and a frontend prints two, and the first one out is not reliably the app.
 */
export function urlsFromOutput(text: string): string[] {
  return [...text.matchAll(LOCAL_URL)].map((m) => m[0]);
}

/** The port a URL addresses, filling in the protocol default when it is implicit. */
export function portOfUrl(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Wait until a server answers, and return the URL that did — or null on timeout.
 *
 * Polls the guessed port and every announced URL. `trusted` says whether the
 * guess came from evidence (the script, the build config) or from the framework
 * default table, and that decides which one may win.
 *
 * **A trusted guess gets a head start, not just a tie-break.** Measured
 * 2026-07-30 on GitCraque: an orphaned API from an earlier run held 5271, so the
 * new API moved to 5272 and announced it within 300 ms — while Vite, on the
 * trusted 5273, was still booting. Ranking the two only when both were up meant
 * the announcement was the only candidate alive at that instant, and demovid
 * settled on the API and recorded a 404 page. So for `graceMs` the trusted port
 * is the only thing considered; announcements are honoured after that, which is
 * still what rescues a Vite that moved to 5274 because 5273 was taken.
 *
 * `probe` exists so the ranking can be tested without binding sockets — the
 * ordering rule is the whole point of this function, and a test that had to
 * start two real servers to check it would not be written.
 */
export async function waitForServer(
  guess: { port: number; trusted: boolean },
  announced: () => string[],
  timeoutMs: number,
  probe: (port: number) => Promise<boolean> = portInUse,
  graceMs = 15_000,
): Promise<string | null> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const guessUrl = `http://localhost:${guess.port}`;
  // Never longer than the budget itself, or a short timeout would never look at
  // an announcement at all.
  const grace = guess.trusted ? Math.min(graceMs, timeoutMs / 2) : 0;

  while (Date.now() < deadline) {
    if (guess.trusted && (await probe(guess.port))) return guessUrl;

    if (Date.now() - started >= grace) {
      for (const url of announced()) {
        const port = portOfUrl(url);
        if (port !== null && (await probe(port))) return url;
      }
      if (!guess.trusted && (await probe(guess.port))) return guessUrl;
    }

    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
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

/** The exact command an agent worked out, from `.demovid.json`. */
export interface DevOverride {
  bin: string;
  args: string[];
  /** Relative to the project root. */
  cwd: string;
  url: string;
  readyTimeoutMs: number;
}

export interface EnsureOptions {
  scan: ProjectScan;
  log: (line: string) => void;
  /** How long to wait for a server we started. */
  timeoutMs?: number;
  /**
   * Supersedes the scan's `<pm> run <script>` guess. Trusted like a port read
   * from a config file: something looked at the project and decided.
   */
  override?: DevOverride | undefined;
}

export async function ensureDevServer(opts: EnsureOptions): Promise<DevServer> {
  const { scan, log, override } = opts;

  const plan = override
    ? {
        bin: override.bin,
        args: override.args,
        cwd: resolve(scan.dir, override.cwd),
        port: portOfUrl(override.url) ?? scan.port,
        trusted: true,
        timeoutMs: override.readyTimeoutMs,
      }
    : {
        bin: scan.packageManager,
        args: ["run", scan.script ?? ""],
        cwd: scan.dir,
        port: scan.port,
        trusted: scan.portSource !== "default",
        timeoutMs: opts.timeoutMs ?? 90_000,
      };

  if (await portInUse(plan.port)) {
    const url = override?.url ?? `http://localhost:${plan.port}`;
    log(`servidor já rodando em ${url} — vou usar esse, não vou derrubá-lo`);
    return { url, started: false, stop: async () => {} };
  }

  if (!override && !scan.script) {
    throw new Error(
      `nada escutando na porta ${plan.port} e o package.json não tem script de dev. ` +
        `Suba o app e rode de novo, ou passe --url.`,
    );
  }

  log(`subindo: ${plan.bin} ${plan.args.join(" ")}`);
  const child = spawn(plan.bin, plan.args, {
    cwd: plan.cwd,
    // Its own process group, so the whole tree can be signalled at once.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" },
  });

  // Insertion-ordered and deduplicated: a dev server reprints its banner on every
  // reload, and the order it first announced things in is the only ranking we have.
  const printed = new Set<string>();
  const watch = (chunk: Buffer): void => {
    for (const url of urlsFromOutput(chunk.toString("utf8"))) printed.add(url);
  };
  child.stdout.on("data", watch);
  child.stderr.on("data", watch);

  const died = new Promise<never>((_, reject) => {
    child.once("exit", (code) =>
      reject(new Error(`o servidor de dev saiu com código ${code} antes de subir`)),
    );
    child.once("error", (e) => reject(e));
  });

  const up = waitForServer(
    { port: plan.port, trusted: plan.trusted },
    () => [...printed],
    plan.timeoutMs,
  );
  const url = await Promise.race([up, died]);

  const stop = async (): Promise<void> => {
    log("derrubando o servidor de dev que eu subi");
    await killGroup(child);
  };

  if (url === null) {
    await stop();
    const seen = printed.size > 0 ? ` Ele anunciou: ${[...printed].join(", ")}.` : "";
    throw new Error(
      `o servidor não respondeu na porta ${plan.port} a tempo.${seen} ` +
        `Se a porta certa for outra, passe --url.`,
    );
  }

  log(`servidor pronto em ${url}`);
  return { url, started: true, stop };
}
