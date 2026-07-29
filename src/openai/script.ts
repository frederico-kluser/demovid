/**
 * Writes the storyboard: the app's real, verified elements plus a sentence of
 * intent in Portuguese go in, a validated `Storyboard` comes out.
 *
 * Uses the Responses API with Structured Outputs, and `STORYBOARD_JSON_SCHEMA`
 * from `src/storyboard.ts` — a schema that has existed since the beginning and
 * had never been imported by anything. It was written for this.
 *
 * Four things about this call were paid for, and each is a silent failure
 * otherwise:
 *
 *  1. **The user's request goes LAST.** Same recency reasoning that makes the
 *     order of `required` load-bearing in the schema: the model commits to the
 *     most recent instruction, and the instruction that matters is theirs.
 *  2. **Skip the `reasoning` item when parsing.** `output[]` opens with a
 *     `type: "reasoning"` entry that carries no text. Reading `output[0]`
 *     returns undefined and looks like an empty response.
 *  3. **`status: "incomplete"` is likely, not theoretical.** At `xhigh` the
 *     reasoning tokens routinely eat the whole budget before any answer is
 *     emitted. It is retried with a bigger ceiling rather than surfaced.
 *  4. **Ten minutes, not ninety seconds.** The TTS timeout is nowhere near
 *     enough for a reasoning model at maximum effort.
 *
 * And one thing that must NEVER be added: `pattern`, `minLength` or `maxItems`
 * in the JSON Schema, to constrain selectors. Structured Outputs rejects those
 * under `strict` with a hard 400 that kills the feature outright. Selector
 * validity is checked here, locally, against the inventory.
 */
import { z } from "zod";
import {
  parseStoryboard,
  STORYBOARD_JSON_SCHEMA,
  type Storyboard,
} from "../storyboard.js";

const ENDPOINT = "https://api.openai.com/v1/responses";

/** The reasoning model, at maximum thinking. Confirmed available on this key. */
const MODEL = "gpt-5.4";
const EFFORT = "xhigh";
const TIMEOUT_MS = 600_000;

export class ScriptError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

const SYSTEM = `You write storyboards for demovid, a tool that records narrated product demos.

You are given a verified inventory of an app's addressable elements and a request in Portuguese
describing what to demonstrate. Produce a storyboard.

HARD RULES
- Every non-null "target" MUST be copied VERBATIM from the inventory's selector column.
  Never invent, abbreviate, or "fix" a selector. Never write "id=foo" — copy "#foo" exactly as listed.
- Use only elements that serve the requested demo. A shorter, focused demo beats a complete tour.
- "say" is spoken Portuguese, not written Portuguese: short sentences, no bullet points, no
  parentheses, no URLs, no markdown. Numbers that will be read aloud should be written as words when
  they are short ("vinte e quatro"), as digits when long.
- One to two sentences per step. The narration of a step plays while that step happens.
- Order matters: the demo is executed top to bottom, and each step leaves the app in the state the
  next one starts from. A "type" into a field that a later step navigates away from is wasted.
- Prefer 5 to 9 steps. Fewer than 4 is not a demo; more than 12 is a manual.
- Actions that need a target: click, type, hover, focus. "goto" needs a URL in value. "type" needs the
  text in value. "wait" needs either a target to wait for or milliseconds in value.
- Start with a "wait" step that introduces the app while the first sentence plays.`;

/**
 * Appended for silent output. The difference is not "shorter `say`" — it is a
 * different field with a different job.
 *
 * A narrated step can afford a sentence that only makes sense while the screen
 * moves, because the voice and the motion arrive together. A caption in a looping
 * GIF is read cold, possibly starting from the middle, with nothing to fill in
 * what it left out. So it has to be self-contained, and it has to fit in the
 * reading budget the preset allows — `pacing.cps` at 12 with `dwellCapMs` at 8 s
 * is about 96 characters before the step is holding the frame longer than it is
 * worth, and every held frame is bytes in a format with no inter-frame
 * compression.
 */
const GIF_ADDENDUM = `

## MODO GIF — SEM VOZ

This storyboard is for a silent animated GIF, so "caption" is the ONLY channel to the viewer.
Nothing will be said out loud. Write BOTH fields:

- "caption" (required on every step that communicates anything): written Portuguese, not spoken.
  ONE short sentence, ideally under 90 characters, never over 120. It must carry the complete idea on
  its own — the viewer may start reading mid-loop. No "agora vamos", no "veja que", no "aqui em
  cima": those depend on a voice and a moment. Prefer naming the thing and its consequence
  ("A busca aceita protocolo ou nome do paciente"). Sentence case, no final period on fragments.
- "say": write it anyway, in spoken Portuguese as usual. It costs nothing here and makes the same
  file re-recordable as a narrated video later.
- "preset": use "readme".
- Prefer 4 to 7 steps, not 5 to 9. A GIF is paid for by the frame: every step is roughly three
  seconds of file. A demo that needs nine steps needs a video, and saying so is better than
  delivering a 12 MB GIF.`;

/** The system prompt for the output being written. */
const systemFor = (silent: boolean): string => (silent ? SYSTEM + GIF_ADDENDUM : SYSTEM);

interface ResponsesResult {
  status?: string;
  incomplete_details?: { reason?: string };
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  id?: string;
  error?: { message?: string; type?: string };
}

/**
 * Pull the model's text out of a Responses payload.
 *
 * The `output` array opens with a reasoning item that has no text; taking the
 * first element is the obvious mistake and it produces "empty response".
 */
export function extractText(body: ResponsesResult): string | null {
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text;
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    const text = (item.content ?? [])
      .filter((c) => c.type === "output_text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
    if (text.trim()) return text;
  }
  return null;
}

/**
 * Structured Outputs models optional fields as `["string", "null"]`, because
 * `strict` requires every property to be present. Zod wants them absent.
 */
export function stripNulls(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(stripNulls);
  if (raw && typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return raw;
}

interface CallOptions {
  input: string;
  /**
   * The system prompt. Threaded per call rather than read from the module,
   * because the repair round-trips reuse the conversation through
   * `previous_response_id` and a repair that arrived under different
   * instructions than the draft would be asked to fix rules it never had.
   */
  system: string;
  previousResponseId?: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

async function callModel(opts: CallOptions): Promise<{ text: string; id: string }> {
  const key = process.env["OPENAI_API_KEY"];
  if (!key) throw new ScriptError("OPENAI_API_KEY ausente — sem ela não dá para escrever o roteiro");

  const body = {
    model: MODEL,
    reasoning: { effort: EFFORT },
    max_output_tokens: opts.maxOutputTokens,
    instructions: opts.system,
    ...(opts.previousResponseId ? { previous_response_id: opts.previousResponseId } : {}),
    input: [{ role: "user", content: [{ type: "input_text", text: opts.input }] }],
    text: {
      format: {
        type: "json_schema",
        name: "storyboard",
        strict: true,
        schema: STORYBOARD_JSON_SCHEMA,
      },
    },
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });

  const json = (await res.json()) as ResponsesResult;

  if (!res.ok) {
    const message = json.error?.message ?? `HTTP ${res.status}`;
    if (json.error?.type === "insufficient_quota") {
      throw new ScriptError("a chave da OpenAI está sem saldo", res.status);
    }
    throw new ScriptError(`a API recusou: ${message}`, res.status);
  }

  if (json.status === "incomplete" && json.incomplete_details?.reason === "max_output_tokens") {
    throw new ScriptError("INCOMPLETE");
  }

  const text = extractText(json);
  if (!text) throw new ScriptError("o modelo respondeu sem texto");
  return { text, id: json.id ?? "" };
}

/** Retry the whole call with a bigger ceiling when reasoning ate the budget. */
async function callWithGrowingBudget(
  opts: Omit<CallOptions, "maxOutputTokens">,
  log: (s: string) => void,
): Promise<{ text: string; id: string }> {
  const ladder = [16_000, 32_000, 64_000];
  let last: unknown;
  for (const budget of ladder) {
    try {
      return await callModel({ ...opts, maxOutputTokens: budget });
    } catch (err) {
      last = err;
      if (err instanceof ScriptError && err.message === "INCOMPLETE") {
        log(`o raciocínio consumiu ${budget} tokens sem responder — tentando com mais espaço`);
        continue;
      }
      throw err;
    }
  }
  throw last instanceof Error
    ? new ScriptError(`o modelo não conseguiu responder dentro de 64000 tokens: ${last.message}`)
    : new ScriptError("o modelo não conseguiu responder");
}

export interface WriteOptions {
  /** What the operator asked for, in Portuguese. */
  request: string;
  /**
   * Writing for silent output (GIF/WebP): the model also fills `caption`, which
   * becomes the only channel to the viewer.
   */
  silent?: boolean;
  /** Serialised inventory of verified selectors. */
  inventory: string;
  /** Selectors the model is allowed to use. */
  allowed: Set<string>;
  appName: string;
  url: string;
  log: (line: string) => void;
}

/** Problems that are worth another round-trip, phrased for the model. */
function auditStoryboard(sb: Storyboard, allowed: Set<string>): string[] {
  const problems: string[] = [];
  for (const [i, step] of sb.steps.entries()) {
    if (!step.target) continue;
    if (!allowed.has(step.target)) {
      problems.push(
        `step ${i} (${step.action}) uses target ${JSON.stringify(step.target)}, which is NOT in the ` +
          `inventory. Replace it with a selector copied verbatim from the inventory, or drop the step.`,
      );
    }
  }
  return problems;
}

export async function writeStoryboard(opts: WriteOptions): Promise<Storyboard> {
  const header =
    `## APP\nname: ${opts.appName}\nurl: ${opts.url}\n\n` +
    `## INVENTORY (the ONLY selectors you may use)\n${opts.inventory}\n\n` +
    `## PEDIDO DO USUÁRIO (em português — é isto que a demo tem que mostrar)\n${opts.request}`;

  const system = systemFor(opts.silent ?? false);
  opts.log(`pensando com ${MODEL} (esforço ${EFFORT}) — isso leva alguns minutos`);
  let { text, id } = await callWithGrowingBudget({ input: header, system }, opts.log);

  // Up to two repairs. `strict` already guarantees the SHAPE, so anything wrong
  // here is meaning: a zod cross-field rule, or a selector that is not in the
  // inventory — and the second is checked locally, without spending a call.
  for (let attempt = 0; attempt < 3; attempt++) {
    let sb: Storyboard | null = null;
    let problems: string[] = [];

    try {
      sb = parseStoryboard(stripNulls(JSON.parse(text)));
      problems = auditStoryboard(sb, opts.allowed);
      if (problems.length === 0) {
        sb.url = opts.url;
        return sb;
      }
    } catch (err) {
      problems =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
          : [(err as Error).message];
    }

    if (attempt === 2) {
      throw new ScriptError(
        `o modelo não produziu um roteiro válido depois de 3 tentativas:\n  ${problems.join("\n  ")}`,
      );
    }

    opts.log(`corrigindo ${problems.length} problema(s) no roteiro`);
    // Only the problems go back, not the inventory — it is already in context.
    ({ text, id } = await callWithGrowingBudget(
      {
        input:
          `The storyboard you just produced has problems. Fix ONLY these and return the whole ` +
          `storyboard again:\n\n${problems.map((p) => `- ${p}`).join("\n")}`,
        system,
        previousResponseId: id,
      },
      opts.log,
    ));
  }

  throw new ScriptError("inalcançável");
}

export interface RefineOptions extends Omit<WriteOptions, "request"> {
  current: Storyboard;
  /** What to change, in Portuguese. */
  instruction: string;
}

export async function refineStoryboard(opts: RefineOptions): Promise<Storyboard> {
  const system = systemFor(opts.silent ?? false);
  opts.log(`revisando o roteiro com ${MODEL}`);
  const input =
    `## ROTEIRO ATUAL\n${JSON.stringify(opts.current, null, 2)}\n\n` +
    `## INVENTORY (the ONLY selectors you may use)\n${opts.inventory}\n\n` +
    `## O QUE MUDAR (em português)\n${opts.instruction}`;

  let { text, id } = await callWithGrowingBudget({ input, system }, opts.log);

  for (let attempt = 0; attempt < 3; attempt++) {
    let problems: string[] = [];
    try {
      const sb = parseStoryboard(stripNulls(JSON.parse(text)));
      problems = auditStoryboard(sb, opts.allowed);
      if (problems.length === 0) {
        sb.url = opts.url;
        return sb;
      }
    } catch (err) {
      problems =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
          : [(err as Error).message];
    }
    if (attempt === 2) {
      throw new ScriptError(`a revisão não ficou válida:\n  ${problems.join("\n  ")}`);
    }
    ({ text, id } = await callWithGrowingBudget(
      {
        input: `Fix ONLY these and return the whole storyboard again:\n\n${problems
          .map((p) => `- ${p}`)
          .join("\n")}`,
        system,
        previousResponseId: id,
      },
      opts.log,
    ));
  }

  throw new ScriptError("inalcançável");
}
