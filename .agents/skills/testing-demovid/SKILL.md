---
name: testing-demovid
description: Explains demovid's two very different test harnesses, which command actually proves what, and the async trap that once killed a suite before its cleanup ran. Use whenever you add or change a test, pick a verification command, see a suite report green while something is broken, find an orphaned browser or recorder after a test run, or need to know why `npm test` does not run the end-to-end files. Read this before writing any assertion in test/, because the two harnesses have opposite rules.
metadata:
  type: task
  verification_signal: npm run verify
---

# Testing demovid

## When to use

Any change under `test/`, and any time you are choosing which command to trust as a signal.

## Injected knowledge

### Which command proves what

| Command | Proves | Cannot prove |
|---|---|---|
| `npm run typecheck` | types across `src`, `test`, `scripts`, `overlay/src` | that the build links — see below |
| `npm run build` | the build program resolves, overlay bundles | overlay type errors (esbuild does not typecheck) |
| `npm test` | pure functions: schema, presets, splitters | anything needing a browser |
| `npm run test:e2e` | layout behaviour in a real engine | audio, recording |
| `npm run test:record` | signals, container, audio actually reaching the file | layout details |
| `npm run verify` | all of the above, in order | — |

`npm run verify` (`package.json:41@a394a34`) is the only chain that catches the typecheck/build
divergence, because it runs both.

### `npm test` deliberately excludes the e2e files

It globs `test/*.test.ts` (`package.json:36@a394a34`), and the e2e files are named `.e2e.ts` /
`.e2e.mjs`. That is the mechanism, not an oversight: unit tests must stay runnable with no display,
no browser and no API key. Naming a browser test `*.test.ts` would silently make `npm test` require
a display.

### Two harnesses with opposite rules

**Unit — `test/storyboard.test.ts`.** Real `node:test` + `node:assert/strict`. Pure functions only,
no I/O. Test names are Portuguese sentences, and `assert.throws` matches against the Portuguese
validation messages — so changing a user-facing message breaks a test on purpose.

**End-to-end — `test/stage.e2e.mjs` and `test/record.e2e.ts`.** Not `node:test`. A top-level-await
script with a hand-rolled `check()` that counts failures, prints to stderr, and exits non-zero. They
launch a real Brave; one records ~8 real seconds.

They are not mocked because what they prove only exists in a real engine — that the top layer escapes
an ancestor transform, that a `position:fixed` header survives the scroller swap, that audio reaches
the file. A mock would assert our beliefs back at us.

### The async trap — read this before touching `check()`

`check` must be `async` and take `() => void | Promise<void>`, and **every call site must
`await check(...)`**.

The reason is measured. A `(name, fn: () => void)` signature silently accepts an `async` callback,
and its rejection never reaches the try/catch. The consequence is not a swallowed failure — since
Node 15 an unhandled rejection raises an uncaught exception and **terminates the process before its
`finally` runs**:

```
old harness  → exit 1, no output at all, cleanup never ran
new harness  → exit 0, cleanup ran, failure counted
```

So the damage was an orphaned browser and potentially a `gpu-screen-recorder` still capturing — the
same failure mode `Recording.dispose()` exists to prevent, arriving through a different door. `tsc`
cannot see it, because `() => void` accepts a promise-returning function.

### Assert content, not shape

An audio *track* existing and an audio track carrying *signal* are different claims. The record e2e
measures `mean_volume` and requires it above −50 dB (`test/record.e2e.ts@a394a34`), because a check
for `codec_type=audio` alone passes on absolute silence — which is exactly how a mute video would
ship unnoticed.

Generalise this when adding assertions: prefer the check that would fail on the plausible bad
outcome, not the one that confirms a field exists.

### Cleanup never consults your own state

Every e2e `finally` calls `dispose()` unconditionally. Never `if (recording.running)` — that guard
already left a recorder capturing the desktop once, because the getter it trusted was the thing that
was broken.

### The e2e tests need a real display and a free capture slot

They open windows on X11 and `rec` refuses to start when another capture is live. If `test:record`
cannot run, that is a **missing signal**, not a pass: check `pgrep -f 'gpu-screen-recorder -w'` and
`npm run dev -- doctor` before concluding anything.

## Procedure

1. Add a unit test for anything expressible as a pure function — it is the cheapest signal.
2. Add an e2e assertion only for behaviour that requires a real engine.
3. Run the narrowest command that can fail for your change; run `npm run verify` before claiming done.
4. After any e2e run, confirm nothing was orphaned.

## References

- `.agents/bootstrap/project-analysis.md` §6 — the full test topology.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Gated by `npm run verify`. A
claim about what a test proves must itself be demonstrated by a run, not asserted.
