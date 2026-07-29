/**
 * The storyboard: what the demo does, in order.
 *
 * Two schemas on purpose, and they are not redundant — the same split the user's
 * `planilha` project documents:
 *
 *  - **JSON Schema** with `strict: true` guarantees the *shape* coming out of
 *    the model. A malformed object is impossible.
 *  - **Zod** guarantees the *meaning* after parsing: that a `click` has a
 *    selector, that a `wait` has something to wait for, that durations are sane.
 *
 * Deliberately absent from the JSON Schema: `pattern`, `minLength`, `maxLength`,
 * `minItems`, `maxItems`. OpenAI's supported-keyword list still excludes them
 * under `strict`, and a rejected schema is a hard 400 that kills the feature.
 * Those constraints live in the Zod pass instead.
 */
import { z } from "zod";

/**
 * The action vocabulary. Small on purpose: every verb here has to be something
 * the overlay can narrate, aim a cursor at, and recover from.
 */
export const ACTIONS = ["goto", "click", "type", "hover", "scroll", "focus", "wait"] as const;
export type Action = (typeof ACTIONS)[number];

const StepSchema = z
  .object({
    action: z.enum(ACTIONS),

    /** CSS selector, or a Playwright text= / role= locator. Required by most actions. */
    target: z.string().optional(),

    /** URL for `goto`, text for `type`, ms for `wait`. */
    value: z.string().optional(),

    /**
     * The narration. Split into sentences, one TTS call each; the step advances
     * on the last clip's `onended`.
     */
    say: z.string().optional(),

    /** Override the preset's zoom for this step. `1` disables zoom here. */
    zoom: z.number().min(1).max(4).optional(),

    /** Extra hold after the step's audio finishes, in ms. */
    holdMs: z.number().int().min(0).max(30_000).optional(),
  })
  .superRefine((step, ctx) => {
    const needsTarget: Action[] = ["click", "type", "hover", "focus"];
    if (needsTarget.includes(step.action) && !step.target) {
      ctx.addIssue({ code: "custom", message: `a ação "${step.action}" exige \`target\`` });
    }
    if (step.action === "goto" && !step.value) {
      ctx.addIssue({ code: "custom", message: "`goto` exige `value` com a URL ou o caminho" });
    }
    if (step.action === "type" && !step.value) {
      ctx.addIssue({ code: "custom", message: "`type` exige `value` com o texto a digitar" });
    }
    if (step.action === "wait" && !step.value && !step.target) {
      ctx.addIssue({
        code: "custom",
        message: "`wait` precisa de `target` (espera o seletor) ou `value` (espera N ms) — " +
          "esperar por nada é como um roteiro trava",
      });
    }
  });

export type Step = z.infer<typeof StepSchema>;

export const StoryboardSchema = z.object({
  /** Human title. Goes in the filename and the chapter card, if there is one. */
  title: z.string().min(1),

  /** Dev server URL or file path the demo starts from. */
  url: z.string().min(1),

  /** BCP-47. Drives the locale overlay. */
  locale: z.string().default("pt-BR"),

  preset: z.string().default("boardroom"),

  /** Only the user supplies steps — presets never carry them. */
  steps: z.array(StepSchema).min(1, "um storyboard sem passos não grava nada"),
});

export type Storyboard = z.infer<typeof StoryboardSchema>;

/**
 * The JSON Schema handed to the model. Mirrors the Zod shape but only with
 * keywords `strict: true` accepts.
 *
 * `required` order is load-bearing: `action` and `target` come before `say`, so
 * the model has to commit to what it is doing before it writes what to say about
 * it. Reversed, it writes nice prose and then invents a selector to match.
 */
export const STORYBOARD_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "url", "locale", "preset", "steps"],
  properties: {
    title: { type: "string", description: "Título curto da demo, em português." },
    url: { type: "string", description: "URL de onde a demo começa." },
    locale: { type: "string", enum: ["pt-BR", "en-US"] },
    preset: { type: "string", enum: ["boardroom", "helpdesk"] },
    steps: {
      type: "array",
      description: "Os passos, em ordem de execução.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "target", "value", "say", "zoom", "holdMs"],
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          target: {
            type: ["string", "null"],
            description:
              "Seletor CSS do elemento. Prefira atributos estáveis (data-*, id, role, texto visível) " +
              "a classes geradas por build. null quando a ação não usa alvo.",
          },
          value: {
            type: ["string", "null"],
            description: "URL para goto, texto para type, milissegundos para wait. null se não se aplica.",
          },
          say: {
            type: ["string", "null"],
            description:
              "A narração deste passo, em português natural e falado — não escrito. " +
              "Uma a duas frases. null para um passo silencioso.",
          },
          zoom: {
            type: ["number", "null"],
            description: "Zoom só deste passo, entre 1 e 4. null usa o do preset.",
          },
          holdMs: {
            type: ["integer", "null"],
            description: "Espera extra em ms depois da narração deste passo. null usa o do preset.",
          },
        },
      },
    },
  },
} as const;

/** Parse + validate. Throws a `ZodError` whose issues name the offending step. */
export function parseStoryboard(raw: unknown): Storyboard {
  return StoryboardSchema.parse(raw);
}

/** All narration in the storyboard, in order. What `demovid voice` synthesises. */
export function narrationOf(sb: Storyboard): string[] {
  return sb.steps.map((s) => s.say).filter((s): s is string => typeof s === "string" && s.trim().length > 0);
}
