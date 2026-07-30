/**
 * Unit tests for the guided flow's pure parts.
 *
 * The crawl and the model call need a browser and a paid API, so they live in
 * the end-to-end path. What is here is everything that can be wrong *silently*:
 * a URL parsed out of the wrong line, a null that zod rejects, a reasoning item
 * mistaken for the answer.
 *
 *   node --import tsx --test test/scriptflow.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { urlFromOutput } from "../src/project/devserver.js";
// Moved to `responses.ts` when a second caller (the commercial edit) appeared.
import { callStructured, extractText, stripNulls } from "../src/openai/responses.js";
import { journalPathFor } from "../src/annotate.js";

/**
 * Drive `callStructured` against a scripted sequence of HTTP responses.
 *
 * The two ladders inside it only fire on API answers that cost money to
 * reproduce, so they are stubbed. Returns the request bodies actually sent,
 * because WHICH parameters went out is the whole point of the effort ladder.
 */
async function withFetch(
  replies: Array<{ status: number; body: unknown }>,
  run: () => Promise<unknown>,
): Promise<{ sent: Array<Record<string, unknown>>; result: unknown; error: Error | null }> {
  const real = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  let i = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  }) as unknown as typeof fetch;
  try {
    return { sent, result: await run(), error: null };
  } catch (e) {
    return { sent, result: null, error: e as Error };
  } finally {
    globalThis.fetch = real;
  }
}

const CALL = { name: "t", schema: { type: "object" }, system: "s", input: "i" };
const ok = (text: string) => ({
  status: 200,
  body: {
    id: "x",
    status: "completed",
    output: [
      { type: "reasoning" },
      { type: "message", content: [{ type: "output_text", text }] },
    ],
  },
});

test("an answer eaten by reasoning buys more room instead of surfacing as a failure", async () => {
  // At `xhigh` the model routinely spends the whole ceiling thinking and returns
  // `incomplete`. Surfaced raw, that reached the operator as "o modelo não
  // produziu um roteiro válido" — blaming the model for running out of room.
  process.env["OPENAI_API_KEY"] ??= "sk-test";
  const { sent, result, error } = await withFetch(
    [
      { status: 200, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
      ok('{"a":1}'),
    ],
    () => callStructured({ ...CALL }),
  );
  assert.equal(error, null);
  assert.deepEqual(result, { text: '{"a":1}', id: "x" });
  assert.equal(sent.length, 2, "a resposta incompleta tem que ser repetida, não entregue");
  assert.ok(
    (sent[1]!["max_output_tokens"] as number) > (sent[0]!["max_output_tokens"] as number),
    "a segunda tentativa precisa de mais espaço, senão corta de novo",
  );
});

test("a rejected reasoning effort walks down the ladder rather than failing the run", async () => {
  // "sempre o máximo possível" only holds if a value the API refuses costs a
  // rung and not the whole storyboard.
  process.env["OPENAI_API_KEY"] ??= "sk-test";
  const { sent, error } = await withFetch(
    [
      { status: 400, body: { error: { message: "invalid value for 'reasoning.effort'" } } },
      ok('{"a":1}'),
    ],
    () => callStructured({ ...CALL }),
  );
  assert.equal(error, null, "descer um degrau não pode derrubar a chamada");
  assert.deepEqual(sent[0]!["reasoning"], { effort: "xhigh" }, "a primeira tentativa pede o máximo");
  assert.deepEqual(sent[1]!["reasoning"], { effort: "high" }, "a segunda desce um degrau, não desiste");
});

test("the schema travels as strict Structured Outputs, not as a suggestion", async () => {
  // The whole reason for coming back to the Responses API: `strict: true` makes
  // the SHAPE the server's problem. Send the schema any other way and the only
  // thing standing between a malformed object and the recorder is the zod pass.
  process.env["OPENAI_API_KEY"] ??= "sk-test";
  const { sent } = await withFetch([ok('{"a":1}')], () => callStructured({ ...CALL }));
  assert.deepEqual(sent[0]!["text"], {
    format: { type: "json_schema", name: "t", strict: true, schema: { type: "object" } },
  });
  assert.equal(sent[0]!["instructions"], "s", "o system prompt vai por chamada, nunca do módulo");
});

test("a 401 names WHICH key failed, because two providers are in play", async () => {
  // The API answers "Incorrect API key provided" without saying whether it was
  // the OpenAI key or the DeepSeek one — and demovid holds both.
  process.env["OPENAI_API_KEY"] ??= "sk-test";
  const { error } = await withFetch(
    [{ status: 401, body: { error: { message: "Incorrect API key provided" } } }],
    () => callStructured({ ...CALL }),
  );
  assert.match(error!.message, /OPENAI_API_KEY/, "o operador precisa saber qual das duas chaves caiu");
});

test("the reasoning item is skipped, not read as an empty answer", async () => {
  // `output[0]` is a reasoning entry carrying no text. Indexing into the array
  // rather than filtering by type reads a perfectly healthy answer as empty.
  assert.equal(
    extractText({
      output: [
        { type: "reasoning" },
        { type: "message", content: [{ type: "output_text", text: '{"ok":1}' }] },
      ],
    }),
    '{"ok":1}',
  );
});

test("the dev server's own announced URL is preferred over any port guess", () => {
  // Vite silently moves to 5174 when 5173 is taken, and every framework has its
  // own version of that. What it prints is the truth; the table is a guess.
  assert.equal(
    urlFromOutput("  ➜  Local:   http://localhost:5174/\n  ➜  Network: use --host"),
    "http://localhost:5174/",
  );
  assert.equal(urlFromOutput("ready - started server on http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(urlFromOutput("compiling..."), null);
});

test("a remote URL in the output is not mistaken for the dev server", () => {
  assert.equal(urlFromOutput("see https://vitejs.dev/guide for help"), null);
});

test("stripNulls removes what strict mode is forced to emit", () => {
  // Structured Outputs requires every property to be present, so optional ones
  // arrive as null. Zod wants them absent — without this the parse fails on a
  // storyboard that is perfectly correct.
  const raw = {
    title: "x",
    steps: [{ action: "wait", target: null, value: "600", say: "oi", zoom: null, holdMs: null }],
  };
  assert.deepEqual(stripNulls(raw), {
    title: "x",
    steps: [{ action: "wait", value: "600", say: "oi" }],
  });
});

test("stripNulls leaves falsy-but-real values alone", () => {
  assert.deepEqual(stripNulls({ a: 0, b: "", c: false, d: null }), { a: 0, b: "", c: false });
});

test("extractText prefers output_text when the API provides it", () => {
  assert.equal(extractText({ output_text: '{"title":"ok"}' }), '{"title":"ok"}');
});

test("extractText returns null when there is no text to read", () => {
  assert.equal(extractText({}), null);
  assert.equal(extractText({ output: [] }), null);
  // A reasoning item and nothing else: the model thought and never answered.
  assert.equal(extractText({ output: [{ type: "reasoning" }] }), null);
});

test("extractText returns null rather than an empty string", () => {
  assert.equal(extractText({ output_text: "   " }), null);
  assert.equal(
    extractText({ output: [{ type: "message", content: [{ type: "output_text", text: "  " }] }] }),
    null,
  );
});

test("the edit journal lives inside the project it describes", () => {
  // Never in a temp dir: a crash must leave the record next to the files it
  // refers to, so `demovid restore` can find it without being told where.
  assert.equal(journalPathFor("/home/x/app"), "/home/x/app/.demovid/edits.json");
});
