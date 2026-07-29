/**
 * Narration synthesis.
 *
 * Raw `fetch`, no SDK — the dominant convention across the user's projects.
 *
 * Three things here are measurements, not preferences (2026-07-29, 26-word
 * realistic sentences, `gpt-4o-mini-tts`):
 *
 *  - **One API call per sentence.** Long inputs degrade badly: 10–60 s of
 *    silence, dropped sentences. Sentence granularity also makes the cache
 *    useful — editing one line re-synthesises one line.
 *  - **`instructions` saturates at ~140 wpm.** Asking for 130 delivered 129;
 *    asking for 170 still delivered 140. Above 140 the only working lever is
 *    `speed`, which is linear and reliable here (1.15→1.19×, 1.30→1.32×,
 *    1.50→1.58×) — contradicting the common advice that `speed` is unreliable.
 *  - **Trim edge silence — it is not optional.** A first measurement on one long
 *    clip showed 44–108 ms and I concluded it was not worth doing. That was the
 *    wrong measurement for this architecture: with one clip per sentence, short
 *    clips carry proportionally huge padding — **840 ms on average**, i.e. ~17 s
 *    of dead air across a 20-sentence script. Since `audio.onended` drives step
 *    advance, that is 17 s of a frozen screen. Trimming also turns the gap
 *    between steps into a preset knob instead of an accident of the synthesiser.
 */
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "../exec.js";

const ENDPOINT = "https://api.openai.com/v1/audio/speech";
const MODEL = "gpt-4o-mini-tts";

/** Above this, `instructions` stops being obeyed and `speed` takes over. */
export const WPM_CEILING = 140;

export type Voice = "alloy" | "ash" | "ballad" | "cedar" | "coral" | "echo" | "fable" | "marin" | "nova" | "onyx" | "sage" | "shimmer" | "verse";

export interface VoiceProfile {
  voice: Voice;
  /** Steers accent, tone and pacing. Ignored by `tts-1`/`tts-1-hd`. */
  instructions: string;
  /** Words per minute the preset wants. */
  targetWpm: number;
}

export interface SynthOptions {
  /** Directory for the .mp3 files and the manifest. */
  cacheDir: string;
  profile: VoiceProfile;
  /** Normalise loudness with ffmpeg after synthesis. */
  normalize?: boolean;
  onProgress?: (done: number, total: number, cached: boolean, text: string) => void;
}

export interface Clip {
  /** Stable id — the content hash. Also the filename. */
  id: string;
  text: string;
  path: string;
  durationS: number;
  cached: boolean;
}

export class TtsError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

/**
 * `speed` for a target rate. 1.0 up to the ceiling, then proportional.
 *
 * Splitting the two levers matters: below the ceiling, `instructions` produces a
 * genuinely differently-paced *performance*; `speed` only time-stretches one.
 */
export function speedFor(targetWpm: number): number {
  if (targetWpm <= WPM_CEILING) return 1;
  return Math.round((targetWpm / WPM_CEILING) * 100) / 100;
}

/**
 * The cache key. Every input that changes the audio goes in, so a changed voice
 * or a reworded instruction invalidates cleanly — and nothing else does.
 */
function clipId(text: string, p: VoiceProfile): string {
  return createHash("sha256")
    .update(JSON.stringify([MODEL, p.voice, p.instructions, speedFor(p.targetWpm), text.trim()]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Abbreviations whose trailing dot must never end a sentence. Measured failure:
 * "O Dr. Silva assina" split into "O Dr." + "Silva assina" — an audible pause
 * in the middle of a name, because the next token is legitimately capitalised.
 */
const ABBREV = [
  "dr", "dra", "sr", "sra", "srta", "prof", "profa", "eng", "exmo", "exma",
  "av", "r", "pç", "ltda", "cia", "art", "fig", "tab", "pág", "cap",
  "ex", "etc", "obs", "ref", "núm", "nº", "no", "vs", "aprox", "máx", "mín",
];
const ABBREV_RE = new RegExp(`(?:^|[\\s(])(?:${ABBREV.join("|")})\\.$`, "iu");

/**
 * Split narration into sentences — one API call each.
 *
 * Conservative by design: a wrong split becomes an audible pause inside a
 * phrase, which is far worse than a slightly long clip. Guards both the
 * abbreviation case and decimals (`2.5 horas` survives because the lookahead
 * demands an uppercase opener).
 */
export function splitSentences(text: string): string[] {
  const parts = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Þ"“'(])/u);

  const out: string[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    // If the previous fragment ended on an abbreviation, it was never a
    // sentence boundary — glue it back.
    if (prev !== undefined && ABBREV_RE.test(prev)) out[out.length - 1] = `${prev} ${part}`;
    else out.push(part);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

async function durationOf(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ]);
  return Number.parseFloat(stdout.trim());
}

/**
 * Cut leading and trailing silence, hard.
 *
 * The `areverse` sandwich is the standard trick: `silenceremove` only trims the
 * head, so you trim, reverse, trim again, reverse back. `-45 dB` is above the
 * synthesiser's noise floor and below anything voiced.
 *
 * Trimming to near-zero is deliberate. The pause between steps belongs to the
 * preset (`inter-step gap`), not to whatever padding the model happened to emit.
 */
const TRIM_FILTER =
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse," +
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse";

/**
 * Two-pass EBU R128 to −14 LUFS / −1 dBTP, with the trim in the same graph.
 *
 * One-pass `loudnorm` is a dynamic normaliser and pumps on speech. YouTube's
 * normalisation is also asymmetric — too loud gets turned down, too quiet stays
 * quiet forever — so landing on target matters more than it looks.
 */
async function normalizeLoudness(input: string, output: string): Promise<void> {
  const { stderr } = await run("ffmpeg", [
    "-v", "info", "-i", input,
    "-af", `${TRIM_FILTER},loudnorm=I=-14:TP=-1:LRA=11:print_format=json`,
    "-f", "null", "-",
  ]);
  const m = /\{[\s\S]*\}/.exec(stderr);
  if (!m) {
    // Measurement failed; a single pass still beats shipping unnormalised audio.
    await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-af", `${TRIM_FILTER},loudnorm=I=-14:TP=-1:LRA=11`, "-b:a", "192k", output]);
    return;
  }
  const s = JSON.parse(m[0]) as Record<string, string>;
  await run("ffmpeg", [
    "-v", "error", "-y", "-i", input,
    "-af",
    `${TRIM_FILTER},` +
      `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${s["input_i"]}:measured_TP=${s["input_tp"]}` +
      `:measured_LRA=${s["input_lra"]}:measured_thresh=${s["input_thresh"]}` +
      `:offset=${s["target_offset"]}:linear=true`,
    "-b:a", "192k",
    output,
  ]);
}

async function synthesizeOne(text: string, p: VoiceProfile, dest: string): Promise<void> {
  const key = process.env["OPENAI_API_KEY"];
  if (!key) throw new TtsError("OPENAI_API_KEY ausente");

  const body = {
    model: MODEL,
    voice: p.voice,
    input: text,
    instructions: p.instructions,
    response_format: "mp3" as const,
    ...(speedFor(p.targetWpm) !== 1 ? { speed: speedFor(p.targetWpm) } : {}),
  };

  const MAX = 5;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });

    if (res.ok) {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return;
    }

    const detail = await res.text();
    // 429 with `insufficient_quota` is a billing problem, not a rate limit —
    // retrying burns 90 s and still fails. Say so instead.
    if (detail.includes("insufficient_quota")) {
      throw new TtsError(
        "conta OpenAI sem saldo. Recarregue em platform.openai.com/settings/organization/billing " +
          "e confirme com `demovid doctor --deep`.",
        res.status,
      );
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX) {
      throw new TtsError(`TTS falhou (HTTP ${res.status}): ${detail.slice(0, 200)}`, res.status);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 500, 20_000);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/**
 * Synthesise every sentence, reusing whatever is already on disk.
 *
 * The manifest is the file layout itself: a clip's name IS its content hash, so
 * "has this changed?" is a `stat`, and there is no index file to fall out of
 * sync with the directory.
 */
export async function synthesize(texts: string[], opts: SynthOptions): Promise<Clip[]> {
  const sentences = texts.flatMap(splitSentences);
  const clips: Clip[] = [];

  for (const [i, text] of sentences.entries()) {
    const id = clipId(text, opts.profile);
    const path = join(opts.cacheDir, `${id}.mp3`);
    const hit = await stat(path).then((s) => s.size > 0, () => false);

    if (!hit) {
      const raw = join(opts.cacheDir, `${id}.raw.mp3`);
      await synthesizeOne(text, opts.profile, raw);
      if (opts.normalize === false) {
        // Mesmo sem normalizar loudness, o silêncio de borda tem de sair — ele
        // não é gosto, é tempo de tela parada.
        await run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-af", TRIM_FILTER, "-b:a", "192k", path]);
      } else {
        await normalizeLoudness(raw, path);
      }
    }

    clips.push({ id, text, path, durationS: await durationOf(path), cached: hit });
    opts.onProgress?.(i + 1, sentences.length, hit, text);
  }

  return clips;
}
