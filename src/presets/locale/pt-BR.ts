/**
 * Overlay de locale pt-BR.
 *
 * Camada separada dos presets de propósito: 5 presets × N idiomas viraria 5N
 * presets.
 */
import type { LocaleOverlay } from "../types.js";

export const ptBR: LocaleOverlay = {
  tag: "pt-BR",

  // Netflix: limite adulto de 17 CPS em pt-BR contra 20 em inglês.
  cpsFactor: 0.88,
  // Português é mais denso em sílabas — a mesma ideia leva mais tempo falada.
  durationFactor: 1.15,
  // E ocupa mais linha.
  widthFactor: 1.1,

  instructionsSuffix: [
    "",
    "Accent: Português do Brasil (pt-BR), sotaque neutro. Nunca português de Portugal.",
    "Pronunciation: Fale em português brasileiro natural, sem sotaque estrangeiro.",
  ].join("\n"),

  // Há relatos de deriva pt-BR ↔ pt-PT sem correção desde 2024, e nada nas
  // nossas medições prova que `instructions` trava o sotaque. Enquanto isso não
  // for verificado, um humano ouve antes de publicar.
  requireHumanListen: true,
};
