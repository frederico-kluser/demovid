---
name: authoring-commercial-edits
description: Carries how demovid turns a finished take into a commercial edit — the model call that writes the hook, transitions and impact phrases against MEASURED scene durations, and the rules that translate `.timeline.json` into the frame-accurate EDL a Remotion composition renders. Use whenever you touch src/openai/commercial.ts or src/remotion/edl.ts, change how scenes are cut or how dead air is trimmed, add a transition kind, tune the impact-phrase prompt, or debug a cut that clips a word, a caption on the wrong shot, or a composition whose length disagrees with its content. The cut decisions come from two different arrays for two different reasons, and mixing them up is the only real bug available here.
metadata:
  type: task
  verification_signal: npm test
---

# Commercial edits

## When to use

Any change to `src/openai/commercial.ts` or `src/remotion/edl.ts`; any complaint about *where* a cut
lands, *how long* a scene is, or *what text* appears over it. For the rendering side — the generated
project, `TransitionSeries`, fonts — that is `composing-remotion-videos`.

## Injected knowledge

### The edit is written AFTER the take, against real durations

The storyboard call is creative: it invents a demo from an inventory. This call is not. By the time
`writeCommercial` runs (`src/openai/commercial.ts:196`) the recorder has finished, the narration has
been measured, and `.timeline.json` knows how long every scene actually lasted — so the measured
length of each scene goes into the prompt.

That is not decoration. A model asked for "an impact phrase" with no duration cheerfully writes eight
words for a 900 ms shot, and nothing downstream can shorten a shot to fit words.

### Two arrays, two questions. This is the seam

`buildEdl` (`src/remotion/edl.ts:210`) reads two different parts of the sidecar and they are not
interchangeable:

- **`cuts[]` decides WHETHER a boundary may be trimmed** (`src/remotion/edl.ts:182`). `scoreCuts`
  already knows a navigation nearby is worth −0.40 and a failed step −0.30, and only emits points at
  0.5 or above. So a boundary with **no** cut point inside its silence is a boundary demovid has
  already judged unsafe — and this module leaves it alone rather than re-deriving the same heuristic
  worse. Measured on a real take: two of four boundaries were trimmed, and the two that were not are
  exactly the two `scoreCuts` declined to endorse.
- **`narration[]` decides WHERE.** The spans are observed `play()`→`onended` round trips, so the
  silence between two of them is real silence, not an estimate. The cut lands inside it.

Reversing these — using `cuts[].atMs` as the cut position, or scanning for silence yourself — throws
away the penalties and re-introduces cuts next to navigations.

### Handles are what pay for a transition

`<TransitionSeries.Transition>` overlaps its neighbours: the last N frames of the outgoing scene play
under the first N of the incoming one. Those frames must therefore be frames nobody needs to hear.
`HANDLE_MS = 320` (`src/remotion/edl.ts:58`) reserves them on each side of a trimmed boundary, and it
is sized *for the transition*, not for taste — 320 ms is 9.6 frames at 30 fps, so the longest
transition emitted (`MAX_TRANSITION_FRAMES = 9`, `src/remotion/edl.ts:64`) still overlaps only silence.

Consequences that look arbitrary and are not:

- **An untrimmed boundary gets no transition, ever** (`src/remotion/edl.ts:146`). No trim means no
  handle, so any overlap eats a word. It degrades to a hard cut instead of shortening the handle.
- **Below three frames a transition is not emitted.** It is indistinguishable from a cut and still
  costs the arithmetic.
- **A scene under `TINY_SCENE_MS` gets neither transition nor text** (`src/remotion/edl.ts:266`).
  There is no room for either.

### Frames: absolute in the source, relative in the scene

`trimBefore` / `trimAfter` are positions **in the source video**; `atFrame` on a narration line or an
impact phrase is relative to **its own scene**, because that is where a `<Sequence>` puts it. Both are
named after the Remotion prop they feed so the renderer never converts. Getting this backwards renders
without error and shows the wrong moment.

The EDL runs at 30 fps while the capture is 60: the capture rate is a property of the recorder and the
timeline is a property of the edit. Every ms→frame conversion therefore quantises, and a test that
demands millisecond precision from a frame grid is a test that will fail for the wrong reason.

### The model never sees a frame number

It places the impact phrase at `impactAtPercent`, a fraction of the scene
(`src/openai/commercial.ts:40`), and `buildEdl` converts. One owner for the frame arithmetic, and the
model cannot emit a frame outside the scene it belongs to.

`required` order is load-bearing the same way the storyboard's is: `transition` and `impactAtPercent`
come **before** `impact` (`src/openai/commercial.ts:104`), so the model commits to where the cut lands
and when the text appears before it writes the text. Reversed, it writes agreeable copy and bends the
mechanics to fit.

### Text and voice are two channels, and most scenes get neither

The prompt's strongest rule is that an impact phrase **never repeats the narration**
(`src/openai/commercial.ts:161`): the voice and the text are two channels, and saying the same thing
twice wastes both. Text carries the number or the claim the voice skipped.

And **most scenes get no text at all**. A caption on every shot reads as a slideshow. Same for
transitions: `corte` is the documented default, because a transition on every scene looks like a
screensaver and each one costs real frames from both neighbours. Observed on the first real run: the
model chose `corte` for all five scenes and two impact phrases across the whole piece — that is the
prompt working, not the prompt failing.

### `strict:true` emits nulls; zod must accept `undefined`

`stripNulls` removes the nulls that Structured Outputs is *forced* to emit for an optional field, so
what reaches zod is `undefined`. Declaring `.nullable()` alone rejected **every** scene the model
correctly left without text — three of three on the first real call. Optional fields here are
`.nullish()`. Pinned by a test in `test/edl.test.ts`.

### Everything after the MP4 degrades instead of throwing

By the time this runs the take is on disk and the narration is paid for. So a 429 on the edit call, a
missing `npm`, a Studio that will not start — each becomes a warning on a report that still names a
video (`src/remotion/index.ts:80`). An EDL with no `commercial` is still renderable: hard cuts, no
text. Losing a finished recording because the *caption writer* failed is the worst available trade.

## Procedure

1. Change `src/openai/commercial.ts` or `src/remotion/edl.ts`.
2. `npm test` — `test/edl.test.ts` covers the boundary rules, the handle/transition coupling, the
   frame arithmetic and the `stripNulls`→zod contract as pure functions.
3. If the EDL shape changed, `npm run test:remotion` — it is the only thing that proves the generated
   project still renders it.
4. A transition the model never chooses is a transition never rendered. The e2e hand-writes a
   commercial that exercises all three presentations for exactly that reason.

## References

- `src/timeline.ts` — `scoreCuts` and what each penalty means.
- `composing-remotion-videos` — the other half: what the renderer does with this document.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Gated by `npm test`: a claim
about cut placement that no unit test can fail is a hypothesis, not a finding — the boundary rules are
cheap to assert, so assert them instead of writing them here.
