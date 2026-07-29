/**
 * `boardroom` — demo de 2–4 minutos para um comitê de avaliação.
 *
 * Lê como caro e controlado. Nada repica: ζ 0.943, overshoot 0.01 % — invisível.
 * O zoom é contido (1.4×) porque o comitê quer ver o produto, não a lente.
 */
import { SPRINGS } from "../generated/springs.js";
import type { Preset } from "./types.js";

export const boardroom: Preset = {
  name: "boardroom",
  summary: "Enterprise, contido. Para um comitê de avaliação — nada repica.",

  camera: { zoom: 1.4, spring: SPRINGS.screenDefault, minHoldMs: 1200 },

  cursor: {
    dotPx: 20,
    travelFactor: 1.25, // um pouco mais lento que um usuário real: legibilidade > realismo
    spring: SPRINGS.cursorMellow,
    ring: { toPx: 60, strokePx: 6, durationMs: 900 },
  },

  spotlight: {
    dim: 0.55,
    cutoutRadiusPx: 8,
    paddingPx: 12,
    ringPx: 2,
    pulse: { toScale: 1.06, periodMs: 1200, cycles: 3 },
  },

  balloon: {
    maxWidthPx: 380,
    fontSizePx: 17,
    lineHeight: 1.5,
    fontWeight: 450,
    radiusPx: 12,
    paddingPx: [16, 20],
    bg: "rgba(15, 23, 42, 0.97)",
    fg: "#F1F5F9",
    accent: "#3B82F6",
    // Sombra em três camadas — é o que a Navattic entrega em produção.
    shadow: "0 1px 1px rgba(0,0,0,.10), 0 2px 3px rgba(0,0,0,.08), 1px 4px 8px rgba(0,0,0,.12)",
    placement: "anchored",
    // Os valores que este preset já tinha na prática, agora explícitos: 1px era
    // o blur cravado no overlay, e a esquiva do cursor não existia.
    backdropBlurPx: 1,
    avoidCursor: false,
  },

  pacing: { cps: 14, gapMs: 700, dwellMinMs: 1500, dwellPerWordMs: 400, dwellCapMs: 9000 },

  voice: {
    voice: "coral",
    targetWpm: 140, // no teto do que `instructions` entrega sem precisar de `speed`
    instructions: [
      "Voice Affect: Composta, confiante e precisa. Autoridade sem frieza.",
      "Tone: Profissional e direto, como quem apresenta a diretoria.",
      "Pacing: Firme e constante, aproximadamente 140 palavras por minuto. Sem pressa e sem arrastar.",
      "Emotion: Contida. Convicção, nunca entusiasmo de propaganda.",
      "Pronunciation: Clara e articulada.",
    ].join("\n"),
  },
};
