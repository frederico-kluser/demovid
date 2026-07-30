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
import { VOICES } from "./openai/tts.js";

/**
 * The action vocabulary. Small on purpose: every verb here has to be something
 * the overlay can narrate, aim a cursor at, and recover from.
 */
export const ACTIONS = ["goto", "click", "type", "hover", "scroll", "focus", "wait"] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * What a `wait` is waiting for. Playwright's four locator states, no more.
 *
 * `hidden` is the one that motivated this field, and it is not reachable by any
 * combination of the others: waiting for a spinner to APPEAR is waiting for the
 * app to get busy, and every storyboard that did it recorded the busy state and
 * then moved on. What a demo needs is the moment the spinner leaves.
 */
export const WAIT_STATES = ["visible", "hidden", "attached", "detached"] as const;
export type WaitState = (typeof WAIT_STATES)[number];

/** The ceiling for a step's waits when it does not set its own. */
export const DEFAULT_STEP_TIMEOUT_MS = 15_000;

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

    /**
     * The balloon text for silent output (GIF/WebP), where there is no voice and
     * the balloon is therefore the *only* channel to the viewer.
     *
     * Deliberately a separate field from `say` rather than a reuse of it: spoken
     * Portuguese and read Portuguese are different products. `say` is a sentence
     * the ear follows once; `caption` is a line the eye scans while the app moves
     * underneath it, and it has to carry the complete idea on its own because
     * nothing is going to say the rest out loud.
     *
     * Absent, silent mode falls back to `say` — a storyboard written for video
     * still produces a readable GIF, just a wordier one.
     */
    caption: z.string().optional(),

    /** Override the preset's zoom for this step. `1` disables zoom here. */
    zoom: z.number().min(1).max(4).optional(),

    /** Extra hold after the step's audio finishes, in ms. */
    holdMs: z.number().int().min(0).max(30_000).optional(),

    /**
     * For `wait`: which state `target` has to reach. Defaults to `visible`, which
     * is what `wait` did before this field existed — an old storyboard keeps its
     * exact behaviour.
     */
    waitFor: z.enum(WAIT_STATES).optional(),

    /**
     * A selector that must be VISIBLE before the step is considered done.
     *
     * This is the "I clicked and now the result has to arrive" case, and it is a
     * different thing from `target`: `target` is what the step acts ON, `expect`
     * is what the action was FOR. Checked after the automatic settle, so it costs
     * nothing when the app was already quiet, and it is the only mechanism that
     * can wait for something the settle cannot see — a result that takes two
     * round trips, a list that repaints after a websocket frame.
     *
     * Unlike `target` this is NOT constrained to the inventory: the element it
     * names frequently does not exist yet at crawl time, which is the entire
     * reason for waiting on it.
     */
    expect: z.string().optional(),

    /**
     * Ceiling for this step's waits, in ms. Defaults to `DEFAULT_STEP_TIMEOUT_MS`.
     *
     * Exists because the default is a guess about a class of app, and the demos
     * that need waiting most — a clone, a build, an import — are exactly the ones
     * that blow through it. Capped at two minutes: past that the honest answer is
     * that the operation does not belong in a demo take.
     */
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
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
    // `waitFor` describes a state a TARGET reaches. On a timed wait there is no
    // target to reach it, so the field would silently do nothing — and a silent
    // no-op in a wait is exactly the bug this vocabulary exists to prevent.
    if (step.waitFor && !step.target) {
      ctx.addIssue({
        code: "custom",
        message: "`waitFor` diz em que estado o `target` tem que ficar — sem `target` ele não espera nada",
      });
    }
    if (step.waitFor && step.action !== "wait") {
      ctx.addIssue({
        code: "custom",
        message: `\`waitFor\` só vale na ação "wait" — para esperar depois de "${step.action}", use \`expect\``,
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

  /**
   * Voice overrides, on top of whatever the preset picked.
   *
   * These two live in the Zod schema and **deliberately not** in
   * `STORYBOARD_JSON_SCHEMA`. `strict: true` forces every declared property into
   * `required`, so adding them there would oblige the model to choose a voice on
   * every storyboard it writes — a decision it has no basis for and which the
   * preset already made. They exist for a human editing YAML and for `--voice` /
   * `--wpm`; the model never sees them.
   */
  voice: z.enum(VOICES).optional(),
  wpm: z.number().int().min(60, "menos de 60 wpm não é fala").max(400, "acima de 400 wpm não é inteligível").optional(),

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
    preset: { type: "string", enum: ["boardroom", "helpdesk", "readme", "comercial"] },
    steps: {
      type: "array",
      description: "Os passos, em ordem de execução.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "action",
          "target",
          "value",
          "waitFor",
          "expect",
          "timeoutMs",
          "say",
          "caption",
          "zoom",
          "holdMs",
        ],
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
          waitFor: {
            type: ["string", "null"],
            enum: [...WAIT_STATES, null],
            description:
              'Só na ação "wait": em que estado o `target` tem que ficar. "visible" espera aparecer, ' +
              '"hidden" espera SUMIR — é assim que se espera um spinner terminar. null usa "visible".',
          },
          expect: {
            type: ["string", "null"],
            description:
              "Seletor que precisa estar VISÍVEL para o passo ser dado por concluído. Use depois de uma " +
              "ação que dispara carregamento, nomeando o RESULTADO que deve chegar. Diferente de `target`: " +
              "`target` é onde a ação acontece, `expect` é o que ela produz. Pode ser um seletor que ainda " +
              "não existe no inventário. null quando a ação não produz nada novo.",
          },
          timeoutMs: {
            type: ["integer", "null"],
            description:
              "Teto de espera deste passo em ms, de 100 a 120000. Aumente para operações reconhecidamente " +
              "lentas (clone, build, importação). null usa 15000.",
          },
          say: {
            type: ["string", "null"],
            description:
              "A narração deste passo, em português natural e falado — não escrito. " +
              "Uma a duas frases. null para um passo silencioso.",
          },
          caption: {
            type: ["string", "null"],
            description:
              "O texto do balão para saída SEM voz (GIF/WebP), em português escrito e curto. " +
              "É a única forma de comunicação nesse modo, então precisa entregar a ideia completa " +
              "sozinho. Uma frase, sem locução, sem 'agora vamos'. null quando não houver.",
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

/**
 * The text the balloon shows for a step.
 *
 * One function rather than a conditional at each call site, because there are
 * three of them (the conductor, the dwell calculation and the timeline mark) and a
 * disagreement between any two of them is a balloon whose text does not match the
 * time it is given to be read.
 *
 * Takes the channel rather than a `silent` flag: the caller that knows which field
 * this output mode speaks through is `MODE_CAPS`, and a boolean here forced every
 * call site to re-derive it.
 */
export function balloonTextOf(step: Step, channel: "say" | "caption"): string | undefined {
  if (channel === "say") return step.say;
  // A storyboard written for video and re-recorded silently has no `caption`;
  // `say` read cold is worse than nothing only if it is missing too.
  return step.caption ?? step.say;
}
