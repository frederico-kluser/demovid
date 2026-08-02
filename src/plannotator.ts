/**
 * The approval gate, in a browser instead of the terminal.
 *
 * Plannotator renders the plan as an annotatable document and blocks until the
 * operator decides. demovid already had the decision — `src/prompt.ts`'s `gate`
 * returns approve / abort / revise — so this module's whole job is to produce
 * the same three answers from a different UI, and to get out of the way when it
 * cannot.
 *
 * ## The contract, read off the binary rather than assumed
 *
 *     plannotator annotate <arquivo.md> --gate --json
 *
 * `--gate` is what makes it wait; without it the command returns before the
 * operator has done anything. `--json` makes stdout exactly one JSON line:
 *
 *     {"decision":"approved"}
 *     {"decision":"dismissed"}
 *     {"decision":"annotated","feedback":"..."}
 *
 * which maps one-to-one onto `GateAnswer`. Everything else on stdout is noise
 * and everything on stderr is Plannotator's own logging.
 *
 * ## Degrading is a feature, not error handling
 *
 * Plannotator is an optional third-party binary that demovid does not version.
 * A missing binary, a changed flag, a crashed browser and an unparseable line
 * all land on the same answer: return null, and let `scriptflow` fall back to the
 * terminal gate it has always had. A recording that cannot start because an
 * optional reviewer is unavailable would be a worse tool than the one that had
 * no reviewer at all.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "./exec.js";
import type { GateAnswer } from "./prompt.js";

/** The official installer, in the mode that touches nothing but the binary. */
export const PLANNOTATOR_INSTALL_HINT =
  "curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal";

/** Resolved path to the binary, or null when it is not installed. */
export async function findPlannotator(): Promise<string | null> {
  if (process.env["DEMOVID_NO_PLANNOTATOR"]) return null;
  const fromEnv = process.env["DEMOVID_PLANNOTATOR"];
  if (fromEnv) return fromEnv;
  return which("plannotator");
}

/**
 * Parse the one JSON line `--json` promises.
 *
 * Defensive on purpose, and pure so it can be tested without the binary. Three
 * things it must survive, all observed in the wild with CLIs of this shape:
 * banner lines before the JSON, a trailing newline, and a decision string this
 * version of demovid has never heard of.
 */
export function parseDecision(stdout: string): GateAnswer | null {
  for (const line of stdout.split("\n").map((l) => l.trim()).reverse()) {
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as { decision?: unknown; feedback?: unknown };
    const decision = typeof obj.decision === "string" ? obj.decision : null;
    const feedback = typeof obj.feedback === "string" ? obj.feedback.trim() : "";

    if (decision === "approved") return { kind: "approve" };
    if (decision === "dismissed") return { kind: "abort" };
    if (decision === "annotated") {
      // Annotated with nothing to say. Not an approval — the operator opened the
      // document and did not approve it — and not a revision either, because
      // `refineStoryboard` with an empty instruction burns a max-reasoning call
      // to produce the storyboard it was already given. Hand it back as
      // undecided and let the caller ask on the terminal.
      return feedback ? { kind: "revise", text: feedback } : null;
    }
    return null;
  }
  return null;
}

export interface AnnotateOptions {
  markdown: string;
  /** Basename shown in Plannotator's UI. */
  name?: string;
  /** Ceiling for the whole review, in ms. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Show `markdown` in Plannotator and wait for a decision.
 *
 * Returns null whenever the answer did not come back cleanly — that is the
 * signal to fall back, never an error to handle.
 *
 * `spawn` resolved on `exit`, not `run()`, and for the reason `runAgent` in
 * `src/project/discover.ts` documents: `execFile` resolves when the child's
 * stdio CLOSES, and this child opens a browser. A browser process that inherits
 * the stdout pipe keeps it open long after the review is over, so the call would
 * hang after the operator already answered.
 */
export async function annotatePlan(opts: AnnotateOptions): Promise<GateAnswer | null> {
  const bin = await findPlannotator();
  if (!bin) return null;
  const log = opts.log ?? ((): void => {});

  const dir = await mkdtemp(join(tmpdir(), "demovid-plan-"));
  const file = join(dir, `${opts.name ?? "plano"}.md`);
  try {
    await writeFile(file, opts.markdown, "utf8");
    log("abrindo o plano no Plannotator — aprove ou anote o que mudar");

    const stdout = await new Promise<string | null>((resolve) => {
      const child = spawn(bin, ["annotate", file, "--gate", "--json"], {
        // stdin ignored so nothing downstream waits on a terminal demovid is
        // also using; stderr inherited so Plannotator's own messages (the URL it
        // serves, mostly) reach the operator.
        stdio: ["ignore", "pipe", "inherit"],
        detached: true,
      });
      let out = "";
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        log("o Plannotator não respondeu a tempo — seguindo pelo terminal");
        try {
          // Negative PID: `detached` put it in its own group, and the browser it
          // spawned is in that group too.
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          /* já morreu */
        }
        finish(null);
      }, opts.timeoutMs ?? 30 * 60_000);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      child.on("error", () => finish(null));
      child.on("exit", (code) => finish(code === 0 ? out : null));
    });

    if (stdout === null) return null;
    const answer = parseDecision(stdout);
    if (!answer) log("o Plannotator voltou sem uma decisão clara — seguindo pelo terminal");
    return answer;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
