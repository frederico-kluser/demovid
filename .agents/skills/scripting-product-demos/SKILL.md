---
name: scripting-product-demos
description: The craft of the WORDS in a demovid demo — the two model calls that write prose, why narration is composed for the ear instead of the page, how many words actually fit in a shot of a given length, how many steps a demo should have, and what the opening and closing lines have to accomplish. Use whenever you edit the storyboard or commercial prompt in `src/openai/script.ts` or `src/openai/commercial.ts`, tune a preset's `targetWpm` or step count, write or review a `say`/`caption`/`impact`/hook line, or judge a demo that is accurate but boring, too long, reads like a manual, or narrated at a speed no viewer can follow. This is about prose and pacing, not about JSON Schema mechanics or where the cuts land.
metadata:
  type: task
  verification_signal: npm test
---

# Scripting product demos

## When to use

Any edit to the prose the model is asked to produce: the prompts in
`src/openai/script.ts` and `src/openai/commercial.ts`, a preset's `targetWpm` or
`pacing`, or a review of the words in a finished demo.

Adjacent and not this: the *shape* the prose must come back in is
`authoring-storyboards-and-presets`; *where the cuts land* is
`authoring-commercial-edits`; how the voice is *synthesised* is
`synthesizing-narration`.

## What this skill deliberately does not contain

The industry advice on demo scriptwriting — how many seconds the hook has before
drop-off, retention lift from captions, optimal video length, Mayer's multimedia
principles — was researched across many sources for this skill and **none of it
survived verification**. What came back was marketing-blog statistics with no traceable
primary source, restated between blogs until they read as consensus.

So none of it is written here, and it should not be added later without a citation that
resolves to a primary source with a sample size. `meta-skill-evolution` step 2 is the
rule being followed: importance is not truth, and a plausible number written into memory
gets retrieved and followed on every future demo.

Everything below is either a rule this repository already encodes — where the prompt is
the artefact and the citation is the line — or arithmetic derived from a constant in it.

## Injected knowledge

### Two calls write prose, at different times, with different licence

- **`src/openai/script.ts` writes the storyboard, before anything is recorded.** It is
  creative but bounded: it invents a demo from a *verified* inventory of elements, and
  every `target` must be copied verbatim from that inventory.
- **`src/openai/commercial.ts` writes the edit, after the take exists.** It is not
  creative in the same way: the narration has been measured and `.timeline.json` knows
  how long every scene actually lasted, so it decides against **real durations**.

The asymmetry is the point. A model asked for "an impact phrase" with no duration
writes eight words for a 900 ms shot, and nothing downstream can lengthen the shot.

### `say` is spoken Portuguese, not written Portuguese

`systemFor` in `src/openai/script.ts:52` states it as a hard rule, and the consequences are spelled
out because "write naturally" does not survive contact with a model: short sentences, no
bullet points, no parentheses, no URLs, no markdown. Numbers as words when short
("vinte e quatro"), digits when long.

The reason is mechanical rather than stylistic. This text is going to a TTS engine and
then to a listener with no scrollback. A parenthesis is read aloud as a stumble; a URL
becomes forty syllables; a subordinate clause that a reader would re-scan is simply lost.

### The words-per-second budget is arithmetic, and the model never sees it

`src/presets/comercial.ts:84` sets `targetWpm: 165`. That is **2.75 words per second**,
so:

| shot | words it holds |
|---|---|
| 1 s | ~3 |
| 2 s | ~5 |
| 3 s | ~8 |
| 5 s | ~14 |

This is the number to reach for when a step's narration feels long: it is not a matter
of taste, the sentence does not fit. At the slower presets (`targetWpm` at or below the
`WPM_CEILING` of 140 in `src/openai/tts.ts:62`) the budget is 2.33 words per second, and
the same sentence needs a longer shot.

Above that ceiling the *requested* rate and the *delivered* rate stop being the same
thing — which is `synthesizing-narration`'s subject, and the reason a preset cannot buy
more words per second just by asking for them.

### Length is a rule, not a preference

`systemFor` in `src/openai/script.ts:58`: prefer 5 to 9 steps; fewer than 4 is not a demo, more than 12
is a manual. And one to two sentences per step, because the narration of a step plays
while that step happens — a third sentence is narration playing over a finished action.

Silent output is stricter: 4 to 7 steps, because a GIF is paid for by the frame and
every step is roughly three seconds of file. The prompt says so and also says the honest
thing — a demo that needs nine steps needs a video, and saying that beats delivering a
12 MB GIF.

### The opening has a defined move

`systemFor` in `src/openai/script.ts:61`: start with a `wait` step that introduces the app while the
first sentence plays. Not a click. The viewer needs one beat to understand what they are
looking at, and a demo whose first frame is already mid-interaction spends its first
sentence being confusing.

The hook card is the same job in typography: `src/openai/commercial.ts:88` — say the
benefit, not the name of the screen. One line, 60 characters.

### Voice and text are two channels, and repeating yourself wastes both

`src/openai/commercial.ts:157`. Text carries the number, the benefit or the claim the
voice skipped; it never restates the narration. And most scenes get **no** text at all —
a caption on every shot reads as a slideshow.

`authoring-commercial-edits` carries how that rule interacts with the cut arithmetic.
What belongs here is the writing consequence: an impact phrase is two to five words, and
if it needs more, the scene does not want text.

### A caption for silent output is a different field with a different job

Not "a shorter `say`". `src/openai/script.ts:67` explains it: a narrated line can depend
on the screen moving, because voice and motion arrive together. A caption in a looping
GIF is read **cold, possibly starting from the middle of the loop**, with nothing to fill
in what it left out.

So it has to carry the whole idea alone, and the phrasings that lean on a voice and a
moment — "agora vamos", "veja que", "aqui em cima" — all fail. Name the thing and its
consequence. One sentence, ideally under 90 characters, because the reading budget is
`pacing.cps` against `dwellCapMs` and every held frame is bytes in a format with no
inter-frame compression.

## Procedure

1. Change the prompt.
2. `npm test` — the storyboard and EDL suites cover what is mechanically checkable: the
   zod refinements, the sentence splitting, the pacing arithmetic.
3. A prompt change is only really tested by running it:
   `npm run dev -- script <dir> --about "..." --yes`. Read the storyboard it writes and
   check the two things a test cannot: whether `say` reads aloud without stumbling, and
   whether the step count matches what the demo needs.
4. Judge the result against the budget above before rewriting anything. "The narration
   feels rushed" is usually a sentence that does not fit its shot.

## References

- `src/presets/comercial.ts` — the header explains why this preset's numbers differ.
- `authoring-storyboards-and-presets` — the schema the prose is poured into, including
  why `required` order makes the model commit to mechanics before copy.
- `synthesizing-narration` — the wpm ceiling and what the `speed` parameter does above it.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Gated by
`npm test`, and with one extra bar specific to this skill: **a claim about what makes a
demo good needs a source outside the model, or it does not go in.** This subject attracts
confident, unsourced numbers more than any other in the repository — the first research
pass for it produced none that survived. A rule the repo's own prompts encode is
evidence; a number from a blog post is not.
