/**
 * The experimental narration engine: `gpt-audio-1.5` through Chat Completions.
 *
 * `/v1/audio/speech` is a *reader* — it says the string you gave it. `gpt-audio-1.5`
 * is a **generative model that happens to output audio**, and that difference is the
 * whole reason this file is opt-in and paranoid rather than the default.
 *
 * What it buys: a genuinely directed performance. The delivery is steered by a
 * system prompt with as much room as you want, not by a single `instructions`
 * string, so an ad read can be described the way a director would describe it.
 *
 * What it costs, and why it is not the default:
 *
 *  - **It can paraphrase.** A model asked to read a line may improve it. The
 *    timeline, the captions and the EDL all assume the audio says exactly what
 *    `say` says, so a helpful rewording silently desynchronises the artefacts from
 *    the script. Verbatim is therefore **verified, not assumed**: the response
 *    carries a transcript of what was actually spoken, and it is compared against
 *    the input before the clip is accepted.
 *  - **Roughly two orders of magnitude more expensive.** Output audio bills at
 *    $64/1M tokens against a fraction of a cent per sentence on the TTS endpoint.
 *  - **`instructions` does not exist here.** The preset's steering block is moved
 *    into the system prompt instead, which is why the two engines cannot share a
 *    cache entry — the engine is part of the key.
 *
 * On any doubt it falls back to `/v1/audio/speech` with a warning. A recording that
 * ships with a slightly less expressive voice is a good outcome; one that ships
 * saying something the script does not say is not.
 */
import { writeFile } from "node:fs/promises";
import { toSpeakable } from "./speakable.js";
import type { VoiceProfile } from "./tts.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

/** First generally-available audio model. Chat Completions only. */
export const AUDIO_MODEL = "gpt-audio-1.5";

/**
 * Minimum word agreement between the script and what was actually spoken.
 *
 * Not 1.0: the transcript comes from the model's own decoder and disagrees with the
 * input on things that are not paraphrase — above all a written numeral read as
 * words, since `toSpeakable` deliberately leaves bare integers to the synthesiser.
 * In a twelve-word sentence that costs about two tokens, so 0.8 tolerates it.
 *
 * 0.8 against a metric normalised by the LONGER sequence (see {@link agreement}),
 * which is what makes the pair safe: every borderline case fails toward
 * `/v1/audio/speech`, and a take that is slightly less expressive beats a take that
 * says something extra.
 */
const MIN_AGREEMENT = 0.8;

export class AudioEngineError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AudioEngineError";
  }
}

/** Comparable token sequence: no case, no punctuation, no accents. */
function tokens(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Word agreement: longest common subsequence over the **longer** sequence.
 *
 * Two choices, both paid for by a failing test:
 *
 *  - **LCS, not set intersection.** A paraphrase reuses most of the same words in a
 *    different order, and a set comparison calls that a perfect match.
 *  - **Normalised by the longer sequence, not the shorter one.** Dividing by the
 *    shorter one scored `"clique em novo"` against
 *    `"Claro! Aqui vai: clique em novo. Espero ter ajudado!"` as **1.0** — the script
 *    is fully contained, so containment looked like fidelity. That is the exact
 *    failure this gate exists for: the line is read correctly and the video also
 *    contains a greeting and a sign-off. Dividing by the longer sequence scores it
 *    0.27 and rejects it.
 */
export function agreement(expected: string, actual: string): number {
  const a = tokens(expected);
  const b = tokens(actual);
  if (a.length === 0) return b.length === 0 ? 1 : 0;
  if (b.length === 0) return 0;

  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    prev = cur;
  }
  return (prev[b.length] ?? 0) / Math.max(a.length, b.length);
}

/**
 * The script is handed over as a JSON payload with an explicit verbatim flag.
 *
 * That framing is OpenAI's own guidance for making an audio model reproduce supplied
 * content: a tool-result-shaped JSON object with a `require_repeat_verbatim` field is
 * recognised as authoritative content far more reliably than the same request phrased
 * as prose.
 */
function messagesFor(text: string, p: VoiceProfile): unknown[] {
  return [
    {
      role: "system",
      content:
        `You are a Brazilian Portuguese voice actor recording narration for a product demo.\n\n` +
        `PERFORMANCE DIRECTION\n${p.instructions}\n\n` +
        `HARD RULE — you are a reader, not a writer. The user message is a JSON object with a ` +
        `\`script\` field and \`require_repeat_verbatim: true\`. Speak the value of \`script\` ` +
        `exactly as written: do not add, omit, reorder, translate, summarise, correct or improve a ` +
        `single word. Say nothing else — no greeting, no acknowledgement, no closing. Your entire ` +
        `output is that one line, performed.`,
    },
    {
      role: "user",
      content: JSON.stringify({ require_repeat_verbatim: true, script: text }),
    },
  ];
}

interface ChatAudioResponse {
  choices?: Array<{
    message?: { audio?: { data?: string; transcript?: string } };
  }>;
  error?: { message?: string; type?: string };
}

export interface AudioSynthResult {
  /** What the model actually said, per its own transcript. */
  transcript: string;
  agreement: number;
}

/**
 * Synthesise one sentence to `dest` (WAV) with the audio model.
 *
 * Throws {@link AudioEngineError} when the model refuses, when the response carries
 * no audio, or when what it said disagrees with the script. The caller is expected
 * to fall back rather than retry forever.
 */
export async function synthesizeWithAudioModel(
  text: string,
  p: VoiceProfile,
  dest: string,
): Promise<AudioSynthResult> {
  const key = process.env["OPENAI_API_KEY"];
  if (!key) throw new AudioEngineError("OPENAI_API_KEY ausente");

  const spoken = toSpeakable(text);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AUDIO_MODEL,
      modalities: ["text", "audio"],
      audio: { voice: p.voice, format: "wav" },
      messages: messagesFor(spoken, p),
    }),
    signal: AbortSignal.timeout(180_000),
  });

  const json = (await res.json()) as ChatAudioResponse;

  if (!res.ok) {
    const detail = json.error?.message ?? `HTTP ${res.status}`;
    if (json.error?.type === "insufficient_quota") {
      throw new AudioEngineError("conta OpenAI sem saldo", res.status);
    }
    throw new AudioEngineError(`${AUDIO_MODEL} recusou: ${detail}`, res.status);
  }

  const audio = json.choices?.[0]?.message?.audio;
  if (!audio?.data) throw new AudioEngineError(`${AUDIO_MODEL} respondeu sem áudio`);

  const transcript = audio.transcript ?? "";
  const score = agreement(spoken, transcript);
  if (score < MIN_AGREEMENT) {
    throw new AudioEngineError(
      `o modelo parafraseou (concordância ${(score * 100).toFixed(0)}%). ` +
        `Pedido: "${spoken.slice(0, 60)}" · Falado: "${transcript.slice(0, 60)}"`,
    );
  }

  await writeFile(dest, Buffer.from(audio.data, "base64"));
  return { transcript, agreement: score };
}
