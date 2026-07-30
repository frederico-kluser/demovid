/**
 * Asks the `pi` coding agent to work out what `scan.ts` could not.
 *
 * `scan.ts` reads manifests and config files, which answers most projects for
 * free. What it structurally cannot answer is anything not written in a file it
 * knows to look at: a dev script that starts three processes and serves the UI
 * from the second, an app that needs a login before any element is addressable,
 * or the question of what is actually worth putting in a video. Those need
 * something that can read the README, follow a script, and reason. So this
 * module hands the whole repository to an agent with tools.
 *
 * **The agent is `pi` and it is required, not optional.** demovid does not fall
 * back to its own OpenAI credentials here — one discovery path means one set of
 * behaviours to explain when it gets something wrong.
 *
 * **`--mode json` is a stream, not a document.** pi emits NDJSON events; the
 * answer is the `message_end` event's `content[]` entry of type `text`, and the
 * events before it are thinking deltas that repeat their prefix. Parsing the
 * last line, or the whole thing as one JSON value, both fail.
 *
 * **The agent runs with every tool, including write.** That is the operator's
 * standing choice, and it is the widest grant in this codebase: a model editing
 * the repository of whoever ran `npx demovid`. It is not made silent — the git
 * working tree is compared before and after, and anything the agent touched is
 * named. demovid cannot undo those edits (they are the agent's, not the
 * journalled annotations `annotate.ts` owns), so naming them is what lets the
 * operator run `git diff` and decide.
 */
import { spawn } from "node:child_process";
import { run, which } from "../exec.js";
import { ProjectConfigSchema, type DiscoveredConfig } from "./config.js";
import type { ProjectScan } from "./scan.js";

/** The agent, and the model the operator picked for it. */
export const PI_BIN = "pi";
export const PI_PROVIDER = "deepseek";
export const PI_MODEL = "deepseek-v4-pro";
/** pi's reasoning ladder tops out here — there is no level above `xhigh`. */
export const PI_THINKING = "xhigh";

/** A reasoning model with a tool loop over a whole repository is not fast. */
const DISCOVERY_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Run the agent and return its raw NDJSON, reporting tool activity as it goes.
 *
 * **Spawned rather than `run()`, and resolved on `exit` rather than on stream
 * end.** `execFile` waits for the child's stdio to close, and a coding agent's
 * `bash` tool can leave something running — a dev server it started to check a
 * port, say. That grandchild inherits the stdout pipe, so the pipe never closes
 * and the call hangs forever *after* the agent has already answered. Measured
 * 2026-07-30: the same prompt that completed in well under a minute when pi's
 * output went to a file blew a 9-minute ceiling through `execFile`. Resolving on
 * `exit` and killing the process group is what makes that unreachable.
 *
 * This is the third documented `spawn` bypass, alongside the recorder and the
 * dev server, and for the same reason: a long-lived child that must be signalled
 * rather than awaited. Array args, so the no-shell property is unchanged.
 */
function runAgent(
  args: string[],
  cwd: string,
  onActivity: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, args, {
      cwd,
      // Its own group, so a timeout can take the whole tree — including anything
      // the agent's bash tool left behind.
      detached: true,
      // stdin closed: nothing may block waiting to be typed at.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let pending = "";
    let stderrTail = "";

    // Progress, because the alternative is many minutes of a silent terminal —
    // which is indistinguishable from the hang this function exists to avoid.
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
          const e = JSON.parse(line) as { type?: unknown; toolName?: unknown };
          if (e.type === "tool_execution_start" && typeof e.toolName === "string") {
            onActivity(e.toolName);
          }
        } catch {
          /* a partial or unknown event is not worth reporting */
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2000);
    });

    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      reject(
        new DiscoveryError(
          `o \`pi\` passou de ${DISCOVERY_TIMEOUT_MS / 60_000} minutos sem terminar e foi encerrado.`,
          "Rode `demovid --url <url do app>` para pular a descoberta.",
        ),
      );
    }, DISCOVERY_TIMEOUT_MS);
    timer.unref();

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout.includes('"type":"message_end"')) return resolve(stdout);
      reject(
        new DiscoveryError(
          `o \`pi\` saiu com código ${code ?? "null"}.`,
          stderrTail.trim() || `Confira \`DEEPSEEK_API_KEY\` e o acesso a \`${PI_MODEL}\`.`,
        ),
      );
    });
  });
}

export class DiscoveryError extends Error {
  constructor(
    message: string,
    public readonly hint: string,
  ) {
    super(hint ? `${message} ${hint}` : message);
    this.name = "DiscoveryError";
  }
}

/**
 * The `text` content of the last assistant message in a pi NDJSON stream.
 *
 * Tolerates trailing partial lines and unknown event types: pi is a separate
 * program on its own release cycle, and an event this does not recognise must
 * not be the thing that stops a demo from being recorded.
 */
export function extractPiText(ndjson: string): string | null {
  let latest: string | null = null;

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const e = event as { type?: unknown; message?: { content?: unknown } };
    if (e.type !== "message_end" && e.type !== "turn_end") continue;
    if (!Array.isArray(e.message?.content)) continue;

    for (const part of e.message.content as Array<{ type?: unknown; text?: unknown }>) {
      if (part.type === "text" && typeof part.text === "string") latest = part.text;
    }
  }
  return latest;
}

/**
 * The JSON object inside a model's answer.
 *
 * Models fence JSON in markdown even when told not to, and sometimes add a
 * sentence before it. Slicing between the first `{` and the last `}` handles
 * both without a second round trip.
 */
export function extractJsonObject(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new SyntaxError("nenhum objeto JSON na resposta");
  return JSON.parse(unfenced.slice(start, end + 1));
}

/** Everything the agent is asked to produce, minus the bookkeeping fields. */
const DiscoveredSchema = ProjectConfigSchema.omit({ version: true, fingerprint: true });

export function buildPrompt(scan: ProjectScan): string {
  const known = [
    `- directory: ${scan.dir}`,
    `- package name: ${scan.name}`,
    `- package manager: ${scan.packageManager}`,
    `- framework guessed from dependencies: ${scan.framework}`,
    `- dev script found in package.json: ${scan.script ?? "none"}`,
    scan.workspaces.length > 0 ? `- workspaces: ${scan.workspaces.join(", ")}` : null,
    scan.routes.length > 0 ? `- routes found on disk: ${scan.routes.slice(0, 20).join(" ")}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  return `You are configuring **demovid**, a tool that records a narrated demo video of a web app by
driving it in a real browser: it starts the dev server, crawls the DOM for addressable elements,
then scripts and records a walkthrough.

Work out how to run THIS project and what is worth showing. Investigate however you need to — read
files, run commands.

What demovid already determined by reading manifests and config files:

${known}

Answer with ONE JSON object and nothing else:

{
  "framework": "next|nuxt|sveltekit|vite|cra|angular|vue-cli|astro|remix|static|desconhecido",
  "dev": {
    "bin": "npm",
    "args": ["run", "dev"],
    "cwd": ".",
    "url": "http://localhost:5173",
    "readyTimeoutMs": 90000
  },
  "startRoute": "/",
  "auth": { "required": false, "how": null, "username": null, "password": null },
  "prepare": { "commands": [{ "bin": "bash", "args": ["setup-demo.sh"], "cwd": "." }] }, // optional — omit entirely when not needed
  "readiness": {
    "loadingSelectors": ["[aria-busy=\\"true\\"]", ".commit-graph-skeleton"],
    "settledSelectors": ["[data-testid=\\"commit-list\\"]"],
    "slowActions": [{ "what": "clonar um repositório remoto", "timeoutMs": 60000 }],
    "notes": ["..."]
  },
  "suggestions": ["..."],
  "notes": ["..."]
}

Rules that decide whether this works:

- **\`dev.bin\` + \`dev.args\` are executed directly, with NO shell.** No pipes, no \`&&\`, no \`cd\`.
  If the project needs a shell line, name the package-manager script that wraps it instead.
- **\`dev.url\` must serve the USER INTERFACE.** If the dev command starts several processes, pick
  the one that serves HTML, not the API or the websocket. Getting this wrong is the single most
  expensive mistake here: demovid waits on that URL and gives up if nothing answers.
- **\`dev.cwd\` is relative to ${scan.dir}.** Use "." for the repository root.
- **\`auth\`**: if the app gates on a login, say so and find real dev credentials in the README,
  \`.env.example\`, or a seed script. Never invent credentials — use null when you did not find them.
  Without this, demovid crawls a login screen and reports that the app has no elements.
- **\`prepare\`**: if this app DISPLAYS data that does not exist yet — a git repository browser
  that needs a repo to open, a dashboard that needs seeded data, a code editor that needs
  example files, a database client that needs tables — provide shell commands to CREATE that
  data. Each command is \`{ "bin": "...", "args": [...], "cwd": "..." }\` with cwd relative to
  the project root. The commands run BEFORE the dev server starts, in order. They should be
  idempotent or check for existing data — a second run must not break the first run's results.
  If the app works out of the box with no preparation, OMIT this field entirely (do NOT send
  \`"prepare": null\` or \`"prepare": {"commands": []}\`).
- **\`readiness\`**: how this app shows that it is BUSY, and how a Playwright script can tell that it
  finished. This is the field that decides whether the video shows the result of an action or shows
  a spinner, so spend real effort on it — the recorder acts, waits for these signals, and only then
  holds the frame.

  Find them in the SOURCE, not by guessing: grep the components for \`aria-busy\`,
  \`role="progressbar"\`, \`isLoading\`, \`isPending\`, \`isFetching\`, \`loading\`, \`Suspense\`
  fallbacks, skeleton components, and whatever the app's data layer (React Query, SWR, a store)
  calls its pending state. Then follow those flags to the class name or attribute they actually
  render, because that is what a selector can see.

  - \`loadingSelectors\`: CSS selectors that are visible ONLY while the app is working. They must
    disappear when it is done — that is the entire contract, and a selector that is always on
    screen makes every step wait for its full timeout. Prefer an attribute or a single class name
    over a nested path.
  - \`settledSelectors\`: CSS selectors whose APPEARANCE means an operation finished — the results
    list, the loaded editor, the populated graph.
  - \`slowActions\`: operations that take a long time, and how long to allow in ms. Be honest and
    generous: a clone, a build, an install, a large import, anything that shells out. This is the
    only way the script writer learns that one particular button needs sixty seconds instead of
    the default fifteen. \`what\` is in Portuguese.
  - If the app is entirely synchronous and never shows a loading state, send empty arrays — do NOT
    invent selectors. A wrong selector here is worse than none: it makes every step burn its
    ceiling waiting for something that will never go away.

- **\`suggestions\`**: one to three things a viewer would find genuinely impressive, most compelling
  first, each phrased as an instruction to whoever writes the script ("mostre o grafo de commits e
  arraste um commit para outro branch para fazer o rebase"). This is offered to the operator as a
  ready-made answer to "what do you want to demonstrate?", so write it the way they would.
- **Language**: \`suggestions\`, \`notes\`, \`auth.how\`, \`readiness.notes\` and
  \`readiness.slowActions[].what\` in **Brazilian Portuguese**. Every other field in English,
  exactly as spelled above — CSS selectors are code, not prose.
- Output the JSON object only. No prose around it.`;
}

/** Paths git reports as dirty, as a set, for a before/after comparison. */
async function dirtyPaths(dir: string): Promise<Set<string>> {
  const out = await run("git", ["status", "--porcelain"], { cwd: dir }).catch(() => null);
  if (!out) return new Set();
  return new Set(
    out.stdout
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean),
  );
}

export interface DiscoverOptions {
  scan: ProjectScan;
  log: (line: string) => void;
}

/**
 * Run the agent over the project and return a validated configuration.
 *
 * Throws {@link DiscoveryError} for every failure the operator can act on: pi
 * missing, pi stalled, an answer that is not the agreed shape.
 */
export async function discoverProject(opts: DiscoverOptions): Promise<DiscoveredConfig> {
  const { scan, log } = opts;

  if ((await which(PI_BIN)) === null) {
    throw new DiscoveryError(
      `não consegui configurar este projeto sozinho e o \`${PI_BIN}\` não está no PATH.`,
      `Instale o pi coding agent (\`npm i -g @earendil-works/pi-coding-agent\`) e rode de novo, ` +
        `ou pule a descoberta passando \`--url <url do app>\`.`,
    );
  }

  log(`perguntando ao \`pi\` (${PI_MODEL}, thinking ${PI_THINKING}) como subir e o que mostrar`);
  log("o pi roda com todas as ferramentas, inclusive escrita — vou listar o que ele mudar");

  const before = await dirtyPaths(scan.dir);

  let used = 0;
  let stdout: string;
  try {
    stdout = await runAgent(
      [
        "-p",
        "--provider",
        PI_PROVIDER,
        "--model",
        PI_MODEL,
        "--thinking",
        PI_THINKING,
        "--mode",
        "json",
        "--no-session",
        buildPrompt(scan),
      ],
      scan.dir,
      (tool) => log(`  pi: ${tool} (${++used})`),
    );
  } catch (err: unknown) {
    if (err instanceof DiscoveryError) throw err;
    throw new DiscoveryError(
      `o \`pi\` falhou: ${err instanceof Error ? err.message : String(err)}`,
      `Confira \`DEEPSEEK_API_KEY\` e se \`${PI_MODEL}\` está disponível na sua conta.`,
    );
  }

  const after = await dirtyPaths(scan.dir);
  const touched = [...after].filter((p) => !before.has(p));
  if (touched.length > 0) {
    log(`o pi alterou ${touched.length} arquivo(s): ${touched.join(", ")}`);
    log("nada disso foi desfeito — confira com `git diff` antes de commitar");
  }

  const text = extractPiText(stdout);
  if (text === null) {
    throw new DiscoveryError(
      "o `pi` respondeu, mas não consegui achar a resposta no stream JSON dele.",
      "Rode `demovid --url <url do app>` para pular a descoberta.",
    );
  }

  let parsed: unknown;
  try {
    parsed = extractJsonObject(text);
  } catch {
    throw new DiscoveryError(
      `o \`pi\` não respondeu com JSON: ${text.slice(0, 200)}`,
      "Rode `demovid --url <url do app>` para pular a descoberta.",
    );
  }

  const result = DiscoveredSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new DiscoveryError(
      `a resposta do \`pi\` não tem o formato esperado (${issues}).`,
      "Rode `demovid --url <url do app>` para pular a descoberta.",
    );
  }

  return result.data;
}
