/**
 * The prose caller: the model that writes the storyboard and the commercial edit.
 *
 * Extracted from `src/openai/script.ts` when a second caller appeared (the
 * commercial edit script). It has moved providers twice — to DeepSeek's Chat
 * Completions on 2026-07-30, and back to OpenAI's Responses API with `gpt-5.4`
 * on 2026-07-30 — so what matters here is which properties belong to the
 * TRANSPORT and which the callers may rely on regardless of it.
 *
 * The exported surface (`callStructured`, `CHAT_MODEL`, `ChatError`,
 * `stripNulls`) is deliberately provider-neutral: neither caller was edited by
 * either migration, and neither should be by the next one.
 *
 * `pi`, the discovery agent in `src/project/discover.ts`, stays on
 * `deepseek-v4-pro`. That is a separate decision about a separate job — reading
 * a whole repository with a tool loop — and this module has no say in it.
 *
 * Five things about this call were paid for once each, and each is a silent
 * failure otherwise:
 *
 *  1. **Skip the `reasoning` item when parsing.** `output[]` opens with a
 *     `type: "reasoning"` entry that carries no text. Reading `output[0]` returns
 *     undefined and looks exactly like an empty response.
 *  2. **`status: "incomplete"` is likely, not theoretical.** At `xhigh` the
 *     reasoning tokens routinely eat the whole budget before any answer is
 *     emitted, so the ceiling is a ladder rather than a number. Surfaced raw, it
 *     reached the operator as "o modelo não produziu um roteiro válido" — a
 *     message that blames the model for running out of room.
 *  3. **Ten minutes, not ninety seconds.** The TTS timeout is nowhere near enough
 *     for a reasoning model at maximum effort.
 *  4. **The system prompt is threaded per call, never read from the module.** A
 *     repair round-trip that arrived under different instructions than the draft
 *     would be asked to fix rules it never had.
 *  5. **A 401 has to name WHICH key failed.** demovid holds two, and the API
 *     answers "Incorrect API key provided" without saying which one it means.
 *
 * And one thing that must NEVER be added to any schema handed to this function:
 * `pattern`, `minLength`, `minItems` or `maxItems`. Structured Outputs rejects
 * those under `strict` with a hard 400 that kills the feature outright. This
 * blacklist went vestigial under DeepSeek's `json_object` mode, where no server
 * validated the schema; it is load-bearing again.
 */

const ENDPOINT = "https://api.openai.com/v1/responses";

/** The reasoning model that writes the prose. */
export const CHAT_MODEL = "gpt-5.4";
/** The top of the effort ladder — the most reasoning the policy will ask for. */
export const CHAT_EFFORT = "xhigh";
const TIMEOUT_MS = 600_000;

/**
 * Reasoning effort, highest first. The policy is "always the most the API will
 * give us", and the API is the only thing that can say what that is: a value it
 * rejects comes back as a 400 naming the parameter, so the ladder walks down
 * until one is accepted and the last rung drops the reasoning block altogether.
 * Asking for the maximum therefore cannot fail the run — it can only end up
 * somewhere lower with a line in the log saying so.
 */
const EFFORT_LADDER = [CHAT_EFFORT, "high", null] as const;

/** Signals that a 400 is about the reasoning parameter, not about the prompt. */
const REJECTS_PARAM = /reasoning|effort|unsupported|unrecognized|invalid.*(parameter|field|argument)/i;

/**
 * Output ceiling. Reasoning at `xhigh` regularly spends the budget without
 * emitting an answer, so this starts at 64 k to avoid the retry ladder that
 * used to climb 16 k → 32 k → 64 k.
 */
const DEFAULT_BUDGETS = [64_000] as const;

export class ChatError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ChatError";
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
 * See point 1 in the header: the first `output` element is a reasoning item with
 * no text, so indexing into the array rather than filtering by `type` reads an
 * healthy answer as an empty one.
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
  /** Output-token ceilings to try, smallest first. Defaults to the ladder above. */
  budgets?: number[];
  /** A single ceiling, when the caller has one in mind. Overrides `budgets`. */
  maxTokens?: number;
  log?: ((s: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** Thrown when the API rejected the REASONING parameter, not the request. */
class ParamRejected extends ChatError {}
/** Thrown when reasoning ate the ceiling before any answer was emitted. */
class Incomplete extends ChatError {}

async function callOnce(
  opts: StructuredCallOptions,
  effort: (typeof EFFORT_LADDER)[number],
  maxOutputTokens: number,
): Promise<{ text: string; id: string }> {
  const key = process.env["OPENAI_API_KEY"];
  if (!key) throw new ChatError("OPENAI_API_KEY ausente — sem ela não dá para escrever o roteiro");

  const body = {
    model: CHAT_MODEL,
    ...(effort ? { reasoning: { effort } } : {}),
    max_output_tokens: maxOutputTokens,
    instructions: opts.system,
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
      throw new ChatError("a chave da OpenAI está sem saldo", res.status);
    }
    // Worth naming: the same key also pays for the narration, so "the key was
    // rejected" without saying which one sends the operator to the wrong place.
    if (res.status === 401) {
      throw new ChatError(
        "a OPENAI_API_KEY foi rejeitada (401) — inválida ou revogada (é a mesma chave da narração)",
        res.status,
      );
    }
    if (res.status === 400 && effort && REJECTS_PARAM.test(message)) {
      throw new ParamRejected(message, res.status);
    }
    throw new ChatError(`a API recusou: ${message}`, res.status);
  }

  if (json.status === "incomplete" && json.incomplete_details?.reason === "max_output_tokens") {
    throw new Incomplete(`o raciocínio consumiu ${maxOutputTokens} tokens sem responder`);
  }

  const text = extractText(json);
  if (!text) throw new ChatError("o modelo respondeu sem texto");
  return { text, id: json.id ?? "" };
}

/**
 * Call the model with Structured Outputs, always asking for the most reasoning
 * it will grant.
 *
 * Two ladders, walked in this order, because they fail for opposite reasons:
 *
 *  1. **Effort**, highest first. A rejected value is a 400 naming the parameter,
 *     so the next rung is tried and the last one drops the reasoning block
 *     entirely. "Always the maximum" therefore never costs a run — the worst case
 *     is a lower rung and a line in the log.
 *  2. **Output tokens**, smallest first, and only after an effort is settled. At
 *     `xhigh` the model can spend the whole ceiling thinking and come back
 *     `incomplete`; the ladder buys room instead of surfacing that as the model's
 *     incompetence.
 *
 * A transient network error still gets one extra attempt at whatever rung it hit.
 */
export async function callStructured(
  opts: StructuredCallOptions,
): Promise<{ text: string; id: string }> {
  const log = opts.log ?? ((): void => {});
  const budgets = opts.maxTokens ? [opts.maxTokens] : (opts.budgets ?? [...DEFAULT_BUDGETS]);
  let lastErr: unknown;

  for (const effort of EFFORT_LADDER) {
    let downgraded = false;

    for (const budget of budgets) {
      try {
        return await callOnce(opts, effort, budget);
      } catch (err) {
        lastErr = err;

        if (err instanceof ParamRejected) {
          const next = EFFORT_LADDER[EFFORT_LADDER.indexOf(effort) + 1];
          log(
            `a API recusou o esforço "${effort}" — tentando ${next ? `"${next}"` : "sem parâmetro de raciocínio"}`,
          );
          downgraded = true;
          break; // next effort, from the smallest budget again
        }

        if (err instanceof Incomplete) {
          const next = budgets[budgets.indexOf(budget) + 1];
          if (!next) {
            throw new ChatError(
              `o modelo não coube em ${budget} tokens — encurte o pedido ou reduza o número de passos`,
            );
          }
          log(`${err.message} — tentando com ${next}`);
          continue; // same effort, more room
        }

        const code = (err as TypeError & { cause?: { code?: string } }).cause?.code;
        if (
          err instanceof TypeError &&
          code !== "ENOTFOUND" &&
          code !== "ECONNREFUSED" &&
          code !== "EAI_AGAIN"
        ) {
          log("erro de rede na primeira tentativa — tentando mais uma vez");
          return await callOnce(opts, effort, budget);
        }
        throw err;
      }
    }

    // The budget ladder ran out at an effort the API accepted: more reasoning is
    // not the problem, so walking further down the effort ladder cannot help.
    if (!downgraded) break;
  }

  throw lastErr instanceof Error
    ? new ChatError(`o modelo não respondeu em nenhum nível de raciocínio: ${lastErr.message}`)
    : new ChatError("o modelo não respondeu");
}
