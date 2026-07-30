/**
 * The EDL is where wall-clock milliseconds become frames, and every bug available
 * here is silent: a video that renders fine and is out of sync, or a phrase that
 * appears after the shot it belongs to. So the assertions are arithmetic, and they
 * are the cheapest signal this feature has.
 *
 * Pure functions only — no Remotion, no ffmpeg, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Commercial } from "../src/openai/commercial.js";
import { buildEdl, edlDurationInFrames, HANDLE_MS, transitionFrames } from "../src/remotion/edl.js";
import { TIMELINE_FORMAT, TIMELINE_VERSION, type CutPoint, type NarrationSpan, type Timeline, type TimelineEvent } from "../src/timeline.js";

const FPS = 30;

interface Fixture {
  steps: Array<{ index: number; startMs: number; endMs: number; ok?: boolean; action?: string }>;
  narration: Array<{ stepIndex: number; startMs: number; endMs: number; id?: string; text?: string }>;
  cuts?: number[];
  cameraMovesIn?: number[];
  durationMs?: number;
}

function timeline(f: Fixture): Timeline {
  const narration: NarrationSpan[] = f.narration.map((n, i) => ({
    id: n.id ?? `clip${i}`,
    stepIndex: n.stepIndex,
    sentenceIndex: 0,
    text: n.text ?? `frase ${i}`,
    startMs: n.startMs,
    endMs: n.endMs,
    measured: true,
  }));

  const events: TimelineEvent[] = (f.cameraMovesIn ?? []).map((stepIndex, i) => ({
    t: "camera-move",
    seq: i,
    startMs: 0,
    stepIndex,
  }));

  const cuts: CutPoint[] = (f.cuts ?? []).map((atMs) => ({
    atMs,
    score: 0.75,
    kind: "entre-passos",
    reasons: ["fixture"],
    windowMs: [atMs - 500, atMs + 500],
  }));

  return {
    format: TIMELINE_FORMAT,
    version: TIMELINE_VERSION,
    video: {
      path: "demo.mp4",
      durationMs: f.durationMs ?? 20_000,
      width: 1600,
      height: 900,
      fps: 60,
      codec: "h264",
      backend: "gsr",
      scaled: false,
    },
    source: { title: "t", url: "u", locale: "pt-BR", preset: "comercial", cameraRung: "R1" },
    clock: { method: "first-frame-ts", epochMs: 0, residualMs: 17, crossCheckDeltaMs: null, note: "" },
    narration,
    events,
    steps: f.steps.map((s) => ({
      index: s.index,
      action: s.action ?? "click",
      startMs: s.startMs,
      endMs: s.endMs,
      ok: s.ok ?? true,
    })),
    cuts,
    warnings: [],
  };
}

const commercial = (over: Partial<Commercial> = {}): Commercial => ({
  hook: { text: "gancho", sub: null },
  scenes: [],
  endCard: { title: "fecho", cta: "cta" },
  ...over,
});

/** Two steps, 4 s of measured silence between the last word and the next. */
const TWO_STEPS: Fixture = {
  steps: [
    { index: 0, startMs: 0, endMs: 5000 },
    { index: 1, startMs: 5000, endMs: 10_000 },
  ],
  narration: [
    { stepIndex: 0, startMs: 0, endMs: 2000, id: "a" },
    { stepIndex: 1, startMs: 6000, endMs: 8000, id: "b" },
  ],
};

test("um ponto de corte pontuado dentro do silêncio autoriza tirar o ar morto", () => {
  const edl = buildEdl({ timeline: timeline({ ...TWO_STEPS, cuts: [4000] }), videoSrc: "demo.mp4", fps: FPS });
  const [a, b] = edl.scenes;
  assert.ok(a && b);

  // A cena 0 termina um handle DEPOIS da última palavra, não no fim do passo.
  assert.equal(a.trimAfter, Math.round(((2000 + HANDLE_MS) / 1000) * FPS));
  // E a cena 1 começa um handle ANTES da primeira palavra.
  assert.equal(b.trimBefore, Math.round(((6000 - HANDLE_MS) / 1000) * FPS));

  // O que sobrou entre as duas é o ar morto removido: 4000 − 2×320 = 3360ms.
  //
  // Com tolerância de um frame, e não por frouxidão: os pontos são frames, então o
  // descarte quantiza na grade de 33.3ms. 2320ms arredonda para cima (70) e 5680
  // para baixo (170), o que dá 100 frames = 3333ms. Exigir 3360 aqui seria exigir
  // precisão de milissegundo de uma linha de tempo que não tem.
  const droppedMs = ((b.trimBefore - a.trimAfter) / FPS) * 1000;
  assert.ok(
    Math.abs(droppedMs - 3360) <= 1000 / FPS,
    `descartou ${droppedMs.toFixed(0)}ms, esperado 3360 ±${(1000 / FPS).toFixed(0)}`,
  );
});

test("sem ponto de corte, o mesmo silêncio NÃO é cortado", () => {
  // Mesmo silêncio, `cuts` vazio: scoreCuts já julgou a fronteira insegura
  // (navegação por perto, passo que falhou) e este módulo não re-deriva a decisão.
  const edl = buildEdl({ timeline: timeline({ ...TWO_STEPS, cuts: [] }), videoSrc: "demo.mp4", fps: FPS });
  const [a, b] = edl.scenes;
  assert.ok(a && b);
  // As cenas ficam contíguas: nada foi descartado.
  assert.equal(a.trimAfter, b.trimBefore);
});

test("silêncio curto demais para os handles não é cortado", () => {
  const tight: Fixture = {
    steps: [
      { index: 0, startMs: 0, endMs: 3000 },
      { index: 1, startMs: 3000, endMs: 6000 },
    ],
    // 400ms de silêncio: menor que 2×320+150.
    narration: [
      { stepIndex: 0, startMs: 0, endMs: 2800 },
      { stepIndex: 1, startMs: 3200, endMs: 5000 },
    ],
    cuts: [3000],
  };
  const edl = buildEdl({ timeline: timeline(tight), videoSrc: "demo.mp4", fps: FPS });
  const [a, b] = edl.scenes;
  assert.ok(a && b);
  assert.equal(a.trimAfter, b.trimBefore);
});

test("a narração cai no frame certo DENTRO da cena", () => {
  const edl = buildEdl({ timeline: timeline({ ...TWO_STEPS, cuts: [4000] }), videoSrc: "demo.mp4", fps: FPS });
  const b = edl.scenes[1];
  assert.ok(b);
  const line = b.narration[0];
  assert.ok(line);
  // A cena começa em 5680ms e a fala em 6000ms → 320ms → 9.6 → 10 frames.
  assert.equal(line.atFrame, 10);
  assert.equal(line.durationInFrames, 60); // 2000ms
  assert.equal(line.src, "audio/b.mp3");
  // Nunca negativo: um atFrame negativo é fala antes da cena existir.
  for (const s of edl.scenes) for (const n of s.narration) assert.ok(n.atFrame >= 0);
});

test("transição só existe onde há handle para pagá-la", () => {
  const edits = commercial({
    scenes: [
      { index: 0, transition: "fade", impactAtPercent: 0.2, impact: null, kenBurns: false },
      { index: 1, transition: "fade", impactAtPercent: 0.2, impact: null, kenBurns: false },
    ],
  });

  const trimmedEdl = buildEdl({
    timeline: timeline({ ...TWO_STEPS, cuts: [4000] }),
    videoSrc: "demo.mp4",
    fps: FPS,
    commercial: edits,
  });
  // Cena 0 não tem fronteira de entrada — nada de onde transicionar.
  assert.equal(trimmedEdl.scenes[0]?.transitionIn, null);
  // Cena 1 tem handle dos dois lados, então a transição é permitida.
  assert.deepEqual(trimmedEdl.scenes[1]?.transitionIn, { presentation: "fade", durationInFrames: 9 });

  const untrimmedEdl = buildEdl({
    timeline: timeline({ ...TWO_STEPS, cuts: [] }),
    videoSrc: "demo.mp4",
    fps: FPS,
    commercial: edits,
  });
  // Sem corte não há handle, e uma transição aqui apagaria uma palavra ainda sendo
  // dita. Degrada para corte seco em vez de encurtar o handle.
  assert.equal(untrimmedEdl.scenes[1]?.transitionIn, null);
});

test("transitionFrames: `corte` e fronteira sem handle valem zero", () => {
  assert.equal(transitionFrames("corte", true, FPS), 0);
  assert.equal(transitionFrames("fade", false, FPS), 0);
  assert.equal(transitionFrames("fade", true, FPS), 9);
  // A 8fps o handle de 320ms compra 2 frames — abaixo de 3, vira corte.
  assert.equal(transitionFrames("wipe", true, 8), 0);
});

test("a duração total é Σsequences − Σtransitions, a aritmética do TransitionSeries", () => {
  const edl = buildEdl({
    timeline: timeline({ ...TWO_STEPS, cuts: [4000] }),
    videoSrc: "demo.mp4",
    fps: FPS,
    commercial: commercial({
      scenes: [
        { index: 0, transition: "corte", impactAtPercent: 0.2, impact: null, kenBurns: false },
        { index: 1, transition: "wipe", impactAtPercent: 0.2, impact: null, kenBurns: false },
      ],
    }),
  });

  const sequences =
    (edl.hook?.durationInFrames ?? 0) +
    edl.scenes.reduce((n, s) => n + s.durationInFrames, 0) +
    (edl.endCard?.durationInFrames ?? 0);
  const transitions = edl.scenes.reduce((n, s) => n + (s.transitionIn?.durationInFrames ?? 0), 0);

  assert.ok(transitions > 0, "o fixture tem que exercitar pelo menos uma transição");
  assert.equal(edlDurationInFrames(edl), sequences - transitions);
});

test("nenhuma sequência tem duração zero — o Remotion lança nisso", () => {
  const edl = buildEdl({
    timeline: timeline({
      steps: [
        { index: 0, startMs: 0, endMs: 10 },
        { index: 1, startMs: 10, endMs: 20 },
      ],
      narration: [],
    }),
    videoSrc: "demo.mp4",
    fps: FPS,
  });
  for (const s of edl.scenes) {
    assert.ok(s.durationInFrames >= 1, `${s.id} ficou com ${s.durationInFrames}`);
    assert.ok(s.trimAfter > s.trimBefore, `${s.id} não avança no source`);
  }
  assert.ok(edlDurationInFrames(edl) >= 1);
});

test("kenBurns só onde a câmera da página ficou parada", () => {
  const edits = commercial({
    scenes: [
      { index: 0, transition: "corte", impactAtPercent: 0.2, impact: null, kenBurns: true },
      { index: 1, transition: "corte", impactAtPercent: 0.2, impact: null, kenBurns: true },
    ],
  });
  const edl = buildEdl({
    timeline: timeline({ ...TWO_STEPS, cuts: [4000], cameraMovesIn: [1] }),
    videoSrc: "demo.mp4",
    fps: FPS,
    commercial: edits,
  });
  // Passo 0: câmera parada, o pedido é honrado.
  assert.deepEqual(edl.scenes[0]?.kenBurns, { from: 1, to: 1.06 });
  // Passo 1: a câmera in-page já se moveu — dois zooms no mesmo quadro se brigam.
  assert.equal(edl.scenes[1]?.kenBurns, null);
});

test("passo que falhou não vira cena", () => {
  const edl = buildEdl({
    timeline: timeline({
      steps: [
        { index: 0, startMs: 0, endMs: 5000 },
        { index: 1, startMs: 5000, endMs: 9000, ok: false },
        { index: 2, startMs: 9000, endMs: 14_000 },
      ],
      narration: [
        { stepIndex: 0, startMs: 0, endMs: 2000 },
        { stepIndex: 2, startMs: 10_000, endMs: 12_000 },
      ],
      cuts: [6000],
    }),
    videoSrc: "demo.mp4",
    fps: FPS,
  });
  assert.deepEqual(edl.scenes.map((s) => s.id), ["s0", "s2"]);
});

test("cena curtíssima não recebe transição nem frase de impacto", () => {
  const edl = buildEdl({
    timeline: timeline({
      steps: [
        { index: 0, startMs: 0, endMs: 6000 },
        // 600ms: não cabe nem transição nem texto para ler.
        { index: 1, startMs: 6000, endMs: 6600 },
      ],
      narration: [{ stepIndex: 0, startMs: 0, endMs: 2000 }],
      cuts: [4000],
      durationMs: 6600,
    }),
    videoSrc: "demo.mp4",
    fps: FPS,
    commercial: commercial({
      scenes: [
        { index: 0, transition: "corte", impactAtPercent: 0.2, impact: "três cliques", kenBurns: false },
        { index: 1, transition: "fade", impactAtPercent: 0.2, impact: "e pronto", kenBurns: false },
      ],
    }),
  });
  assert.equal(edl.scenes[1]?.transitionIn, null);
  assert.equal(edl.scenes[1]?.impact, null);
  // A cena longa mantém a frase.
  assert.equal(edl.scenes[0]?.impact?.text, "três cliques");
});

test("a frase de impacto cabe dentro da própria cena", () => {
  const edl = buildEdl({
    timeline: timeline({ ...TWO_STEPS, cuts: [4000] }),
    videoSrc: "demo.mp4",
    fps: FPS,
    commercial: commercial({
      scenes: [
        { index: 0, transition: "corte", impactAtPercent: 0.5, impact: "metade", kenBurns: false },
        { index: 1, transition: "fade", impactAtPercent: 0.9, impact: "no fim", kenBurns: false },
      ],
    }),
  });
  for (const s of edl.scenes) {
    if (!s.impact) continue;
    assert.ok(s.impact.atFrame >= 0, `${s.id} atFrame negativo`);
    assert.ok(s.impact.atFrame < s.durationInFrames, `${s.id} começa depois da cena acabar`);
    assert.ok(s.impact.durationInFrames >= 1, `${s.id} frase com duração zero`);
  }
});

test("sem montagem do modelo, o EDL ainda é renderizável — cortes secos, sem texto", () => {
  const edl = buildEdl({ timeline: timeline({ ...TWO_STEPS, cuts: [4000] }), videoSrc: "demo.mp4", fps: FPS });
  assert.equal(edl.hook, null);
  assert.equal(edl.endCard, null);
  assert.equal(edl.audio, "embedded"); // o default de um relógio só
  for (const s of edl.scenes) {
    assert.equal(s.transitionIn, null);
    assert.equal(s.impact, null);
    assert.equal(s.kenBurns, null);
  }
  assert.equal(edlDurationInFrames(edl), edl.scenes.reduce((n, s) => n + s.durationInFrames, 0));
});

test("os frames de trim são absolutos no source e crescem monotonicamente", () => {
  const edl = buildEdl({
    timeline: timeline({
      steps: [
        { index: 0, startMs: 0, endMs: 5000 },
        { index: 1, startMs: 5000, endMs: 10_000 },
        { index: 2, startMs: 10_000, endMs: 15_000 },
      ],
      narration: [
        { stepIndex: 0, startMs: 0, endMs: 2000 },
        { stepIndex: 1, startMs: 6000, endMs: 8000 },
        { stepIndex: 2, startMs: 11_000, endMs: 13_000 },
      ],
      cuts: [4000, 9000],
    }),
    videoSrc: "demo.mp4",
    fps: FPS,
  });

  let prev = -1;
  for (const s of edl.scenes) {
    assert.ok(s.trimBefore >= prev, `${s.id} volta no tempo do source`);
    assert.equal(s.durationInFrames, s.trimAfter - s.trimBefore);
    prev = s.trimAfter;
  }
  // E nada passa do fim do vídeo.
  const last = edl.scenes[edl.scenes.length - 1];
  assert.ok(last && last.trimAfter <= edl.video.durationInFrames);
});

// ── regressão: o contrato entre `strict` e o zod ────────────────────────────

test("CommercialSchema aceita o que stripNulls entrega, não o que o modelo emite", async () => {
  const { CommercialSchema } = await import("../src/openai/commercial.js");
  const { stripNulls } = await import("../src/openai/responses.js");

  // Isto é literalmente o que a API devolve: `strict` obriga toda propriedade a
  // estar presente, então uma cena sem texto vem com `impact: null`.
  const fromApi = {
    hook: { text: "gancho", sub: null },
    scenes: [{ index: 0, transition: "corte", impactAtPercent: 0.2, impact: null, kenBurns: false }],
    endCard: { title: "fecho", cta: "cta" },
  };

  // E `stripNulls` tira os nulls no caminho de entrada, então o que chega ao zod é
  // `undefined`. Declarar só `.nullable()` rejeitava TODA cena que o modelo
  // corretamente deixou sem texto — o que aconteceu em três de três na primeira
  // chamada real.
  const parsed = CommercialSchema.parse(stripNulls(fromApi));
  assert.equal(parsed.scenes[0]?.impact ?? null, null);
  assert.equal(parsed.hook.sub ?? null, null);

  // E o `null` cru também passa, para um EDL editado à mão.
  assert.ok(CommercialSchema.safeParse(fromApi).success);
});
