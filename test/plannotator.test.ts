/**
 * The Plannotator decision parser.
 *
 * Pure, and worth pinning hard, because this is a contract with a third-party
 * binary demovid does not version. Every case below is a way the answer can come
 * back wrong, and in every one of them the correct behaviour is to return null so
 * `scriptflow` falls back to the terminal gate — never to guess, and never to
 * throw. Guessing here means recording a plan nobody approved.
 *
 *   node --import tsx --test test/plannotator.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDecision } from "../src/plannotator.js";

test("the three documented decisions map onto the gate's three answers", () => {
  assert.deepEqual(parseDecision('{"decision":"approved"}'), { kind: "approve" });
  assert.deepEqual(parseDecision('{"decision":"dismissed"}'), { kind: "abort" });
  assert.deepEqual(parseDecision('{"decision":"annotated","feedback":"mais curto"}'), {
    kind: "revise",
    text: "mais curto",
  });
});

test("banner lines before the JSON do not hide the decision", () => {
  const stdout = [
    "Opening http://localhost:4321 …",
    "Waiting for review …",
    '{"decision":"approved"}',
    "",
  ].join("\n");
  assert.deepEqual(parseDecision(stdout), { kind: "approve" });
});

test("annotated with nothing written is undecided, not an approval", () => {
  // The operator opened the document and closed it without typing. Approving
  // would record a plan they never signed off; sending it to `refineStoryboard`
  // would burn a max-reasoning call to reproduce the storyboard it was given.
  assert.equal(parseDecision('{"decision":"annotated","feedback":""}'), null);
  assert.equal(parseDecision('{"decision":"annotated","feedback":"   "}'), null);
  assert.equal(parseDecision('{"decision":"annotated"}'), null);
});

test("anything unrecognisable falls back rather than guessing", () => {
  assert.equal(parseDecision(""), null);
  assert.equal(parseDecision("plannotator: command not found"), null);
  assert.equal(parseDecision("{not json"), null);
  assert.equal(parseDecision("null"), null);
  assert.equal(parseDecision('{"decision":"exploded"}'), null);
  assert.equal(parseDecision('{"decision":42}'), null);
  // A future decision demovid has never heard of is the same case: unknown means
  // ask the operator, not pick the nearest match.
  assert.equal(parseDecision('{"decision":"deferred","feedback":"depois"}'), null);
});

test("the LAST JSON line wins, so a trailing decision overrides earlier chatter", () => {
  const stdout = ['{"event":"opened"}', '{"decision":"annotated","feedback":"troque o final"}'].join(
    "\n",
  );
  assert.deepEqual(parseDecision(stdout), { kind: "revise", text: "troque o final" });
});
