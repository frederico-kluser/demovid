/**
 * The Responses API caller, with Structured Outputs.
 *
 * Extracted from `src/openai/script.ts` when a second caller appeared (the
 * commercial edit script). Four things about this call were paid for once, and
 * each is a silent failure otherwise — copying them into a second module is how
 * one of the four eventually gets fixed in only one place:
 *
 *  1. **Skip the `reasoning` item when parsing.** `output[]` opens with a
 *     `type: "reasoning"` entry that carries no text. Reading `output[0]` returns
 *     undefined and looks exactly like an empty response.
 *  2. **`status: "incomplete"` is likely, not theoretical.** At `xhigh` the
 *     reasoning tokens routinely eat the whole budget before any answer is
 *     emitted. It is retried with a bigger ceiling rather than surfaced.
 *  3. **Ten minutes, not ninety seconds.** The TTS timeout is nowhere near enough
 *     for a reasoning model at maximum effort.
 *  4. **The system prompt is threaded per call, never read from the module.** The
 *     repair round-trips reuse the conversation through `previous_response_id`, and
 *     a repair that arrived under different instructions than the draft would be
 *     asked to fix rules it never had.
 *
 * And one thing that must NEVER be added to any schema handed to this function:
 * `pattern`, `minLength`, `minItems` or `maxItems`. Structured Outputs rejects
 * those under `strict` with a hard 400 that kills the feature outright.
 */

const ENDPOINT = "https://api.openai.com/v1/responses";

/** The reasoning model, at maximum thinking. Confirmed available on this key. */
export const RESPONSES_MODEL = "gpt-5.4";
export const RESPONSES_EFFORT = "xhigh";
const TIMEOUT_MS = 600_000;

/** Reasoning at `xhigh` regularly spends the first rung without answering. */
const DEFAULT_BUDGETS = [16_000, 32_000, 64_000];

export class ResponsesError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ResponsesError";
  }
}

export interface ResponsesResult {
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
 * See point 1 above: the first `output` element is a reasoning item with no text.
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

export interface StructuredCallOptions {
  /** Name of the schema in the Structured Outputs envelope. */
  name: string;
  /** Hand-written JSON Schema. See the header for the keyword blacklist. */
  schema: unknown;
  system: string;
  input: string;
  previousResponseId?: string | undefined;
  budgets?: number[];
  log?: ((s: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

async function callOnce(
  opts: StructuredCallOptions,
  maxOutputTokens: number,
): Promise<{ text: string; id: string }> {
  const key = process.env["OPENAI_API_KEY"];
  if (!key) throw new ResponsesError("OPENAI_API_KEY ausente — sem ela não dá para chamar o modelo");

  const body = {
    model: RESPONSES_MODEL,
    reasoning: { effort: RESPONSES_EFFORT },
    max_output_tokens: maxOutputTokens,
    instructions: opts.system,
    ...(opts.previousResponseId ? { previous_response_id: opts.previousResponseId } : {}),
    input: [{ role: "user", content: [{ type: "input_text", text: opts.input }] }],
    text: {
      format: { type: "json_schema", name: opts.name, strict: true, schema: opts.schema },
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
      throw new ResponsesError("a chave da OpenAI está sem saldo", res.status);
    }
    throw new ResponsesError(`a API recusou: ${message}`, res.status);
  }

  if (json.status === "incomplete" && json.incomplete_details?.reason === "max_output_tokens") {
    throw new ResponsesError("INCOMPLETE");
  }

  const text = extractText(json);
  if (!text) throw new ResponsesError("o modelo respondeu sem texto");
  return { text, id: json.id ?? "" };
}

/** Retry the whole call with a bigger ceiling when reasoning ate the budget. */
export async function callStructured(
  opts: StructuredCallOptions,
): Promise<{ text: string; id: string }> {
  const ladder = opts.budgets ?? DEFAULT_BUDGETS;
  const log = opts.log ?? ((): void => {});
  let last: unknown;

  for (const budget of ladder) {
    try {
      return await callOnce(opts, budget);
    } catch (err) {
      last = err;
      if (err instanceof ResponsesError && err.message === "INCOMPLETE") {
        log(`o raciocínio consumiu ${budget} tokens sem responder — tentando com mais espaço`);
        continue;
      }
      throw err;
    }
  }

  const ceiling = ladder[ladder.length - 1] ?? 0;
  throw last instanceof Error
    ? new ResponsesError(`o modelo não conseguiu responder dentro de ${ceiling} tokens: ${last.message}`)
    : new ResponsesError("o modelo não conseguiu responder");
}
