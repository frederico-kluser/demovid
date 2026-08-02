/**
 * Unit tests for the plan the operator approves.
 *
 * The assertions that matter are about the WAITS and their provenance, not about
 * formatting. A plan that lists the steps but hides that every click is followed
 * by "wait until these eight selectors disappear" is asking for approval of
 * something the operator cannot see — which is the entire reason this module
 * exists.
 *
 *   node --import tsx --test test/plan-view.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanView, planMarkdown, printPlan, waitLine } from "../src/plan-view.js";
import { SETTLE_DEFAULT_MS } from "../src/record.js";
import type { Storyboard } from "../src/storyboard.js";

const STORYBOARD: Storyboard = {
  title: "Abrindo um repositório",
  url: "http://localhost:5173",
  locale: "pt-BR",
  preset: "boardroom",
  steps: [
    { action: "goto", value: "/", say: "Este é o GitCraque." },
    {
      action: "click",
      target: '[data-testid="open-repo"]',
      say: "Abrimos o repositório.",
      expect: '[data-testid="commit-list"]',
      timeoutMs: 60_000,
    },
    { action: "hover", target: "nav a", say: "E aqui está o menu." },
  ],
} as Storyboard;

const BASE = {
  storyboard: STORYBOARD,
  builtin: ['[aria-busy="true"]', '[class*="spinner" i]'],
  fromCrawl: ['[class*="spinner" i]'],
  fromConfig: [".commit-graph-skeleton"],
} as const;

test("a loading selector keeps every source that found it", () => {
  const view = buildPlanView({ ...BASE });

  const byselector = new Map(view.loaders.map((l) => [l.selector, l.sources]));
  assert.deepEqual(byselector.get('[aria-busy="true"]'), ["embutido"]);
  // Found twice. Not deduplicated into one arbitrary source — a selector both the
  // built-ins and the live crawl agree on is the strong case, and saying so is
  // the difference between "edit .demovid.json" and "this is a demovid bug".
  assert.deepEqual(byselector.get('[class*="spinner" i]'), ["embutido", "crawl"]);
  assert.deepEqual(byselector.get(".commit-graph-skeleton"), ["config"]);
  assert.equal(view.loaders.length, 3);
});

test("project-specific selectors are listed before the generic ones", () => {
  const view = buildPlanView({ ...BASE });
  assert.equal(view.loaders[0]?.selector, ".commit-graph-skeleton");
  assert.deepEqual(view.loaders[0]?.sources, ["config"]);
});

test("only the actions that can leave the app busy are marked as waiting", () => {
  const view = buildPlanView({ ...BASE });
  assert.deepEqual(
    view.steps.map((s) => [s.action, s.waits]),
    [
      ["goto", true],
      ["click", true],
      // `hover` fetches nothing, so waiting on it would only add dead frames.
      ["hover", false],
    ],
  );
});

test("the wait ceiling shown is the one the recorder will actually use", () => {
  const view = buildPlanView({ ...BASE });
  assert.equal(view.steps[0]?.waitMs, SETTLE_DEFAULT_MS);
  // The step's own override, not the default — this is the number an operator is
  // approving when a clone needs sixty seconds.
  assert.equal(view.steps[1]?.waitMs, 60_000);
});

test("with no loading indicators the plan says so instead of promising a wait", () => {
  const withLoaders = waitLine(buildPlanView({ ...BASE }).steps[0]!, 3);
  const without = waitLine(
    buildPlanView({ ...BASE, builtin: [], fromCrawl: [], fromConfig: [] }).steps[0]!,
    0,
  );
  assert.match(withLoaders ?? "", /parar de carregar/);
  assert.match(without ?? "", /rede sossegar/);
});

test("`expect` appears in the wait line, because it is also a gate on moving on", () => {
  const view = buildPlanView({ ...BASE });
  const line = waitLine(view.steps[1]!, view.loaders.length);
  assert.match(line ?? "", /commit-list/);
  // A step that waits for nothing produces no line at all, rather than an empty one.
  assert.equal(waitLine(view.steps[2]!, view.loaders.length), null);
});

test("the markdown carries the selectors, their origin, and the per-step waits", () => {
  const md = planMarkdown(
    buildPlanView({
      ...BASE,
      settledSelectors: ['[data-testid="commit-list"]'],
      slowActions: [{ what: "clonar um repositório remoto", timeoutMs: 60_000 }],
    }),
  );

  assert.match(md, /# Abrindo um repositório/);
  assert.match(md, /## Condições de carregamento/);
  assert.match(md, /`\.commit-graph-skeleton`/);
  assert.match(md, /escrito no \.demovid\.json/);
  assert.match(md, /encontrado na varredura do app/);
  assert.match(md, /clonar um repositório remoto/);
  // One heading per step, so an annotation lands on a step instead of on the list.
  assert.equal(md.match(/^### \d+\. /gm)?.length, 3);
  assert.match(md, /até 60s/);
});

test("a rehearsal failure survives into both renderings", () => {
  const view = buildPlanView({
    ...BASE,
    report: {
      output: null,
      bytes: 0,
      cameraRung: "R1",
      warnings: [],
      steps: [
        { index: 0, action: "goto", ok: true, ms: 1, startedAtMs: 0, endedAtMs: 1 },
        {
          index: 1,
          action: "click",
          ok: false,
          detail: "seletor não encontrado",
          ms: 1,
          startedAtMs: 1,
          endedAtMs: 2,
        },
        { index: 2, action: "hover", ok: true, ms: 1, startedAtMs: 2, endedAtMs: 3 },
      ],
    },
  });

  assert.deepEqual(view.rehearsal, { total: 3, broken: 1 });
  assert.match(planMarkdown(view), /falhou no ensaio.*seletor não encontrado/);

  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (l = ""): void => void lines.push(String(l));
  try {
    printPlan(view);
  } finally {
    console.warn = warn;
  }
  const out = lines.join("\n");
  assert.match(out, /✗/);
  assert.match(out, /1 de 3 passos falharam/);
  // The terminal rendering carries the waits too — the two renderings are the
  // same plan, and a difference between them is a plan nobody approved.
  assert.match(out, /⏳/);
  assert.match(out, /\.commit-graph-skeleton/);
});
