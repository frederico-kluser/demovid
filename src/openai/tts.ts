/**
 * Narration synthesis.
 *
 * Raw `fetch`, no SDK — the dominant convention across the user's projects.
 *
 * **The model is a pinned snapshot, not the alias.** The alias moved under this
 * file once already: `gpt-4o-mini-tts-2025-03-20` was shut down on 2026-07-23,
 * and `/v1/audio/speech` now accepts only `tts-1`, `tts-1-hd`, the alias, and
 * `gpt-4o-mini-tts-2025-12-15` — which OpenAI describes as "a significant jump
 * in accuracy, with substantially lower word error rates". Pinning is what makes
 * the three measurements below attributable to a specific set of weights; on the
 * alias they describe whatever the alias pointed at the day they were taken.
 *
 * Three things here are measurements, not preferences — but they were taken
 * against the **retired** March snapshot (2026-07-29, 26-word realistic
 * sentences). They are kept because the *shape* of each finding is architectural,
 * and marked because the numbers are not re-verified on 2025-12-15:
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
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "../exec.js";
import { toSpeakable } from "./speakable.js";
import { AUDIO_MODEL, synthesizeWithAudioModel } from "./tts-audio.js";

const ENDPOINT = "https://api.openai.com/v1/audio/speech";

/**
 * Pinned snapshot. Never the bare `gpt-4o-mini-tts` alias: it retargets without
 * notice, and `TTS_MODEL` is part of {@link clipId}, so a silent retarget would serve
 * cached audio from weights that no longer exist.
 */
export const TTS_MODEL = "gpt-4o-mini-tts-2025-12-15";

/**
 * Ask the API for lossless and encode once, ourselves.
 *
 * Everything the synthesiser returns goes through ffmpeg anyway — the trim, and
 * usually two-pass `loudnorm`. Requesting `mp3` meant decoding a lossy file and
 * re-encoding it to `mp3` 192k: two lossy generations where the pipeline only
 * needs one. `wav` costs bandwidth and disk on a file that is deleted seconds
 * later.
 */
const RAW_FORMAT = "wav";

/** Above this, `instructions` stops being obeyed and `speed` takes over. */
export const WPM_CEILING = 140;

/**
 * The 13 built-in voices.
 *
 * Not a flat list in practice: `alloy ash coral echo fable nova onyx sage shimmer`
 * are the nine that `tts-1`/`tts-1-hd` also serve, and `ballad verse marin cedar`
 * exist only on `gpt-4o-mini-tts`. Of those, the docs single out **`marin` and
 * `cedar`** as the ones to use "for best quality" — which is why the presets ship
 * those two and not the older nine. Picking from the tts-1 era on a 2025-12
 * snapshot is a downgrade the API will not warn about.
 */
export type Voice = "alloy" | "ash" | "ballad" | "cedar" | "coral" | "echo" | "fable" | "marin" | "nova" | "onyx" | "sage" | "shimmer" | "verse";

/** Recognises a voice id at a CLI/YAML boundary, where the value is untyped. */
export const VOICES = [
  "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable",
  "marin", "nova", "onyx", "sage", "shimmer", "verse",
] as const satisfies readonly Voice[];

export function isVoice(v: string): v is Voice {
  return (VOICES as readonly string[]).includes(v);
}

export interface VoiceProfile {
  voice: Voice;
  /** Steers accent, tone and pacing. Ignored by `tts-1`/`tts-1-hd`. */
  instructions: string;
  /** Words per minute the preset wants. */
  targetWpm: number;
}

/**
 * Which synthesiser produces the audio.
 *
 * `speech` is `/v1/audio/speech`: a reader, cheap, deterministic, verbatim by
 * construction. `audio-1.5` is `gpt-audio-1.5` through Chat Completions — a far more
 * directed performance, ~two orders of magnitude more expensive, and generative, so
 * every clip's verbatim-ness is verified against the transcript. See
 * `src/openai/tts-audio.ts`.
 */
export type VoiceEngine = "speech" | "audio-1.5";

export const VOICE_ENGINES = ["speech", "audio-1.5"] as const satisfies readonly VoiceEngine[];

export function isVoiceEngine(v: string): v is VoiceEngine {
  return (VOICE_ENGINES as readonly string[]).includes(v);
}

export interface SynthOptions {
  /** Directory for the .mp3 files and the manifest. */
  cacheDir: string;
  profile: VoiceProfile;
  /** Normalise loudness with ffmpeg after synthesis. */
  normalize?: boolean;
  /** Defaults to `speech`. */
  engine?: VoiceEngine;
  /** Surfaced when the experimental engine falls back. */
  onWarn?: (line: string) => void;
  onProgress?: (done: number, total: number, cached: boolean, text: string) => void;
}

export interface Clip {
  /** Stable id — the content hash. Also the filename. */
  id: string;
  /** What the human wrote. Captions and the timeline want this one. */
  text: string;
  /** What the synthesiser was handed — `toSpeakable(text)`. Hashed, not displayed. */
  spoken: string;
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
  // The API rejects anything outside 0.25–4.0. Clamping here rather than letting
  // a 600-wpm preset earn a 400 keeps the failure at the knob, not at the wire.
  const raw = Math.round((targetWpm / WPM_CEILING) * 100) / 100;
  return Math.min(4, raw);
}

/**
 * The cache key. Every input that changes the audio goes in, so a changed voice
 * or a reworded instruction invalidates cleanly — and nothing else does.
 *
 * `normalize` is in the key because it changes the *file*, not just the request:
 * without it, flipping the flag served the previous flag's audio out of a cache
 * that looked like a hit.
 */
function clipId(text: string, p: VoiceProfile, normalize: boolean, engine: VoiceEngine): string {
  return createHash("sha256")
    .update(JSON.stringify([engine, TTS_MODEL, p.voice, p.instructions, speedFor(p.targetWpm), normalize, text.trim()]))
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

/** Exponential backoff, capped. Shared by the HTTP ladder and the network ladder. */
const backoffMs = (attempt: number): number => Math.min(2 ** attempt * 500, 20_000);

async function synthesizeOne(text: string, p: VoiceProfile, dest: string): Promise<void> {
  const key = process.env["OPENAI_API_KEY"];
  if (!key) throw new TtsError("OPENAI_API_KEY ausente");

  const body = {
    model: TTS_MODEL,
    voice: p.voice,
    input: text,
    instructions: p.instructions,
    response_format: RAW_FORMAT,
    ...(speedFor(p.targetWpm) !== 1 ? { speed: speedFor(p.targetWpm) } : {}),
  };

  const MAX = 5;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      // A timeout or a dropped socket is precisely the transient failure the
      // ladder below exists for, and it used to be the one thing that escaped it:
      // `AbortSignal.timeout` rejects, not resolves, so it left the loop and took
      // the whole run down over one slow sentence.
      if (attempt === MAX) {
        throw new TtsError(`a TTS não respondeu depois de ${MAX} tentativas: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      continue;
    }

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
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
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
/**
 * One sentence to its final file, or a confirmation that the cache already holds
 * it.
 *
 * Split out of the loop because everything in here is addressed by the content
 * hash: two concurrent calls for two different sentences cannot collide on a
 * path, which is what makes the loop safe to widen.
 */
async function renderOne(text: string, opts: SynthOptions): Promise<Clip> {
  const normalize = opts.normalize !== false;
  const engine = opts.engine ?? "speech";
  const spoken = toSpeakable(text);
  const id = clipId(spoken, opts.profile, normalize, engine);
  const path = join(opts.cacheDir, `${id}.mp3`);
  const hit = await stat(path).then(
    (s) => s.size > 0,
    () => false,
  );

  if (!hit) {
    const raw = join(opts.cacheDir, `${id}.raw.${RAW_FORMAT}`);
    try {
      // The experimental engine is tried first and never trusted. A paraphrase, a
      // refusal or a missing audio part all land here, and the run continues on the
      // endpoint that cannot paraphrase — a slightly less expressive take beats one
      // that says something the script does not.
      if (engine === "audio-1.5") {
        try {
          const r = await synthesizeWithAudioModel(spoken, opts.profile, raw);
          opts.onWarn?.(`${AUDIO_MODEL}: concordância ${(r.agreement * 100).toFixed(0)}% — "${text.slice(0, 48)}"`);
        } catch (err) {
          opts.onWarn?.(`${AUDIO_MODEL} falhou nesta frase, caindo para a TTS: ${(err as Error).message}`);
          await synthesizeOne(spoken, opts.profile, raw);
        }
      } else {
        await synthesizeOne(spoken, opts.profile, raw);
      }
      if (normalize) {
        await normalizeLoudness(raw, path);
      } else {
        // Mesmo sem normalizar loudness, o silêncio de borda tem de sair — ele
        // não é gosto, é tempo de tela parada.
        await run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-af", TRIM_FILTER, "-b:a", "192k", path]);
      }
    } finally {
      // The raw file is an input to ffmpeg and has no other reader. It used to
      // survive every run, so `.demovid-cache/` carried two files per sentence
      // forever — and the second one was the bigger of the two.
      await rm(raw, { force: true }).catch(() => {});
    }
  }

  return { id, text, spoken, path, durationS: await durationOf(path), cached: hit };
}

/**
 * Sentences in flight at once.
 *
 * Four rather than "all of them": every miss costs an HTTP round trip *plus* two
 * ffmpeg passes, so the ceiling is local CPU, not the API. Unbounded fan-out on a
 * 30-sentence script would start 30 ffmpeg processes and lose to the serial
 * version.
 */
const CONCURRENCY = 4;

export async function synthesize(texts: string[], opts: SynthOptions): Promise<Clip[]> {
  const sentences = texts.flatMap(splitSentences);
  const out: Clip[] = new Array(sentences.length);

  let next = 0;
  let done = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      // Stop *scheduling* on the first failure. `Promise.all` rejects immediately
      // but does not cancel its siblings, and every sentence still queued is a
      // paid API call for a run that is already lost.
      if (failed) return;
      const i = next++;
      const text = sentences[i];
      if (text === undefined) return;
      try {
        const clip = await renderOne(text, opts);
        out[i] = clip;
        // Counts completions, not positions: with four in flight, reporting `i`
        // would make the progress line jump around and go backwards.
        opts.onProgress?.(++done, sentences.length, clip.cached, text);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sentences.length) }, worker));
  return out;
}
