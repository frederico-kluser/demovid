import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAX_BYTES, isAnimationFormat, ladderFrom } from "../src/gif.js";
import { readme } from "../src/presets/index.js";
import { balloonTextOf, parseStoryboard } from "../src/storyboard.js";

test("ladderFrom: sem pedido, começa no topo e desce até o piso", () => {
  assert.deepEqual(ladderFrom(), [15, 12, 10, 8, 6, 5]);
});

test("ladderFrom: --fps 10 não gasta um encode a 15 antes", () => {
  // O caro aqui não é a ordem, é o encode: começar acima do que foi pedido
  // significa codificar um arquivo inteiro para descartá-lo.
  assert.deepEqual(ladderFrom(10), [10, 8, 6, 5]);
  assert.equal(ladderFrom(10)[0], 10);
});

test("ladderFrom: fps entre dois degraus cai no degrau de baixo", () => {
  assert.deepEqual(ladderFrom(11), [10, 8, 6, 5]);
});

test("ladderFrom: nunca devolve lista vazia — o laço lê o último resultado", () => {
  // Um pedido abaixo do piso é a entrada que produziria `[]` na implementação
  // ingênua, e aí `last!` no fim de `encodeAnimation` seria null de verdade.
  assert.deepEqual(ladderFrom(1), [5]);
  assert.deepEqual(ladderFrom(0), [5]);
  assert.ok(ladderFrom(-3).length > 0);
});

test("isAnimationFormat: só gif e webp; mp4 não é animação neste sentido", () => {
  assert.ok(isAnimationFormat("gif"));
  assert.ok(isAnimationFormat("webp"));
  assert.ok(!isAnimationFormat("mp4"));
  assert.ok(!isAnimationFormat("apng"));
});

test("o teto padrão é 5 MB — metade do limite de imagem do GitHub", () => {
  assert.equal(DEFAULT_MAX_BYTES, 5 * 1024 * 1024);
});

test("balloonTextOf: com voz usa `say` e ignora o caption", () => {
  const sb = parseStoryboard({
    title: "t",
    url: "./a.html",
    steps: [{ action: "focus", target: "#a", say: "falado", caption: "escrito" }],
  });
  assert.equal(balloonTextOf(sb.steps[0]!, "say"), "falado");
});

test("balloonTextOf: sem voz o caption manda", () => {
  const sb = parseStoryboard({
    title: "t",
    url: "./a.html",
    steps: [{ action: "focus", target: "#a", say: "falado", caption: "escrito" }],
  });
  assert.equal(balloonTextOf(sb.steps[0]!, "caption"), "escrito");
});

test("balloonTextOf: sem caption, o modo mudo cai no `say` em vez de ficar sem balão", () => {
  // Um demo.yaml escrito para vídeo tem que continuar gerando um GIF legível.
  const sb = parseStoryboard({
    title: "t",
    url: "./a.html",
    steps: [{ action: "focus", target: "#a", say: "só falado" }],
  });
  assert.equal(balloonTextOf(sb.steps[0]!, "caption"), "só falado");
});

test("storyboard: caption é opcional e sobrevive ao parse", () => {
  const sb = parseStoryboard({
    title: "t",
    url: "./a.html",
    preset: "readme",
    steps: [
      { action: "wait", value: "800", caption: "Painel de exames, visão do dia" },
      { action: "focus", target: "#kpi" },
    ],
  });
  assert.equal(sb.steps[0]!.caption, "Painel de exames, visão do dia");
  assert.equal(sb.steps[1]!.caption, undefined);
});

test("o preset readme é o do GIF: balão maior que os outros e sem pulso", () => {
  // Sem voz o balão é o único canal, então ele tem que ser o maior; e o pulso do
  // spotlight é movimento perpétuo, que num formato pago por quadro é o gasto
  // mais caro que existe.
  assert.ok(readme.balloon.fontSizePx > 19, "o balão do readme tem que ser o maior");
  assert.equal(readme.spotlight.pulse, null);
  assert.equal(readme.balloon.avoidCursor, true);
  assert.ok(readme.balloon.backdropBlurPx >= 3, "transparência sem blur não é legível");
});

test("o readme tem transparência de verdade no fundo do balão", () => {
  // A regra que importa: se o `bg` carrega alpha, o blur não é decoração.
  const alpha = Number(/rgba\([^)]*,\s*([0-9.]+)\)/.exec(readme.balloon.bg)?.[1]);
  assert.ok(alpha < 1, "o readme pediu leve transparência");
  assert.ok(alpha > 0.85, "transparente demais deixa o texto do app competindo com o caption");
  assert.ok(readme.balloon.backdropBlurPx > 1);
});
