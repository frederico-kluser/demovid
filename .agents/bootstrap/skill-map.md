# Phase 2 — Skill map

Proposal only; no skill files are created in this phase. Grounded in
`.agents/bootstrap/project-analysis.md` at commit `d67697a`.

## The granularity test

Routing degrades as a catalog grows — every extra description is another candidate competing for the
same query. So each proposed skill has to earn its slot against one question:

> **Would omitting this skill make an agent either re-scan the codebase, or repeat a mistake the
> project has already paid for?**

If neither, it is not a skill; it is a paragraph in something else. Applied honestly, this rejects the
"one skill per directory" reflex and also rejects a single mega-skill (which would load 8 domains of
context to answer a question about one).

The guidance to start minimal (router + style + 2–3 domains + testing ≈ 6) is real, and this proposal
lands at 8 content skills. The reason is specific rather than a preference: demovid has five
genuinely distinct measured domains whose constraints contradict intuition, and each has a *different
verification signal*. Merging any two would force a skill to declare a signal that cannot validate
half its content — e.g. the camera claims are only provable by `test:e2e`, the `rec` signal claims
only by `test:record`. **The signal boundary is the real seam**, not the directory layout.

## Catalog

| # | Skill | Type | Verification signal | Exists because |
|---|---|---|---|---|
| 1 | `project-router` | router | — (dispatch only) | Exactly one entry point; nothing else routes. |
| 2 | `understanding-demovid-architecture` | knowledge | `npm run typecheck` | Without it, every cross-module task re-scans 6 dirs to rediscover the layer map and the one-pass invariant. |
| 3 | `following-typescript-conventions` | knowledge | `npm run build` | The no-shell rule and the two-tsconfig trap are invisible to `typecheck`; an agent will otherwise reach for `sh -c` and ship a green typecheck with a red build. |
| 4 | `working-with-the-camera-stage` | task | `npm run test:e2e` | The densest paid-for knowledge. Without it an agent transforms `document.body` — which is what the OSS prior art does, and it is broken. |
| 5 | `recording-with-rec` | task | `npm run test:record` | `child.killed` lies, pause is a toggle, SIGKILL truncates. Each has already caused a bug. |
| 6 | `synthesizing-narration` | task | `npm test` | Three measurements that contradict common advice; getting them wrong costs API money and 17 s of dead air per demo. |
| 7 | `authoring-storyboards-and-presets` | task | `npm test` | The two-schema split and the `strict:true` keyword blacklist — a wrong schema is a hard 400 that kills the feature. |
| 8 | `testing-demovid` | task | `npm run verify` | Two harness styles with different rules, and one trap that just bit: an async callback in `check()` kills the process before cleanup. |
| 9 | `running-demo-recordings` | task | `npm run dev -- doctor` | Operating the CLI is a different audience from developing it; ordering (`voice` before `record`) is not inferable. |
| 10 | `meta-skill-evolution` | meta | `node .agents/scripts/skill-verify.mjs --all` | Decides update / propose / discard. Without it, learnings are written by vibes. |
| 11 | `meta-skill-consolidate` | meta | `node .agents/scripts/skill-verify.mjs --all` | Periodic GC: dedupe, staleness by provenance, token budget. Unrestricted growth is measurably harmful. |

`gravando-demos` (the one pre-existing skill) is **replaced by #9**, renamed to a gerund and rewritten
in English so the body matches the rest of the repo. The rename is a deletion + creation, which is
reversible via git.

## Why each signal, specifically

The signal is the part that actually prevents error propagation, so it is chosen per skill rather
than defaulting to "run the tests":

- **`npm run build` for the conventions skill.** Deliberately not `typecheck`. The incident recorded
  at `src/overlay-api.ts:10-14` is precisely a class of error that passes typecheck and fails build.
  A skill about conventions must be gated by the stricter of the two.
- **`npm run test:e2e` for the camera.** Its claims are about layout behaviour in a real engine —
  that a `position:fixed` header survives the scroller swap, that the top layer escapes a transform.
  No unit test can assert those; only a browser can.
- **`npm run test:record` for `rec`.** Its claims are about process signals and container
  finalisation. Only an actual recording proves them.
- **`npm test` for narration and storyboards.** `splitSentences`, `speedFor`, `dwellFor`,
  `applyLocale` and the zod refinements are pure functions already covered by
  `test/storyboard.test.ts`. The parts that need money and network (a real TTS call) are covered by
  *claim* checks against the source instead — see below.
- **`npm run verify` for the testing skill.** It is about the chain, so it is gated by the chain.
- **`npm run dev -- doctor` for the operating skill.** Its claims are environmental (`rec` present,
  X11, a Chromium browser, a sink monitor), and `doctor` is exactly the check for those.

## Claim checks: the part that catches staleness

Every skill also ships an `eval.json` with deterministic assertions against the repo — file exists,
file contains a token, an npm script is defined. These are the regression suite in the memory
pipeline's gating step, and they are what detects a skill quietly describing a codebase that no
longer exists. Example: `working-with-the-camera-stage` asserts
`overlay/src/stage.ts` still contains `scrollbar-width:none`. If a refactor drops it, the skill goes
red before its (now false) advice can be retrieved and followed.

`eval.json` also carries `routing.must_trigger` / `must_not_trigger` queries. Those are scored
deterministically by trigger-word overlap in `skill-verify.mjs`. That is not the model's real
selector — but the failure it catches *is* the real one: two descriptions competing for the same
trigger, which is how a catalog starts misrouting as it grows.

## Composition graph

```
                          project-router  (the only entry point)
                                 │
                 ┌───────────────┼────────────────┐
                 ▼               ▼                ▼
   understanding-demovid-  following-typescript-  running-demo-recordings
      architecture            conventions          (operating; leaf)
        (load first on          (load on any
         cross-module work)       .ts edit)
                 │               │
       ┌─────────┴───────┬───────┴────────┬──────────────┐
       ▼                 ▼                ▼              ▼
 working-with-the-  recording-with-  synthesizing-  authoring-storyboards-
   camera-stage          rec           narration        and-presets
       └─────────────────┴────────────────┴──────────────┘
                                 │
                                 ▼
                          testing-demovid
                     (any change that needs a test)
                                 │
                                 ▼
                        meta-skill-evolution
                   (end of task; may call consolidate)
```

Reading rules:

- **`understanding-demovid-architecture` loads first** on anything touching more than one module. It
  is the map; the others are the territory.
- **`following-typescript-conventions` loads on any `.ts` edit**, in parallel with a domain skill —
  they do not depend on each other.
- The domain skills are **mutually independent** and may load in parallel. (This said "the four"
  while the catalog listed four; the count is now maintained in `catalog.md`, which is generated, so
  it cannot go stale the way a number in prose does.)
- **`testing-demovid` loads after** a domain skill when the change needs a test, because what a test
  may assume depends on which layer changed.
- **`meta-skill-evolution` runs last, always**, and is the only path to a persisted skill update.
- `running-demo-recordings` is a **leaf**: operating the CLI pulls in nothing else.

Two later additions are **pairs across a seam**, where one skill decides something and the other
consumes it. Ordering matters within each pair, and `project-router` step 5 states it:

- `authoring-commercial-edits` (what the cut IS) before `composing-remotion-videos` (what the
  generated project DOES with it). A symptom visible in the Studio but not in the rendered MP4 is
  always the second.
- `scripting-product-demos` (the prose) in parallel with `authoring-storyboards-and-presets` (the
  shape it must return in) — the schema's `required` order is itself a prose-quality mechanism, so
  editing one alone is how the two drift.

## What is deliberately NOT a skill

- **Anything `npm run typecheck` already guarantees** (`.js` import extensions, `import type`, index
  guards). Documented once in the conventions skill as "the typechecker owns this", never restated.
- **Dead configuration** — `preset.camera.minHoldMs`, `cursor.travelFactor`, `cursor.ring`, rung
  `R2`, and the unimplemented `launchpad`/`changelog`/`cinema` presets. Writing these into a skill
  would teach a future agent that they work. They stay in `project-analysis.md §8` for a human to
  wire up or delete.
- **A per-file skill.** `src/browser.ts` folds into `recording-with-rec` (browser launch exists to
  produce a window id for `rec`); `scripts/bake-springs.ts` folds into `synthesizing-narration`
  (both are build-time media prep).
- **Anything already in `AGENTS.md`** in full. `AGENTS.md` is always-on and stays under ~40 lines;
  skills carry the depth. Duplication between them is a conflict waiting to happen — and it already
  happened once, at `AGENTS.md:27`.

## Budget

Target median body ≈ 1,400 tokens, hard cap 5,000 / 500 lines, enforced by
`.agents/scripts/skill-lint.mjs`. The camera skill is expected to be the largest; if it exceeds the
cap, the overflow goes to `references/` rather than being compressed — dropping the scope condition
from a rule is the one compression this system forbids.
