/**
 * O portão de verbatim do motor experimental.
 *
 * Função pura, e é a única coisa entre "locução mais expressiva" e "o vídeo diz
 * algo que o roteiro não diz". Os casos negativos são os que importam: um modelo
 * generativo que melhora a frase passa por qualquer verificação frouxa.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { agreement } from "../src/openai/tts-audio.js";

test("agreement: idêntico a menos de caixa, acento e pontuação vale 1", () => {
  assert.equal(agreement("a busca aceita protocolo", "A busca aceita protocolo."), 1);
  assert.equal(agreement("é rápido", "e rapido"), 1);
  // Medido numa chamada real: o modelo devolveu a frase exata.
  assert.equal(agreement("A busca aceita protocolo ou nome do paciente.", "A busca aceita protocolo ou nome do paciente."), 1);
});

test("agreement: paráfrase é reprovada bem abaixo do piso de 0.8", () => {
  const score = agreement("a busca aceita protocolo", "Você pode buscar pelo número do protocolo aqui");
  assert.ok(score < 0.8, `paráfrase passou com ${score}`);
});

test("agreement: reordenar as MESMAS palavras não é um match", () => {
  // É por isso que a métrica é subsequência comum e não interseção de conjuntos:
  // uma paráfrase costuma reusar quase todas as palavras em outra ordem.
  const score = agreement("o laudo sai em duas horas", "em duas horas o laudo sai");
  assert.ok(score < 1, `reordenação marcou ${score}`);
});

test("agreement: acrescentar fala não pedida é reprovado", () => {
  // O caso real: o modelo cumprimenta antes de ler.
  const score = agreement("clique em novo", "Claro! Aqui vai: clique em novo. Espero ter ajudado!");
  // 3 palavras de roteiro dentro de 11 faladas: contenção não é fidelidade.
  assert.ok(score < 0.8, `saudação passou com ${score}`);
});

test("agreement: transcrição vazia é zero, não é match", () => {
  assert.equal(agreement("qualquer coisa", ""), 0);
});
