/**
 * Writes the storyboard: the app's real, verified elements plus a sentence of
 * intent in Portuguese go in, a validated `Storyboard` comes out.
 *
 * Uses `STORYBOARD_JSON_SCHEMA` from `src/storyboard.ts` — a schema that had
 * existed since the beginning and had never been imported by anything. It was
 * written for this.
 *
 * The transport lives in `src/openai/responses.ts`: the reasoning item that
 * carries no text, the `incomplete` retry ladder, the ten-minute timeout, and the
 * JSON-Schema keyword blacklist are documented there, once, for both callers.
 *
 * What is specific to *this* call and stays here:
 *
 *  - **The user's request goes LAST.** Same recency reasoning that makes the order
 *    of `required` load-bearing in the schema: the model commits to the most recent
 *    instruction, and the instruction that matters is theirs.
 *  - **Selector validity is checked locally, against the inventory.** It cannot be
 *    a schema constraint — `pattern` is one of the keywords `strict` rejects — so
 *    `auditStoryboard` does it without spending a call.
 */
import { z } from "zod";
import {
  callStructured,
  CHAT_MODEL,
  ChatError,
  stripNulls,
} from "./responses.js";
import {
  parseStoryboard,
  STORYBOARD_JSON_SCHEMA,
  type Storyboard,
} from "../storyboard.js";

/**
 * The Structured Outputs envelope for every storyboard call — draft and repairs.
 *
 * Shared so a repair can never travel under a different schema than the draft it
 * is repairing, which would let the model "fix" a rule it was never given.
 */
const STORYBOARD_CALL = { name: "storyboard", schema: STORYBOARD_JSON_SCHEMA } as const;

const SYSTEM = `You write storyboards for demovid, a tool that records narrated product demos.

You are given a verified inventory of an app's addressable elements and a request in Portuguese
describing what to demonstrate. Produce a storyboard.

HARD RULES
- Every non-null "target" MUST be copied VERBATIM from the inventory's selector column.
  Never invent, abbreviate, or "fix" a selector. Never write "id=foo" — copy "#foo" exactly as listed.
- Use only elements that serve the requested demo. A shorter, focused demo beats a complete tour.
- "say" is spoken Portuguese, not written Portuguese: short sentences, no bullet points, no
  parentheses, no URLs, no markdown. Numbers that will be read aloud should be written as words when
  they are short ("vinte e quatro"), as digits when long.
- One to two sentences per step. The narration of a step plays while that step happens.
- Order matters: the demo is executed top to bottom, and each step leaves the app in the state the
  next one starts from. A "type" into a field that a later step navigates away from is wasted.
- Prefer 5 to 9 steps. Fewer than 4 is not a demo; more than 12 is a manual.
- Actions that need a target: click, type, hover, focus. "goto" needs a URL in value. "type" needs the
  text in value. "wait" needs either a target to wait for or milliseconds in value.
- Start with a "wait" step that introduces the app while the first sentence plays.

ESPERAR CARREGAMENTO — the difference between a demo and a video of a spinner

The recorder already waits, on its own, for the app to go quiet after every click, type, goto and
scroll: it waits out the network and waits for every known loading indicator to disappear. You do
not need to add a step for that, and adding a bare "wait" with milliseconds after every click is
the wrong instinct — it makes the video longer without making it more correct.

What the recorder CANNOT work out on its own, and what you are responsible for:

- **"expect"** — when an action's whole point is to produce something, name the thing. Put in
  "expect" the selector of the RESULT that has to be on screen before the demo moves on: the list
  that gets populated, the panel that opens, the graph that draws. This is what stops the next step
  from acting on a screen that has not arrived yet, and it is the single most valuable field here.
  It may be a selector that is NOT in the inventory — the element usually does not exist until the
  action creates it, which is exactly why it is worth waiting for.
- **"timeoutMs"** — the default ceiling is 15 seconds. If the app's notes say an operation is slow
  (a clone, a build, an import, anything that shells out), set this on that step. A step that ran
  out of time is a failed step in the report and a cut in the video.
- **"wait" with "waitFor": "hidden"** — to wait for a specific spinner to LEAVE, when the inventory
  lists a loading indicator and the moment it disappears is itself worth showing. Note the
  direction: waiting for a spinner to APPEAR records the app being busy, which is the opposite of
  what a demo wants.

Rules of thumb: prefer "expect" over a timed "wait" every time — one describes the app, the other
describes a guess. Never use a timed "wait" longer than 2000ms to paper over a load; that is what
"expect" and "timeoutMs" are for. Do not put a loading indicator in "target" of a click.`;

/**
 * Appended for silent output. The difference is not "shorter `say`" — it is a
 * different field with a different job.
 *
 * A narrated step can afford a sentence that only makes sense while the screen
 * moves, because the voice and the motion arrive together. A caption in a looping
 * GIF is read cold, possibly starting from the middle, with nothing to fill in
 * what it left out. So it has to be self-contained, and it has to fit in the
 * reading budget the preset allows — `pacing.cps` at 12 with `dwellCapMs` at 8 s
 * is about 96 characters before the step is holding the frame longer than it is
 * worth, and every held frame is bytes in a format with no inter-frame
 * compression.
 */
const GIF_ADDENDUM = `

## MODO GIF — SEM VOZ

This storyboard is for a silent animated GIF, so "caption" is the ONLY channel to the viewer.
Nothing will be said out loud. Write BOTH fields:

- "caption" (required on every step that communicates anything): written Portuguese, not spoken.
  ONE short sentence, ideally under 90 characters, never over 120. It must carry the complete idea on
  its own — the viewer may start reading mid-loop. No "agora vamos", no "veja que", no "aqui em
  cima": those depend on a voice and a moment. Prefer naming the thing and its consequence
  ("A busca aceita protocolo ou nome do paciente"). Sentence case, no final period on fragments.
- "say": write it anyway, in spoken Portuguese as usual. It costs nothing here and makes the same
  file re-recordable as a narrated video later.
- "preset": use "readme".
- Prefer 4 to 7 steps, not 5 to 9. A GIF is paid for by the frame: every step is roughly three
  seconds of file. A demo that needs nine steps needs a video, and saying so is better than
  delivering a 12 MB GIF.`;

/** The system prompt for the output being written. */
const systemFor = (silent: boolean): string => (silent ? SYSTEM + GIF_ADDENDUM : SYSTEM);

export interface WriteOptions {
  /** What the operator asked for, in Portuguese. */
  request: string;
  /**
   * Writing for silent output (GIF/WebP): the model also fills `caption`, which
   * becomes the only channel to the viewer.
   */
  silent?: boolean;
  /** Serialised inventory of verified selectors. */
  inventory: string;
  /** Selectors the model is allowed to use. */
  allowed: Set<string>;
  /**
   * What the project's own configuration says about waiting: its loading
   * indicators, the selectors that mean "done", and which operations are slow.
   * Written by `pi` into `.demovid.json`; empty when nothing is known.
   */
  readiness?: string;
  appName: string;
  url: string;
  log: (line: string) => void;
}

/** The readiness section of the prompt, or nothing when there is nothing to say. */
const readinessBlock = (readiness: string | undefined): string =>
  readiness?.trim()
    ? `## ESPERAS CONHECIDAS NESTE APP (do \`.demovid.json\`)\n${readiness}\n\n`
    : "";

/** Problems that are worth another round-trip, phrased for the model. */
function auditStoryboard(sb: Storyboard, allowed: Set<string>): string[] {
  const problems: string[] = [];
  for (const [i, step] of sb.steps.entries()) {
    if (!step.target) continue;
    if (!allowed.has(step.target)) {
      problems.push(
        `step ${i} (${step.action}) uses target ${JSON.stringify(step.target)}, which is NOT in the ` +
          `inventory. Replace it with a selector copied verbatim from the inventory, or drop the step.`,
      );
    }
  }
  return problems;
}

export async function writeStoryboard(opts: WriteOptions): Promise<Storyboard> {
  const header =
    `## APP\nname: ${opts.appName}\nurl: ${opts.url}\n\n` +
    `## INVENTORY (the ONLY selectors you may use)\n${opts.inventory}\n\n` +
    readinessBlock(opts.readiness) +
    `## PEDIDO DO USUÁRIO (em português — é isto que a demo tem que mostrar)\n${opts.request}`;

  const system = systemFor(opts.silent ?? false);
  opts.log(`pensando com ${CHAT_MODEL} — isso leva alguns minutos`);
  let { text } = await callStructured({ ...STORYBOARD_CALL, input: header, system, log: opts.log });

  // Up to two repairs. Since the move off Structured Outputs the SHAPE is no
  // longer guaranteed by the server either, so this loop now sees three kinds of
  // problem: a malformed object, a zod cross-field rule, and a selector that is
  // not in the inventory — the last checked locally, without spending a call.
  for (let attempt = 0; attempt < 3; attempt++) {
    let sb: Storyboard | null = null;
    let problems: string[] = [];

    try {
      sb = parseStoryboard(stripNulls(JSON.parse(text)));
      problems = auditStoryboard(sb, opts.allowed);
      if (problems.length === 0) {
        sb.url = opts.url;
        return sb;
      }
    } catch (err) {
      problems =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
          : [(err as Error).message];
    }

    if (attempt === 2) {
      throw new ChatError(
        `o modelo não produziu um roteiro válido depois de 3 tentativas:\n  ${problems.join("\n  ")}`,
      );
    }

    opts.log(`corrigindo ${problems.length} problema(s) no roteiro`);
    // The inventory goes back with every repair. Chat Completions is STATELESS —
    // there is no conversation to inherit it from, and the commonest problem here
    // is "target is not in the inventory". Asking for a valid selector without
    // sending the list of valid selectors can only be answered by guessing, so
    // the repair failed, burnt two more max-reasoning calls, and threw.
    ({ text } = await callStructured(
      {
        ...STORYBOARD_CALL,
        input:
          `## INVENTORY (the ONLY selectors you may use)\n${opts.inventory}\n\n` +
          `## THE STORYBOARD YOU PRODUCED\n${text}\n\n` +
          `## PROBLEMS — fix ONLY these and return the whole storyboard again\n` +
          problems.map((p) => `- ${p}`).join("\n"),
        system,
        log: opts.log,
      },
    ));
  }

  throw new ChatError("inalcançável");
}

export interface RefineOptions extends Omit<WriteOptions, "request"> {
  current: Storyboard;
  /** What to change, in Portuguese. */
  instruction: string;
}

export async function refineStoryboard(opts: RefineOptions): Promise<Storyboard> {
  const system = systemFor(opts.silent ?? false);
  opts.log(`revisando o roteiro com ${CHAT_MODEL}`);
  const input =
    `## ROTEIRO ATUAL\n${JSON.stringify(opts.current, null, 2)}\n\n` +
    `## INVENTORY (the ONLY selectors you may use)\n${opts.inventory}\n\n` +
    readinessBlock(opts.readiness) +
    `## O QUE MUDAR (em português)\n${opts.instruction}`;

  let { text } = await callStructured({ ...STORYBOARD_CALL, input, system, log: opts.log });

  for (let attempt = 0; attempt < 3; attempt++) {
    let problems: string[] = [];
    try {
      const sb = parseStoryboard(stripNulls(JSON.parse(text)));
      problems = auditStoryboard(sb, opts.allowed);
      if (problems.length === 0) {
        sb.url = opts.url;
        return sb;
      }
    } catch (err) {
      problems =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
          : [(err as Error).message];
    }
    if (attempt === 2) {
      throw new ChatError(`a revisão não ficou válida:\n  ${problems.join("\n  ")}`);
    }
    // Same reason as in `writeStoryboard`: the inventory has to travel with each
    // repair, because Chat Completions carries nothing between calls.
    ({ text } = await callStructured(
      {
        ...STORYBOARD_CALL,
        input:
          `## INVENTORY (the ONLY selectors you may use)\n${opts.inventory}\n\n` +
          `## THE STORYBOARD YOU PRODUCED\n${text}\n\n` +
          `## PROBLEMS — fix ONLY these and return the whole storyboard again\n` +
          problems.map((p) => `- ${p}`).join("\n"),
        system,
        log: opts.log,
      },
    ));
  }

  throw new ChatError("inalcançável");
}
