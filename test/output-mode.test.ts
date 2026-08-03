/**
 * The four questions one boolean used to answer.
 *
 * These assertions are cheap and the properties they pin are expensive to get
 * wrong: each one, if flipped, produces a plausible-looking video with something
 * missing — no sound, two captions, or a GIF that quietly paid for TTS.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionFor, isOutputMode, MODE_CAPS, OUTPUT_MODES } from "../src/output-mode.js";

test("isOutputMode reconhece exatamente os quatro modos", () => {
  for (const m of OUTPUT_MODES) assert.ok(isOutputMode(m));
  assert.ok(!isOutputMode("mkv"));
  assert.ok(!isOutputMode("MP4")); // o CLI faz lowercase antes de perguntar
  assert.ok(!isOutputMode(""));
});

test("mp4 não força preset — senão um roteiro helpdesk viraria boardroom", () => {
  assert.equal(MODE_CAPS.mp4.requiresPreset, undefined);
  assert.equal(MODE_CAPS.mp4.voice, true);
  assert.equal(MODE_CAPS.mp4.captureAudio, true);
  assert.equal(MODE_CAPS.mp4.balloon, true);
  assert.equal(MODE_CAPS.mp4.text, "say");
});

test("gif e webp não gastam TTS e falam pelo caption", () => {
  for (const m of ["gif", "webp"] as const) {
    // Sem voz é DE GRAÇA, não é mudo: nada é sintetizado para ser jogado fora.
    assert.equal(MODE_CAPS[m].voice, false, m);
    assert.equal(MODE_CAPS[m].captureAudio, false, m);
    assert.equal(MODE_CAPS[m].text, "caption", m);
    assert.equal(MODE_CAPS[m].requiresPreset, "readme", m);
    // O balão continua ligado: sem voz ele é a única mensagem.
    assert.equal(MODE_CAPS[m].balloon, true, m);
  }
});

test("remotion: a combinação que nenhum booleano expressava", () => {
  const r = MODE_CAPS.remotion;
  // Voz sintetizada — os clipes viajam como assets editáveis.
  assert.equal(r.voice, true);
  // E áudio CAPTURADO. É a invariante de um relógio só: o MP4 gravado carrega a
  // narração, então a composição padrão corta uma trilha única e herda o sync.
  // Trocar isto por `false` cria o segundo relógio que a arquitetura recusa.
  assert.equal(r.captureAudio, true);
  // Balão desligado: o texto tem outro renderizador (React) do outro lado.
  assert.equal(r.balloon, false);
  assert.equal(r.text, "say");
  assert.equal(r.requiresPreset, "comercial");
});

test("todo modo com voz também captura áudio", () => {
  // Sintetizar e não capturar seria pagar por áudio que não entra em lugar nenhum
  // — o mesmo desperdício que o modo GIF evita, ao contrário.
  for (const m of OUTPUT_MODES) {
    if (MODE_CAPS[m].voice) assert.equal(MODE_CAPS[m].captureAudio, true, m);
  }
});

test("extensionFor: remotion e mp4-silent entregam MP4", () => {
  assert.equal(extensionFor("mp4"), "mp4");
  assert.equal(extensionFor("gif"), "gif");
  assert.equal(extensionFor("webp"), "webp");
  assert.equal(extensionFor("remotion"), "mp4");
  assert.equal(extensionFor("mp4-silent"), "mp4");
});
