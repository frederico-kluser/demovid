---
name: synthesizing-narration
description: Carries demovid's measured findings about OpenAI TTS narration — per-sentence call granularity, the words-per-minute ceiling and why the speed parameter is the only lever above it, and why edge silence must be trimmed — plus the content-hash audio cache and the baked spring easing curves. Use whenever you touch src/openai/tts.ts or scripts/bake-springs.ts, change a voice, instructions or speaking speed, regenerate the baked spring easings, or debug dead air, a sentence split in the wrong place, narration at the wrong speed, or a clip that was paid for twice. Several findings here contradict widely repeated advice, so check this file before trusting a general recommendation about TTS.
metadata:
  type: task
  verification_signal: npm test
---

# Synthesizing narration

## When to use

Any edit to `src/openai/tts.ts` or `scripts/bake-springs.ts`; any pacing, voice or dead-air problem.

## Injected knowledge

### The model is a pinned snapshot, and the alias has already betrayed this file

`TTS_MODEL = "gpt-4o-mini-tts-2025-12-15"` (`src/openai/tts.ts:47`), never the bare
`gpt-4o-mini-tts` alias. `gpt-4o-mini-tts-2025-03-20` was **shut down on 2026-07-23** and the alias
moved; since `TTS_MODEL` is part of the cache key, a silent retarget serves audio from weights that no
longer exist. `/v1/audio/speech` accepts exactly four ids — `tts-1`, `tts-1-hd`, the alias, and the
dated snapshot — so there is no newer TTS family to reach for.

Voices are not a flat list. `ballad verse marin cedar` exist only on `gpt-4o-mini-tts`, and of those
the docs single out **`marin` and `cedar`** for best quality; the other nine are `tts-1`-era and sound
like it. Picking one of the nine on a 2025-12 snapshot is a downgrade the API will not warn about.

### Three measurements — taken against the RETIRED March snapshot

Recorded at `src/openai/tts.ts:14-32`. The *shape* of each finding is architectural and still holds;
the **numbers are not re-verified on `2025-12-15`**, and `WPM_CEILING` is the one most likely to have
moved. Treat them as calibrated on weights that no longer exist: re-measure before quoting a figure
back at someone, and delete `.demovid-cache/` first or you will grade yesterday's audio.

**One API call per sentence, not per scene.** Long inputs degrade badly: 10–60 s of silence and
dropped sentences. Sentence granularity is also what makes the cache useful — editing one line
re-synthesises one line.

**`instructions` controls pace up to ~140 wpm and then saturates.** Asking for 130 delivered 129;
asking for 170 still delivered 140. Above the ceiling the only working lever is `speed`, which *is*
reliable on this model and linear (1.15→1.19×, 1.30→1.32×, 1.50→1.58×) — contradicting the common
advice that `speed` is unreliable. `WPM_CEILING = 140` at `src/openai/tts.ts:33@a394a34`;
`speedFor()` returns 1 below the ceiling and `targetWpm/140` above it.

The split matters: below the ceiling `instructions` produces a genuinely differently-paced
*performance*, while `speed` only time-stretches one. Reach for `instructions` first.

**Edge silence must be trimmed, and the first measurement said otherwise.** Measured on one long
clip it looks like 44–108 ms and not worth doing. That is the wrong measurement for this
architecture: with one clip per sentence, padding averages **840 ms**, about 17 s of dead air across
a 20-sentence script — and since `audio.onended` drives step advance, that is 17 s of frozen screen.
Trimming took a clip from 101 wpm to 140 wpm.

The transferable lesson is about method, not audio: calibrate in the condition the architecture
actually runs in, not in a convenient one.

### The trim, and why the filter looks odd

`TRIM_FILTER` (`src/openai/tts.ts:139-151@a394a34`) uses an `areverse` sandwich because
`silenceremove` only trims the head — trim, reverse, trim, reverse back. `-45 dB` sits above the
synthesiser's noise floor and below anything voiced.

Trimming to near-zero is deliberate: the gap between steps then belongs to the preset
(`pacing.gapMs`) rather than to whatever padding the model happened to emit. It runs **even when
`normalize === false`**, because silence is dead screen time, not an aesthetic preference.

Loudness is two-pass `loudnorm` to −14 LUFS / −1 dBTP. One-pass pumps on speech, and YouTube's
normalisation is asymmetric — too loud gets turned down, too quiet stays quiet forever.

### The cache is the filename

`clipId` is a sha256 of `[TTS_MODEL, voice, instructions, speedFor(targetWpm), normalize, spokenText]`,
first 16 hex chars (`src/openai/tts.ts:146`). There is no index file: **the filename IS the content
hash**, so "has this changed?" is a `stat`. Nothing can fall out of sync with the directory.

Anything that changes the audio must be in that key. Adding a synthesis parameter without adding it
there produces stale audio that looks cached and is wrong — `normalize` was exactly that bug: flipping
the flag reused the previous flag's file out of a cache that looked like a hit.

The text in the key is `toSpeakable(text)`, not what the human wrote. `src/openai/speakable.ts` turns
notation into words — `R$`, `%`, `º`, a date's slashes, a time's colon, a decimal comma — and leaves
bare integers alone on purpose, because the synthesiser reads `1234` correctly while a rule that
rewrote every digit run would also mangle `CEP 01310-100` and `v4.0.501`. `Clip` keeps both strings:
`text` for captions and the timeline, `spoken` for the API and the hash.

### Sentence splitting needs the abbreviation guard

Measured failure: `"O Dr. Silva assina"` split into `"O Dr."` + `"Silva assina"` — an audible pause
in the middle of a name, because the next token is legitimately capitalised
(`src/openai/tts.ts:95-105@a394a34`). The `ABBREV` list glues the fragment back. Decimals survive via
the uppercase-opener lookahead.

A wrong split is worse than a long clip, so the splitter is conservative by design. When you add a
Portuguese abbreviation, add a case to `test/storyboard.test.ts` in the same change.

### `insufficient_quota` is never retried

It is a billing state, not a rate limit — retrying burns 90 s and still fails
(`src/openai/tts.ts:215-222@a394a34`). Rate limits and 5xx do retry, honouring `Retry-After`.

### Springs are baked at build time

`scripts/bake-springs.ts` runs Motion's `spring().toString()` in Node and emits CSS `linear()`
strings, so the injected overlay ships **zero animation JS**
(`scripts/bake-springs.ts:1-20@a394a34`). Two things to know before editing it:

- `spring()` requires `keyframes: [0, 1]` alongside the physical constants; without it the generator
  has nothing to simulate and throws reading `keyframes[0]` (`scripts/bake-springs.ts:78-85@a394a34`).
- The output carries **two** durations. `durationMs` is Motion's simulation to its rest threshold;
  `perceivedMs = 4/(ζ·ω₀)` is when the eye reads it as stopped, and is much smaller (850 vs 450 for
  the default camera spring). Use `durationMs` for the CSS transition and `perceivedMs` for pacing —
  `src/record.ts:294@a394a34` and `:298` use exactly that split.

`src/generated/springs.ts` is generated; regenerate with `npm run bake:springs` rather than editing it.

## Procedure

1. Change `src/openai/tts.ts` or `scripts/bake-springs.ts`.
2. `npm test` — `splitSentences` and `speedFor` are unit-covered.
3. If synthesis parameters changed, delete `.demovid-cache/` before comparing, or you will grade
   yesterday's audio.
4. A real listen is still required for anything touching voice or accent: `requireHumanListen` is
   true for pt-BR (`src/presets/locale/pt-BR.ts:28`) because nothing measured proves `instructions`
   locks the accent. It is no longer decorative — `src/index.ts:403` prints the reminder at the end of
   a narrated run, so the flag now has a reader and flipping it changes output.

## References

- `README.md` — the same findings, written for someone outside the project.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. A TTS claim that needs a paid
API call to verify is not gated by `npm test`; either add a unit-testable consequence or record it as
unverified rather than persisting it as fact.
