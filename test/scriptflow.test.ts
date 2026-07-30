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
import { extractText, stripNulls } from "../src/openai/responses.js";
import { journalPathFor } from "../src/annotate.js";

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

test("extractText reads choices[0].message.content from Chat Completions", () => {
  // Chat Completions returns a flat response — no reasoning item to skip.
  const body = {
    choices: [{ message: { content: '{"title":"ok"}' } }],
  };
  assert.equal(extractText(body), '{"title":"ok"}');
});

test("extractText returns null when content is null or missing", () => {
  assert.equal(extractText({ choices: [{ message: { content: null } }] }), null);
  assert.equal(extractText({}), null);
  assert.equal(extractText({ choices: [] }), null);
});

test("extractText returns null rather than an empty string", () => {
  assert.equal(extractText({ choices: [{ message: { content: "   " } }] }), null);
  assert.equal(extractText({ choices: [{ message: {} }] }), null);
});

test("the edit journal lives inside the project it describes", () => {
  // Never in a temp dir: a crash must leave the record next to the files it
  // refers to, so `demovid restore` can find it without being told where.
  assert.equal(journalPathFor("/home/x/app"), "/home/x/app/.demovid/edits.json");
});
