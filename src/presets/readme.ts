/**
 * `readme` — o preset do GIF de README.
 *
 * Existe porque a saída sem voz não é o mesmo produto com o áudio desligado: é
 * outro produto. Três consequências, e cada valor aqui sai de uma delas.
 *
 *  1. **O balão é o único canal.** Nada vai dizer em voz alta o que ele não
 *     disser. Então a fonte é a maior dos presets (21px contra 17 do boardroom),
 *     o peso sobe para 500, e a esquiva do cursor é ligada — num vídeo narrado um
 *     balão passando por cima do cursor custa nada, porque a voz carrega o passo;
 *     aqui esconde a única coisa que o quadro está mostrando.
 *
 *  2. **O leitor de um GIF não controla o tempo.** Não há barra de progresso, não
 *     há pausa, e o loop recomeça sem avisar. Por isso `dwellMinMs` é o maior de
 *     todos e o `cps` é o menor: quem não pode voltar precisa de mais tempo do
 *     que quem pode. E `gapMs` é curto — silêncio entre passos aqui não é
 *     respiração, é peso de arquivo, porque cada quadro parado ainda é um quadro.
 *
 *  3. **Cada pixel é pago em bytes.** O GIF tem 256 cores e nenhuma compressão
 *     entre quadros, então o que custa caro é *movimento*: quadro parado é quase
 *     grátis, quadro diferente é uma paleta nova. Daí o zoom mais contido dos
 *     presets (1.25), o pulso do spotlight desligado e o anel do cursor curto.
 *     As molas seguem as mesmas do boardroom porque o overshoot delas já é
 *     0,01 % — não há repique para economizar; o que economiza é amplitude, e
 *     amplitude é o zoom.
 *
 * A transparência que o `bg` carrega (0.92) vem com `backdropBlurPx: 3` de
 * propósito — ver a interface atrás do balão é bom, ler dois textos sobrepostos
 * não é, e o blur é o que separa as duas coisas.
 *
 * O bloco `voice` continua preenchido e não é decoração: `--preset readme` com
 * saída MP4 é uma combinação válida e narra com ele.
 */
import { SPRINGS } from "../generated/springs.js";
import type { Preset } from "./types.js";

export const readme: Preset = {
  name: "readme",
  summary: "GIF de README, sem voz. Balão grande é o único canal; movimento mínimo.",

  camera: { zoom: 1.25, spring: SPRINGS.screenDefault, minHoldMs: 900 },

  cursor: {
    dotPx: 22,
    travelFactor: 1.1,
    // `cursorMellow` e não `cursorSmooth`: 650ms contra 1500ms para assentar. A
    // smooth é criticamente amortecida e por isso tentadora, mas o dobro e meio
    // de duração é o dobro e meio de quadros de viagem no arquivo final.
    spring: SPRINGS.cursorMellow,
    // Anel curto: a afordância ainda ajuda, mas 900ms de anel pulsando num GIF
    // de 12fps são onze quadros gastos em decoração.
    ring: { toPx: 52, strokePx: 6, durationMs: 500 },
  },

  spotlight: {
    dim: 0.5,
    cutoutRadiusPx: 8,
    paddingPx: 14,
    ringPx: 2,
    // Sem pulso. É a única fonte de movimento perpétuo do overlay e, num formato
    // que paga por quadro diferente, a mais cara que existe.
    pulse: null,
  },

  balloon: {
    maxWidthPx: 520,
    fontSizePx: 28,
    lineHeight: 1.4,
    fontWeight: 600,
    radiusPx: 12,
    paddingPx: [16, 20],
    bg: "rgba(12, 18, 32, 0.92)",
    fg: "#F8FAFC",
    accent: "#38BDF8",
    shadow: "0 2px 4px rgba(0,0,0,.18), 0 8px 24px rgba(0,0,0,.28)",
    placement: "anchored",
    backdropBlurPx: 3,
    avoidCursor: true,
  },

  // `cps` 12 contra 14 do boardroom, e o piso mais alto dos três presets: ler é
  // mais lento que ouvir, e num GIF em loop não existe "volta cinco segundos".
  pacing: { cps: 12, gapMs: 350, dwellMinMs: 2200, dwellPerWordMs: 420, dwellCapMs: 8000 },

  voice: {
    voice: "cedar",
    targetWpm: 140,
    instructions: [
      "Voice Affect: Direta e objetiva, como uma nota de release.",
      "Tone: Técnico e neutro.",
      "Pacing: Constante, aproximadamente 140 palavras por minuto.",
      "Emotion: Mínima.",
      "Pronunciation: Clara, com nomes de campos e botões ditos com nitidez.",
    ].join("\n"),
  },
};
