/**
 * Resolução de preset: base → preset → overlay de locale → overrides do usuário.
 * Camada mais tardia vence.
 */
import { boardroom } from "./boardroom.js";
import { comercial } from "./comercial.js";
import { helpdesk } from "./helpdesk.js";
import { readme } from "./readme.js";
import { ptBR } from "./locale/pt-BR.js";
import type { LocaleOverlay, Preset } from "./types.js";

export * from "./types.js";
export { boardroom, comercial, helpdesk, readme, ptBR };

export const PRESETS = { boardroom, helpdesk, readme, comercial } as const;
export const LOCALES = { "pt-BR": ptBR } as const;

export type PresetName = keyof typeof PRESETS;
export type LocaleTag = keyof typeof LOCALES;

export const isPresetName = (s: string): s is PresetName => s in PRESETS;
export const isLocaleTag = (s: string): s is LocaleTag => s in LOCALES;

/** Aplica o overlay de locale sobre o preset. Não muta nada. */
export function applyLocale(preset: Preset, locale: LocaleOverlay): Preset {
  return {
    ...preset,
    name: `${preset.name}+${locale.tag}`,
    pacing: {
      ...preset.pacing,
      cps: Math.round(preset.pacing.cps * locale.cpsFactor * 10) / 10,
      dwellMinMs: Math.round(preset.pacing.dwellMinMs * locale.durationFactor),
      dwellPerWordMs: Math.round(preset.pacing.dwellPerWordMs * locale.durationFactor),
      dwellCapMs: Math.round(preset.pacing.dwellCapMs * locale.durationFactor),
    },
    balloon: {
      ...preset.balloon,
      maxWidthPx: Math.round(preset.balloon.maxWidthPx * locale.widthFactor),
    },
    voice: {
      ...preset.voice,
      instructions: preset.voice.instructions + locale.instructionsSuffix,
    },
  };
}

/**
 * Quanto tempo um passo fica na tela.
 *
 * O áudio manda — `audio.onended` é a métrica de avanço. Os pisos existem para
 * quando a narração é curta demais para o olho acompanhar o que mudou na tela,
 * e o teto para quando o roteiro escreveu um parágrafo onde cabia uma frase.
 *
 * O `cps` entra como um segundo piso: texto que o espectador precisa LER (o
 * balão) tem orçamento próprio, independente do que a voz leva para dizê-lo.
 */
export function dwellFor(preset: Preset, audioMs: number, text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const chars = text.trim().length;

  const byWords = preset.pacing.dwellMinMs + words * preset.pacing.dwellPerWordMs;
  const byReading = (chars / preset.pacing.cps) * 1000;

  return Math.min(preset.pacing.dwellCapMs, Math.max(audioMs, byWords, byReading));
}
