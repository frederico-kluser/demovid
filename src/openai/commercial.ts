/**
 * Writes the *edit*, not the demo.
 *
 * By the time this runs the take already exists: the storyboard was executed, the
 * narration was measured, and `.timeline.json` knows how long every scene actually
 * lasted. So this call is not creative in the way the storyboard call is — it is
 * asked to make editorial decisions against **real durations**, which is why the
 * measured length of each scene goes into the prompt. A model asked for "an impact
 * phrase" with no duration will happily write eight words for a 900 ms shot.
 *
 * Two things specific to this call:
 *
 *  - **`required` order puts the cut before the words.** Per scene the model must
 *    emit `transition` and `impactAtPercent` *before* `impact`, so it commits to
 *    where the cut lands and when the text appears before it writes the text. The
 *    storyboard schema uses the same trick for `action`/`target` before `say`, for
 *    the same reason: reversed, the model writes agreeable prose and then bends the
 *    mechanics to fit it.
 *  - **Percentages, not frames.** The model never sees a frame number. It places
 *    the impact phrase at a fraction of the scene, and `buildEdl` converts — so the
 *    EDL's frame arithmetic has exactly one owner and the model cannot emit a frame
 *    outside the scene it belongs to.
 *
 * `transition` is restricted to the three presentations confirmed in the
 * `@remotion/transitions` docs (`fade`, `slide`, `wipe`) plus `corte` for a hard
 * cut. An enum the renderer cannot import is a runtime crash in the Studio.
 */
import { z } from "zod";
import { callStructured, CHAT_MODEL, ChatError, stripNulls } from "./responses.js";

/** What the renderer can actually draw. `corte` means "no Transition element". */
export const TRANSITIONS = ["corte", "fade", "slide", "wipe"] as const;
export type TransitionKind = (typeof TRANSITIONS)[number];

const SceneEditSchema = z.object({
  /** Which storyboard step this refers to. */
  index: z.number().int().min(0),
  transition: z.enum(TRANSITIONS),
  /** Where in the scene the impact phrase appears, 0–1. */
  impactAtPercent: z.number().min(0).max(0.9),
  /**
   * Two to five words on screen; absent for a scene that carries no text.
   *
   * `.nullish()`, not `.nullable()`: `strict` forces the model to emit
   * `["string","null"]`, and `stripNulls` then removes the null on the way in — so
   * what reaches zod is `undefined`. Declaring only `nullable` rejected every
   * scene the model correctly left without text.
   */
  impact: z.string().max(48, "frase de impacto acima de 48 caracteres não é impacto, é legenda").nullish(),
  /** Slow push-in for a scene the in-page camera left static. */
  kenBurns: z.boolean(),
});

export const CommercialSchema = z.object({
  /** The opening title card. */
  hook: z.object({
    text: z.string().max(60, "o gancho tem que caber em uma linha"),
    sub: z.string().max(90).nullish(),
  }),
  scenes: z.array(SceneEditSchema),
  endCard: z.object({
    title: z.string().max(60),
    cta: z.string().max(48),
  }),
});

export type Commercial = z.infer<typeof CommercialSchema>;
export type SceneEdit = z.infer<typeof SceneEditSchema>;

/**
 * Hand-written JSON Schema. Mirrors the zod shape with only the keywords
 * `strict: true` accepts — no `pattern`, no `maxLength`, no `maxItems`. Those live
 * in the zod pass above, which runs after.
 */
const COMMERCIAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hook", "scenes", "endCard"],
  properties: {
    hook: {
      type: "object",
      additionalProperties: false,
      required: ["text", "sub"],
      properties: {
        text: {
          type: "string",
          description:
            "O gancho de abertura, em português. Uma linha, no máximo 60 caracteres. " +
            "Diz o benefício, não o nome da tela.",
        },
        sub: {
          type: ["string", "null"],
          description: "Subtítulo do gancho, ainda mais curto. null se o gancho já basta.",
        },
      },
    },
    scenes: {
      type: "array",
      description: "Uma entrada por passo do roteiro, na mesma ordem.",
      items: {
        type: "object",
        additionalProperties: false,
        // Ordem load-bearing: o corte e o instante ANTES do texto.
        required: ["index", "transition", "impactAtPercent", "impact", "kenBurns"],
        properties: {
          index: { type: "integer", description: "O índice do passo a que isto se refere." },
          transition: {
            type: "string",
            enum: [...TRANSITIONS],
            description:
              "Como esta cena ENTRA. `corte` é corte seco e é o default certo na maioria das " +
              "vezes: transição em toda cena vira videoclipe de screensaver. Use `fade` para " +
              "mudança de assunto, `wipe` para avanço no mesmo fluxo, `slide` com parcimônia.",
          },
          impactAtPercent: {
            type: "number",
            description:
              "Em que fração da cena a frase de impacto aparece, de 0 a 0.9. Cedo demais " +
              "compete com a transição; tarde demais ninguém lê.",
          },
          impact: {
            type: ["string", "null"],
            description:
              "Duas a cinco palavras, em português, na tela. É tipografia de comercial, não " +
              "legenda: nunca repete a narração, dá o número ou o benefício que ela não disse. " +
              "null quando a cena não precisa de texto — e a maioria não precisa.",
          },
          kenBurns: {
            type: "boolean",
            description:
              "Aproximação lenta durante a cena. Só faz sentido onde a câmera da página ficou " +
              "parada; será ignorado nas cenas em que ela já se moveu.",
          },
        },
      },
    },
    endCard: {
      type: "object",
      additionalProperties: false,
      required: ["title", "cta"],
      properties: {
        title: { type: "string", description: "O fecho, em português. Curto." },
        cta: { type: "string", description: "A chamada para ação. Curtíssima." },
      },
    },
  },
} as const;

const SYSTEM = `You are the editor of a product commercial, working from a screen recording that already exists.

You receive the demo's title, the narration that was actually spoken, and the MEASURED duration of
every scene. You decide the edit: the opening hook, one transition per scene, an optional impact
phrase per scene, and the end card.

HARD RULES
- All text you write is in Brazilian Portuguese, and it is TYPOGRAPHY, not narration. It is read, not
  heard. Short, punchy, no final period on fragments.
- NEVER repeat what the narration already says. The voice and the text are two channels; saying the
  same thing twice wastes both. Text carries the number, the benefit, or the claim the voice skipped.
- Impact phrases are two to five words. If you need more, the scene does not want text.
- MOST SCENES GET NO IMPACT PHRASE. A commercial with a caption on every shot reads as a slideshow.
  Three or four across the whole piece is a lot.
- Default transition is \`corte\`. A transition on every scene looks like a screensaver, and each one
  costs real frames from both neighbours.
- A scene shorter than about 1.2 seconds gets \`corte\` and no impact phrase: there is no room.
- \`kenBurns\` only where it was offered as available. It is ignored elsewhere.
- Return exactly one entry per scene, in order, with the index you were given.`;

export interface CommercialOptions {
  title: string;
  /** Per scene: the step's action, the narration spoken over it, and its real length. */
  scenes: Array<{
    index: number;
    action: string;
    target?: string | undefined;
    durationMs: number;
    narration: string;
    /** False when the in-page camera already moved here — Ken Burns would double up. */
    cameraStatic: boolean;
  }>;
  log?: ((line: string) => void) | undefined;
}

/** Serialise the scene table for the prompt. Durations in seconds — the model reasons better in them. */
function sceneTable(opts: CommercialOptions): string {
  return opts.scenes
    .map((s) => {
      const secs = (s.durationMs / 1000).toFixed(1);
      const cam = s.cameraStatic ? "câmera parada (kenBurns disponível)" : "câmera já se moveu";
      const say = s.narration.trim() ? `narração: "${s.narration.trim()}"` : "sem narração";
      return `- index ${s.index} · ${s.action}${s.target ? ` ${s.target}` : ""} · ${secs}s · ${cam}\n  ${say}`;
    })
    .join("\n");
}

export async function writeCommercial(opts: CommercialOptions): Promise<Commercial> {
  const input =
    `## DEMO\n${opts.title}\n\n` +
    `## CENAS (duração medida, na ordem do vídeo)\n${sceneTable(opts)}\n\n` +
    `## O QUE ENTREGAR\nA montagem: gancho, uma entrada por cena e o cartão de fecho.`;

  const log = opts.log ?? ((): void => {});
  log(`escrevendo a montagem com ${CHAT_MODEL}`);

  const { text } = await callStructured({
    name: "commercial",
    schema: COMMERCIAL_JSON_SCHEMA,
    system: SYSTEM,
    input,
    log,
  });

  const parsed = CommercialSchema.parse(stripNulls(JSON.parse(text)));

  // The model is asked for one entry per scene and usually complies; a missing or
  // extra entry is repaired locally rather than with a second paid round trip,
  // because `buildEdl` can fall back to a hard cut with no text and lose nothing.
  const seen = new Set<number>();
  const scenes = parsed.scenes.filter((s) => {
    if (seen.has(s.index)) return false;
    seen.add(s.index);
    return opts.scenes.some((x) => x.index === s.index);
  });
  if (scenes.length !== opts.scenes.length) {
    log(`a montagem cobriu ${scenes.length} de ${opts.scenes.length} cenas — o resto vira corte seco`);
  }

  return { ...parsed, scenes };
}

export { ChatError as CommercialError };
