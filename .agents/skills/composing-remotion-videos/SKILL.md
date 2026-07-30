---
name: composing-remotion-videos
description: Carries the measured constraints of the Remotion project demovid generates — why sizes come from `useVideoConfig()` and never from `vh`, which clock `useCurrentFrame`/`useVideoConfig` report inside a `<Sequence>`, which end of a scene a `<TransitionSeries>` crossfade actually eats, and the render settings whose defaults are wrong for a screen recording. Use whenever you touch `templates/remotion/**`, restyle a component, add a composition or a prop, tune `remotion.config.ts`, upgrade Remotion, or debug a Studio preview that disagrees with the rendered MP4, text at the wrong size, a black frame at the end, or a caption sitting under a crossfade. This template is React that demovid never compiles, so a green typecheck proves nothing about it.
metadata:
  type: task
  verification_signal: npm test
---

# Composing Remotion videos

## When to use

Any change under `templates/remotion/**`, or to `src/remotion/scaffold.ts` and
`src/remotion/studio.ts`, which write and launch it. For how the edit is *decided* —
where cuts land, which scene gets a phrase — that is `authoring-commercial-edits`. This
skill is what the renderer does with the document it is handed.

## Injected knowledge

### The template is a separate compilation universe, on purpose

`templates/` is in neither `tsconfig` (`AGENTS.md:42`). It resolves modules the way a
bundler does — extensionless imports, `moduleResolution: "bundler"`, no `"type":
"module"` — so `npm run typecheck` never looks at it. Three real type errors shipped in
the first version of that template with `npm run verify` green.

Two consequences:

- **`npm run test:remotion` is the only thing that compiles it**, and it sits outside
  `npm run verify` because it installs ~270 MB.
- **A static import of a template file into a demovid test does not work**, and should
  not be forced to. `test/remotion-template.test.ts:24` reaches the template's
  arithmetic through a runtime `import()` built from a variable, so `tsc` stays out of a
  file it would reject with `TS1287` while the test still exercises the real function
  instead of a copy.

### Sizes come from `useVideoConfig().height`. `vh` is banned, and the render hides it

The expensive one, because **the rendered MP4 is correct**.

Measured on Remotion 4.0.501: during a render the browser viewport *is* the composition
— `window.innerHeight` read 720 on a 1280×720 composition — so `vh` renders exactly
right. But the Studio and the `<Player>` draw the composition into a `transform:
scale()`d container inside an ordinary window, so `vh` resolves against the
**window**. On that same composition `20vh` measured **180px** in a 900px-tall Studio
window and **240px** in a 1200px-tall one, against the 144px it renders as; `5vh` type
came out 45px and 60px instead of 36px.

So the preview disagrees with the output, and disagrees *differently* every time the
operator resizes the window — which defeats shipping a Studio at all, because you cannot
size a title against a preview that lies. `templates/remotion/src/components/theme.ts:9`
carries the rule and the measurement; `templates/remotion/src/components/Hook.tsx:45` is
the positive form.

Safe: `%` (resolves against the parent box, which is inside the composition) and `em`
(relative to font-size). Unsafe for the same reason: `vh`, `vw`, `vmin`, `vmax` and
`rem` — the root font-size is not scaled either.

`test/remotion-template.test.ts` fails on a reintroduced viewport unit, and strips
comments before scanning because `theme.ts` explains the ban by quoting the forbidden
token.

### Inside a `<Sequence>`, both hooks are scene-local

Measured, same version, and the second one is not obvious:

- **`useCurrentFrame()` is relative to the sequence** — frame 0 is its own first frame.
- **`useVideoConfig().durationInFrames` is the SEQUENCE's length, not the
  composition's.** A `<Sequence durationInFrames={30}>` inside a 90-frame composition
  reported 30; a `<TransitionSeries.Sequence durationInFrames={54}>` reported 54.

That second fact is what lets `templates/remotion/src/components/Hook.tsx:12` fade the
card out over *its own* last 0.3 s. Had it reported the composition length, the fade
would be scheduled at the end of the video, where the card is no longer mounted — a card
that never fades, with nothing in the code looking wrong.

### A crossfade eats the START of the incoming scene

`<TransitionSeries.Transition>` overlaps its neighbours and the total shortens by its
length. *Which* frames get overlapped is the part that is easy to get backwards.

Measured: in a series of a 45-frame sequence, a 9-frame transition and a 54-frame
sequence, `useCurrentFrame()` inside the second sequence read **24 at absolute frame
60** — so that sequence's frame 0 sits at absolute 36, which is `45 − 9`.

So a scene loses its **first** N frames to the transition it enters on and its **last**
M frames to its successor's, and anything drawn over a scene must dodge both. Those two
numbers live in two different scenes' records: `placeImpact` (`src/remotion/edl.ts:186`)
takes `framesIn` from the scene and `framesOut` from `drafts[i + 1]`. The version before
it subtracted the scene's own *incoming* transition from its tail — the wrong end —
under a comment claiming it did the right thing.

### Only a transition BETWEEN two sequences shortens the timeline

The total is `ΣSequences − Σ(transitions with a sequence on both sides)`. An **edge**
transition — first or last child — is free, because the overlapped frames have to come
out of a predecessor and an edge transition has none.

The widely repeated claim that a `<TransitionSeries>` *cannot* open with a
`<Transition>` is false, and this repository believed it: the docs offer a leading
transition as the way to animate the first scene's entrance. Measured here —
`Transition(15) · Sequence(60) · Transition(20) · Sequence(60)` laid out **100** frames,
which is `60 + 60 − 20`, with the leading 15 costing nothing. Remotion clamps that case
instead of rejecting it. Believing the prohibition cost nothing arithmetically but did
suppress a real capability, and the renderer had a guard it did not need.

So the two questions have two owners and must not be merged:

- **What is drawn** — `templates/remotion/src/Comercial.tsx:74` emits whatever
  `transitionIn` asks for, opening scene included.
- **What is subtracted** — `transitionCostAt` (`templates/remotion/src/edl.ts:85`,
  mirrored at `src/remotion/edl.ts:427` because the template cannot import from demovid)
  returns 0 for an edge transition. `test/remotion-template.test.ts` asserts the two
  copies agree on a real EDL, including the same EDL with `hook: null` — the state that
  flips a scene-0 transition from paid to free.

Subtracting a free transition makes the composition shorter than its content and cuts
the end off the last scene; not subtracting a paid one leaves a black frame.

`calculateMetadata` recomputes from **props**, never from a stored field
(`templates/remotion/src/Root.tsx:26`), or editing a transition in the Studio would
leave the composition the wrong length. What it returns *overrides* the `<Composition>`
JSX props rather than defaulting to them, and it runs inside an implicit `delayRender()`
with a 30 s timeout — so async metadata work is governed by `--timeout` even with no
hand-written `delayRender()`.

Frames are zero-indexed: the last frame is `durationInFrames - 1`. `durationInFrames`
itself stays the correct **exclusive** bound in arithmetic, so a sequence at
`from={a} durationInFrames={d}` occupies `a … a+d−1` and the next one starts at `a+d`.

### Frames are absolute in the source; `trimBefore`/`trimAfter` are the current names

`trimBefore`/`trimAfter` (Remotion 4.0.319+, replacing `startFrom`/`endAt`) are
positions **in the source file**, so every scene reuses one MP4 and no clips are cut on
disk (`templates/remotion/src/components/Scene.tsx:34`). `atFrame` on a narration line
or an impact phrase is the opposite — relative to its own scene, because that is where a
`<Sequence>` puts it. Reading either as the other renders without error and shows the
wrong moment, which is why `test/remotion.e2e.ts` compares two stills from different
scenes.

### `<Video>`/`<Audio>` from `@remotion/media`, and `staticFile()` for every asset

`templates/remotion/src/components/Scene.tsx:3` takes the media components from
`@remotion/media` rather than using `<OffthreadVideo>`: it is the documented default for
new projects, and the docs' own comparison rates its render speed "Fastest" against
"Fast" for `<OffthreadVideo>`. The core `remotion` `<Video>` was renamed `<Html5Video>`
to free the bare name, so an old tutorial's `<Video>` from `"remotion"` is a different
component. Assets go through `staticFile()`
(`templates/remotion/src/components/Scene.tsx:33`) because a bare string resolves against
the bundle, not `public/`.

Two things worth knowing before debugging `@remotion/media`: on unsupported media it
**falls back** — `<Video>` to `<OffthreadVideo>`, `<Audio>` to `<Html5Audio>` — and the
fallback target differs between preview and render, so the decode path is not guaranteed
identical in the two. It logs a warning, which is easy to miss but is not silent. And its
props are version-gated at 4.0.x *patch* granularity, one prop at a time, which is why
`templates/remotion/package.json` pins exact versions rather than a `^4.0.0` range that
would also be satisfied by builds where half of them do not exist.

Sound has one clock by default — the recorded MP4 keeps its narration and the video is
unmuted, so there is nothing to align. `audio: "tracks"` mutes it and plays each line
from its own file, which is what reordering scenes needs, and then the alignment is
yours.

### Two render defaults are wrong for a screen recording

`templates/remotion/remotion.config.ts:32` sets `png`, not the default `jpeg`. Remotion
screenshots every frame and pipes it to ffmpeg, so `jpeg` at quality 80 compresses each
frame *before* h264 compresses it again — and the source is UI text, which is what JPEG
rings around. Measured on 90 frames at 1280×720 with a real `<Video>` in the
composition: jpeg 3852 ms → 261 KB, png 4046 ms → 209 KB. png cost about 5% more wall
clock, inside run-to-run noise, and produced a file **20% smaller**, because clean input
gives the encoder less to encode.

`templates/remotion/remotion.config.ts:43` sets `bt709`. Remotion 4's default is
`"default"`, which equals `bt601`, and since v4.0.83 it converts rather than only
tagging — so the default quietly shifts the colours of an sRGB screen capture. `bt709`
is what Remotion 5 will default to, and Remotion's own `--color-space` documentation
asks for `png` alongside it.

Nothing sets CRF: 18 is already the h264 default. And `remotion.config.ts` is read by
the CLI and the Studio only — a render driven through `renderMedia()` inherits none of
it.

### The render is a pure function of the frame, and the docs enforce it

Animation comes from returning different content for a different `useCurrentFrame()`,
never from anything that runs on its own clock. `setTimeout`, `setInterval`,
`requestAnimationFrame`, CSS animations, transitions and `@keyframes`, `Date.now()` and
`Math.random()` are all explicitly forbidden — a render evaluates frames out of order and
in parallel processes, so a self-running timer produces a different video every time.
For randomness the substitute is `random()` from `remotion` with a static seed.

This is why the components animate with `spring()` and `interpolate()` and why nothing in
the template has a CSS transition. A `transition:` property added to a style here would
preview convincingly in the Studio and render as nothing at all.

### Two typing traps whose errors name something else

- **`Edl` is a `type`, not an `interface`** (`templates/remotion/src/edl.ts:41`).
  `<Composition>` constrains props to `Record<string, unknown>`, and TypeScript gives an
  implicit index signature to a type *alias* of an object type but never to an
  interface. As an interface it fails with "Type `Record<string, unknown>` is missing the
  following properties" and, worse, drops the generic so `calculateMetadata` receives
  `unknown` props.
- **The presentations are a `switch`, not a lookup map** (`templates/remotion/src/Comercial.tsx:35`).
  `TransitionPresentation` is generic over each presentation's own props, so a
  `{ fade, slide, wipe }` map produces a *union* and `<Transition>` cannot infer one
  generic from three; each `case` hands over a single concrete type. The imports are
  static for a related reason — `@remotion/transitions` ships each presentation as its
  own entry point, so a name the EDL invented is an unresolvable import at bundle time
  rather than a value merely missing at runtime. The `default` branch returns `null` so a
  hand-edited EDL degrades to a cut instead of putting `undefined` into the series'
  children.

`linearTiming`, not `springTiming`: a spring-timed crossfade spends part of its budget
easing, so both shots stay half-visible longer than the frame count suggests. demovid
sizes transitions against reserved silence, and a linear ramp is the one whose visible
length equals the number that was budgeted.

## Procedure

1. Change the template.
2. `npm test` — `test/remotion-template.test.ts` catches the two failures that survive a
   green render: a viewport unit, and the duration formula drifting between its two homes.
3. `npm run test:remotion` if anything structural moved. It is the only signal that the
   generated project still typechecks and still renders, and it checks the rendered
   duration against `edlDurationInFrames`.
4. Upgrading Remotion: bump all four pinned versions in
   `templates/remotion/package.json` together, then run step 3. They are pinned because a
   mixed tree fails in the bundler with an error that names none of this.

## References

- `authoring-commercial-edits` — how the EDL's cuts, handles and phrases get decided.
- `templates/remotion/README.md` — the operator-facing version, in Portuguese.
- Remotion is not MIT: a paid company licence is required at four or more people.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Gated by `npm
test`. The bar here is specific, because this template's failures are the ones that
render *fine*: a finding earns a place only when it names something a green render would
still have got wrong, and when a command could have proved it wrong. Every number above
came from a probe project, not from a documentation page.
