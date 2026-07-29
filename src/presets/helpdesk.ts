/**
 * `helpdesk` — passo a passo de artigo de suporte.
 *
 * Otimizado para um usuário confundido que talvez volte o vídeo. É o preset mais
 * lento, mais legível e mais tolerante: zoom mais fechado (o usuário precisa ver
 * o controle exato), escurecimento mais pesado, e a mola criticamente amortecida
 * (ζ 0.990, zero overshoot).
 */
import { SPRINGS } from "../generated/springs.js";
import type { Preset } from "./types.js";

export const helpdesk: Preset = {
  name: "helpdesk",
  summary: "Suporte, paciente. Para quem está perdido — o mais lento e legível.",

  camera: { zoom: 1.6, spring: SPRINGS.cursorSmooth, minHoldMs: 2000 },

  cursor: {
    dotPx: 24,
    travelFactor: 1.4, // deliberadamente mais lento: dá pra acompanhar com o olho
    spring: SPRINGS.cursorSlow,
    // Anel maior e mais longo — a geometria da Storylane, que é de afordância
    // ("clique aqui"), não de feedback.
    ring: { toPx: 75, strokePx: 8, durationMs: 1500 },
  },

  spotlight: {
    dim: 0.65, // o mais pesado dos presets: foco máximo
    cutoutRadiusPx: 10,
    paddingPx: 20,
    ringPx: 3,
    pulse: { toScale: 1.1, periodMs: 1400, cycles: 3 },
  },

  balloon: {
    maxWidthPx: 420,
    fontSizePx: 19,
    lineHeight: 1.6,
    fontWeight: 450,
    radiusPx: 14,
    paddingPx: [18, 22],
    bg: "rgba(255, 255, 255, 0.98)",
    fg: "#1a1348",
    accent: "#9639e7",
    shadow: "0 1px 2px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.10)",
    placement: "anchored",
    // Os valores que este preset já tinha na prática, agora explícitos: 1px era
    // o blur cravado no overlay, e a esquiva do cursor não existia.
    backdropBlurPx: 1,
    avoidCursor: false,
  },

  pacing: { cps: 11, gapMs: 1000, dwellMinMs: 2000, dwellPerWordMs: 500, dwellCapMs: 10000 },

  voice: {
    voice: "ballad",
    targetWpm: 125,
    instructions: [
      "Voice Affect: Calma, paciente e acolhedora. Como um colega que já explicou isso antes e não se importa de repetir.",
      "Tone: Encorajador e sem pressa. Nunca condescendente.",
      "Pacing: Devagar e claro, aproximadamente 125 palavras por minuto. Pausa depois de cada instrução.",
      "Emotion: Tranquilizadora.",
      "Pronunciation: Muito clara e articulada. Nomes de botões e menus ditos com nitidez.",
    ].join("\n"),
  },
};
