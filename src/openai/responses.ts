/**
 * The Chat Completions API caller, backed by the DeepSeek reasoning model.
 *
 * Extracted from `src/openai/script.ts` when a second caller appeared (the
 * commercial edit script). Migrated from OpenAI's proprietary Responses API
 * (`/v1/responses`) to DeepSeek's Chat Completions API (`/v1/chat/completions`)
 * on 2026-07-30.
 *
 * DeepSeek supports only `response_format: { type: "json_object" }` — the
 * `json_schema` variant with `strict: true` and a `schema` sub-object is
 * OpenAI-only. Schema enforcement is therefore **client-side via zod** after
 * parsing the model's JSON. The schema is included in the system prompt so
 * the model knows the expected shape.
 *
 * Two things survived the migration:
 *
 *  1. **Ten minutes, not ninety seconds.** The TTS timeout is nowhere near enough
 *     for a reasoning model at full effort.
 *  2. **The JSON Schema keyword blacklist.** `pattern`, `minLength`, `minItems` or
 *     `maxItems` are included in the hand-written schemas anyway (carried from
 *     OpenAI `strict`) even though DeepSeek does not enforce them.
 *
 * What did NOT survive:
 *
 *  - The `reasoning` output-item skip (Responses API only — Chat Completions
 *    returns a flat `choices[0].message.content`).
 *  - The `status: "incomplete"` retry ladder (Responses API only — DeepSeek
 *    either returns a complete response or fails with an error).
 *  - `previous_response_id` threading (Chat Completions are stateless — each
 *    call starts fresh with system + user messages).
 *  - Server-side schema enforcement (Chat Completions `json_object` mode
 *    guarantees valid JSON but not a specific shape — zod validates after).
 *
 * DeepSeek auth is the same Bearer-token format as OpenAI, with the key in
 * `DEEPSEEK_API_KEY`. The TTS pipeline stays on OpenAI — this module has no
 * overlap with `tts.ts` or `tts-audio.ts`.
 */

const ENDPOINT = "https://api.deepseek.com/v1/chat/completions";

/** DeepSeek reasoning model at maximum thinking effort. */
export const CHAT_MODEL = "deepseek-v4-pro";
/** DeepSeek max reasoning (maps to "max" — OpenAI "xhigh" compat). */
export const CHAT_EFFORT = "max";
const TIMEOUT_MS = 600_000;

/** Default token ceiling — ample for a storyboard or commercial response. */
const DEFAULT_MAX_TOKENS = 32_000;

export class ChatError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/**
 * Pull the model's JSON text out of a Chat Completions payload.
 *
 * Chat Completions returns a flat `choices[0].message.content` — no reasoning
 * item to skip, no nested output array.
 */
export function extractText(body: { choices?: Array<{ message?: { content?: string | null } }> }): string | null {
  const content = body.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content : null;
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
  /** Label for the response schema (logged but not sent to DeepSeek). */
  name: string;
  /**
   * Hand-written JSON Schema. Included in the system prompt so the model
   * knows the expected shape. Validation is client-side via zod — DeepSeek
   * does not support server-side schema enforcement.
   */
  schema: unknown;
  system: string;
  input: string;
  /** Max output tokens, or the module default. */
  maxTokens?: number;
  log?: ((s: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

async function callOnce(
  opts: StructuredCallOptions,
): Promise<{ text: string; id: string }> {
  const key = process.env["DEEPSEEK_API_KEY"];
  if (!key) throw new ChatError("DEEPSEEK_API_KEY ausente — sem ela não dá para chamar o modelo");

  const systemWithSchema = `${opts.system}\n\nYou MUST respond with a JSON object matching this schema exactly:\n${JSON.stringify(opts.schema, null, 2)}`;

  const body = {
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: systemWithSchema },
      { role: "user", content: opts.input },
    ],
    response_format: { type: "json_object" },
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    thinking: { type: "enabled" },
    reasoning_effort: CHAT_EFFORT,
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });

  const json = (await res.json()) as { error?: { message?: string; type?: string }; choices?: Array<{ message?: { content?: string | null } }>; id?: string };

  if (!res.ok) {
    const message = json.error?.message ?? `HTTP ${res.status}`;
    if (json.error?.type === "insufficient_quota") {
      throw new ChatError("a chave da DeepSeek está sem saldo", res.status);
    }
    throw new ChatError(`a API recusou: ${message}`, res.status);
  }

  const text = extractText(json);
  if (!text) throw new ChatError("o modelo respondeu sem texto");
  return { text, id: json.id ?? "" };
}

/**
 * Call the Chat Completions API with Structured Outputs.
 *
 * Retries once on transient network errors (fetch rejects without an HTTP
 * response). Unlike the old Responses API, DeepSeek has no `status: "incomplete"`
 * fallback — it either returns a complete response or fails.
 */
export async function callStructured(
  opts: StructuredCallOptions,
): Promise<{ text: string; id: string }> {
  const log = opts.log ?? ((): void => {});

  try {
    return await callOnce(opts);
  } catch (err) {
    const code = (err as TypeError & { cause?: { code?: string } }).cause?.code;
    if (
      err instanceof TypeError &&
      code !== "ENOTFOUND" &&
      code !== "ECONNREFUSED" &&
      code !== "EAI_AGAIN"
    ) {
      log("erro de rede na primeira tentativa — tentando mais uma vez");
      return await callOnce(opts);
    }
    throw err;
  }
}
