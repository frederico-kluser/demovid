/**
 * `comercial` — o preset que grava para ser cortado depois.
 *
 * Os outros três presets gravam o produto final: o que sai da câmera é o que o
 * espectador vê. Este grava **matéria-prima para uma montagem**, e todo valor aqui
 * sai dessa diferença.
 *
 *  1. **O balão está desligado — e não é este arquivo que o desliga.** Quem decide
 *     é `MODE_CAPS.remotion.balloon` em `src/output-mode.ts`, porque é uma
 *     propriedade do *modo de saída*, não da aparência: `--preset comercial` com
 *     saída MP4 é uma combinação válida e narra com balão normalmente. Por isso o
 *     bloco `balloon` continua preenchido, e preenchido para o caso em que ele
 *     aparece: fonte grande, `lower-third`, que é onde legenda de comercial mora.
 *
 *  2. **Ar morto entre passos é matéria-prima do corte, não respiração.** Um
 *     `gapMs` de 700 (boardroom) vira 700ms que a montagem tem de remover em toda
 *     transição. Mas ele não pode ir a zero: `scoreCuts` só emite ponto de corte
 *     dentro de silêncio de mais de 300ms (`src/timeline.ts`), então um gap curto
 *     demais apaga os próprios pontos de corte que o EDL precisa. 400ms é o
 *     equilíbrio: sobra silêncio para cortar dentro, sem sobrar silêncio para
 *     cortar fora.
 *
 *  3. **Ritmo de anúncio, e é aqui que o `speed` finalmente entra.** 165 wpm está
 *     acima do teto de 140 onde `instructions` satura, então `speedFor` devolve
 *     1.18 e o parâmetro `speed` — que com os três presets anteriores era código
 *     morto, todos em 140 ou abaixo — passa a ser exercitado de verdade.
 *
 * O zoom é o mais agressivo dos presets (1.6 contra 1.5 do boardroom) porque a
 * montagem vai cortar em cima do movimento: um corte que cai num quadro parado e
 * chapado não tem energia nenhuma, e o zoom in-page tem resolução real — ampliar
 * depois, sobre pixels já gravados, não tem.
 */
import { SPRINGS } from "../generated/springs.js";
import type { Preset } from "./types.js";

export const comercial: Preset = {
  name: "comercial",
  summary: "Matéria-prima para montagem: ritmo de anúncio, gap curto, sem balão queimado.",

  camera: { zoom: 1.6, spring: SPRINGS.screenDefault, minHoldMs: 700 },

  cursor: {
    dotPx: 20,
    // Abaixo de 1: mais rápido que um usuário real. Num comercial o cursor não
    // está ensinando o caminho, está mostrando que o caminho é curto.
    travelFactor: 0.85,
    spring: SPRINGS.cursorMellow,
    ring: { toPx: 48, strokePx: 5, durationMs: 420 },
  },

  spotlight: {
    dim: 0.42,
    cutoutRadiusPx: 10,
    paddingPx: 12,
    ringPx: 2,
    // Sem pulso: a montagem vai colocar movimento própio em cima. Duas fontes de
    // animação disputando o mesmo quadro é o que faz um comercial parecer amador.
    pulse: null,
  },

  balloon: {
    maxWidthPx: 520,
    fontSizePx: 20,
    lineHeight: 1.4,
    fontWeight: 600,
    radiusPx: 10,
    paddingPx: [14, 20],
    bg: "rgba(9, 12, 20, 0.90)",
    fg: "#FFFFFF",
    accent: "#F59E0B",
    shadow: "0 2px 6px rgba(0,0,0,.22), 0 10px 30px rgba(0,0,0,.30)",
    placement: "lower-third",
    backdropBlurPx: 4,
    avoidCursor: false,
  },

  // `gapMs` 400: curto para o ritmo, longo o suficiente para `scoreCuts` (>300ms)
  // ainda encontrar onde cortar. Ver o item 2 do cabeçalho.
  pacing: { cps: 15, gapMs: 400, dwellMinMs: 1200, dwellPerWordMs: 300, dwellCapMs: 6000 },

  voice: {
    voice: "cedar",
    // Acima do WPM_CEILING de 140 de propósito — ver o item 3 do cabeçalho.
    targetWpm: 165,
    instructions: [
      "Voice Affect: Enérgica e confiante, de locução publicitária. Vende sem gritar.",
      "Tone: Entusiasmado e direto, como um anúncio de produto que tem certeza do que entrega.",
      "Pacing: Rápido e com impulso, aproximadamente 165 palavras por minuto. Acelera nos benefícios e segura um instante antes do fecho.",
      "Emotion: Otimismo genuíno. Convicção comercial, nunca sarcasmo e nunca locução de call center.",
      "Pronunciation: Nítida e projetada. Nomes de produto e números ditos com ênfase clara.",
    ].join("\n"),
  },
};
