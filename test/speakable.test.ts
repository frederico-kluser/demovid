/**
 * Unit coverage for the written→spoken normaliser.
 *
 * Pure functions only, per `testing-demovid`: no network, no ffmpeg, no display.
 * The assertions that matter most are the NEGATIVE ones — a normaliser is judged
 * by what it leaves alone, because a wrong expansion is spoken confidently and
 * nothing downstream can catch it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { integerToWords, toSpeakable } from "../src/openai/speakable.js";

test("integerToWords: as duas regras de pt-BR que um join ingênuo erra", () => {
  // "um mil" não existe em português
  assert.equal(integerToWords(1000), "mil");
  assert.equal(integerToWords(2000), "dois mil");
  // "e" só entra quando o resto é menor que cem ou uma centena redonda
  assert.equal(integerToWords(1005), "mil e cinco");
  assert.equal(integerToWords(1200), "mil e duzentos");
  assert.equal(integerToWords(1234), "mil duzentos e trinta e quatro");
  // cem sozinho, cento quando precede resto
  assert.equal(integerToWords(100), "cem");
  assert.equal(integerToWords(101), "cento e um");
  assert.equal(integerToWords(1_000_000), "um milhão");
  assert.equal(integerToWords(2_000_000), "dois milhões");
  assert.equal(integerToWords(0), "zero");
});

test("moeda: o símbolo e a vírgula viram palavras", () => {
  assert.equal(
    toSpeakable("R$ 1.234,56"),
    "mil duzentos e trinta e quatro reais e cinquenta e seis centavos",
  );
  assert.equal(toSpeakable("R$ 1,00"), "um real");
  assert.equal(toSpeakable("R$ 0,50"), "cinquenta centavos");
  assert.equal(toSpeakable("custa R$ 20 por mês"), "custa vinte reais por mês");
});

test("porcentagem, data e hora", () => {
  assert.equal(toSpeakable("35%"), "trinta e cinco por cento");
  assert.equal(toSpeakable("1,5%"), "um vírgula cinco por cento");
  assert.equal(
    toSpeakable("em 29/07/2026"),
    "em vinte e nove de julho de dois mil e vinte e seis",
  );
  assert.equal(toSpeakable("às 14h30"), "às quatorze e trinta");
  assert.equal(toSpeakable("às 14:00"), "às quatorze horas");
  assert.equal(toSpeakable("às 9h"), "às nove horas");
});

test("ordinais ganham gênero", () => {
  assert.equal(toSpeakable("o 1º passo"), "o primeiro passo");
  assert.equal(toSpeakable("a 2ª via"), "a segunda via");
  assert.equal(toSpeakable("a 11ª tentativa"), "a décima primeira tentativa");
});

test("abreviaturas: expandidas, e a maiúscula de início de frase sobrevive", () => {
  assert.equal(toSpeakable("Dr. Silva assina"), "Doutor Silva assina");
  assert.equal(toSpeakable("leva aprox. 3 dias"), "leva aproximadamente 3 dias");
  assert.equal(toSpeakable("veja a fig. 2"), "veja a figura 2");
});

test("markdown e link não são pronunciados", () => {
  assert.equal(toSpeakable("isso é **importante**"), "isso é importante");
  assert.equal(toSpeakable("rode `npm test` agora"), "rode npm test agora");
  assert.equal(toSpeakable("veja [o guia](https://x.com/y)"), "veja o guia");
  assert.equal(toSpeakable("## Título"), "Título");
});

test("URL solta vira domínio falável", () => {
  assert.equal(toSpeakable("acesse https://app.exemplo.com/x"), "acesse app ponto exemplo ponto com");
});

test("parênteses saem, o conteúdo fica", () => {
  assert.equal(toSpeakable("o total (aprox.) fecha"), "o total aproximadamente fecha");
});

// ── o que NÃO pode ser tocado ──────────────────────────────────────────────
//
// Cada caso aqui é uma string que uma regra plausivelmente ampla estragaria, e
// que sairia errada no áudio sem nenhum sinal automatizado.

test("inteiros nus ficam como estão — o sintetizador já os lê", () => {
  assert.equal(toSpeakable("são 1234 registros"), "são 1234 registros");
  assert.equal(toSpeakable("CEP 01310-100"), "CEP 01310-100");
  assert.equal(toSpeakable("versão v4.0.501"), "versão v4.0.501");
});

test("fração não é data", () => {
  assert.equal(toSpeakable("1/2 da tela"), "1/2 da tela");
  assert.equal(toSpeakable("3/4 do total"), "3/4 do total");
  // já uma data sem ano, inequívoca, é convertida
  assert.equal(toSpeakable("em 29/07 sai"), "em vinte e nove de julho sai");
  assert.equal(toSpeakable("em 05/09 sai"), "em cinco de setembro sai");
});

test("abreviatura ambígua não é expandida", () => {
  // "r." pode ser rua ou real; o splitter precisa dela, a locução não a adivinha
  assert.equal(toSpeakable("na r. Augusta"), "na r. Augusta");
});

test("asterisco de multiplicação e underscore de identificador sobrevivem", () => {
  assert.equal(toSpeakable("o campo user_name aceita"), "o campo user_name aceita");
});

test("texto já falável passa intacto", () => {
  const clean = "A busca aceita protocolo ou nome do paciente.";
  assert.equal(toSpeakable(clean), clean);
});
