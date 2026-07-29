import assert from "node:assert/strict";
import { test } from "node:test";
import { applyLocale, boardroom, dwellFor, helpdesk, ptBR } from "../src/presets/index.js";
import { speedFor, splitSentences } from "../src/openai/tts.js";
import { narrationOf, parseStoryboard } from "../src/storyboard.js";

const base = { title: "Demo", url: "http://localhost:5173", steps: [{ action: "goto", value: "/" }] };

test("storyboard: aceita o mínimo e aplica os defaults", () => {
  const sb = parseStoryboard(base);
  assert.equal(sb.locale, "pt-BR");
  assert.equal(sb.preset, "boardroom");
  assert.equal(sb.steps.length, 1);
});

test("storyboard: recusa passo sem passo nenhum", () => {
  assert.throws(() => parseStoryboard({ ...base, steps: [] }), /não grava nada/);
});

test("storyboard: ações que miram um elemento exigem target", () => {
  for (const action of ["click", "type", "hover", "focus"]) {
    assert.throws(
      () => parseStoryboard({ ...base, steps: [{ action, value: "x" }] }),
      /exige `target`/,
      `${action} deveria exigir target`,
    );
  }
});

test("storyboard: `wait` sem alvo e sem tempo é como um roteiro trava", () => {
  assert.throws(() => parseStoryboard({ ...base, steps: [{ action: "wait" }] }), /esperar por nada/);
  // com qualquer um dos dois, passa
  parseStoryboard({ ...base, steps: [{ action: "wait", value: "500" }] });
  parseStoryboard({ ...base, steps: [{ action: "wait", target: "#pronto" }] });
});

test("storyboard: zoom fora de 1..4 é recusado", () => {
  assert.throws(() => parseStoryboard({ ...base, steps: [{ action: "goto", value: "/", zoom: 0.5 }] }));
  assert.throws(() => parseStoryboard({ ...base, steps: [{ action: "goto", value: "/", zoom: 9 }] }));
});

test("narrationOf: só o que tem fala, na ordem", () => {
  const sb = parseStoryboard({
    ...base,
    steps: [
      { action: "goto", value: "/", say: "Primeiro." },
      { action: "wait", value: "300" },
      { action: "click", target: "#b", say: "Segundo." },
      { action: "hover", target: "#c", say: "   " },
    ],
  });
  assert.deepEqual(narrationOf(sb), ["Primeiro.", "Segundo."]);
});

test("splitSentences: não quebra em abreviação nem em decimal", () => {
  assert.deepEqual(
    splitSentences("No painel você vê tudo. O Dr. Silva assina em 2.5 horas. A Av. Paulista fica perto."),
    ["No painel você vê tudo.", "O Dr. Silva assina em 2.5 horas.", "A Av. Paulista fica perto."],
  );
});

test("speedFor: 1.0 até o teto de 140 wpm, proporcional acima", () => {
  assert.equal(speedFor(125), 1);
  assert.equal(speedFor(140), 1);
  assert.ok(speedFor(175) > 1.2 && speedFor(175) < 1.3);
});

test("applyLocale: pt-BR alarga o balão e alonga a permanência, sem mutar o preset", () => {
  const before = JSON.parse(JSON.stringify(boardroom));
  const loc = applyLocale(boardroom, ptBR);

  assert.ok(loc.balloon.maxWidthPx > boardroom.balloon.maxWidthPx, "balão deveria alargar");
  assert.ok(loc.pacing.cps < boardroom.pacing.cps, "cps deveria baixar");
  assert.ok(loc.pacing.dwellMinMs > boardroom.pacing.dwellMinMs, "permanência deveria subir");
  assert.match(loc.voice.instructions, /Português do Brasil/);
  assert.deepEqual(JSON.parse(JSON.stringify(boardroom)), before, "applyLocale não pode mutar o preset");
});

test("dwellFor: o áudio manda, mas os pisos e o teto valem", () => {
  const texto = "Aqui você acompanha as requisições em aberto.";

  // áudio longo vence os pisos
  assert.equal(dwellFor(boardroom, 8000, texto), 8000);
  // áudio curtíssimo não deixa o passo passar voando
  assert.ok(dwellFor(boardroom, 200, texto) > 200);
  // e nada passa do teto
  assert.equal(dwellFor(boardroom, 60_000, texto), boardroom.pacing.dwellCapMs);
});

test("dwellFor: texto longo demais para o cps ganha tempo de leitura", () => {
  const curto = "Ok.";
  const longo = "Aqui você acompanha requisições em aberto, laudos liberados e o histórico completo de cada paciente.";
  assert.ok(dwellFor(boardroom, 500, longo) > dwellFor(boardroom, 500, curto));
});

test("os presets se posicionam no eixo de 'quanta ajuda o espectador precisa'", () => {
  // helpdesk é o extremo de ajuda máxima
  assert.ok(helpdesk.spotlight.dim > boardroom.spotlight.dim, "helpdesk deveria escurecer mais");
  assert.ok(helpdesk.cursor.travelFactor > boardroom.cursor.travelFactor, "helpdesk deveria ser mais lento");
  assert.ok(helpdesk.pacing.gapMs > boardroom.pacing.gapMs, "helpdesk deveria pausar mais");
  assert.ok(helpdesk.voice.targetWpm < boardroom.voice.targetWpm, "helpdesk deveria falar mais devagar");
  assert.ok(helpdesk.balloon.fontSizePx > boardroom.balloon.fontSizePx, "helpdesk deveria ter texto maior");
});

test("as molas assadas ficam no estilo da casa (ζ 0.93–0.99, sem repique visível)", () => {
  for (const p of [boardroom, helpdesk]) {
    for (const [what, s] of [["camera", p.camera.spring], ["cursor", p.cursor.spring]] as const) {
      assert.ok(s.zeta >= 0.9 && s.zeta <= 1.0, `${p.name}.${what}: ζ=${s.zeta} fora de 0.9–1.0`);
      assert.ok(s.overshoot < 0.005, `${p.name}.${what}: overshoot ${s.overshoot} visível demais`);
      assert.match(s.css, /^\d+ms linear\(/, `${p.name}.${what}: css não é duração + linear()`);
    }
  }
});
