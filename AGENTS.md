# AGENTS.md

Single source of truth for agents working in demovid. Kept short on purpose
(long always-on files reduce adherence). Deep, on-demand knowledge lives in the
skills — see below.

demovid turns any frontend project into a narrated demo video. Run it inside the
project: it scans the app, asks in Portuguese what to demonstrate, has `gpt-5.4`
write the storyboard from the app's *verified* elements, rehearses it, and then
records. A Playwright-driven Chromium loads the app, an injected overlay draws
speech balloons / a synthetic cursor / a spotlight, pre-rendered OpenAI TTS plays
through the speakers, and `gpu-screen-recorder` (or an ffmpeg fallback) captures
the browser window with system audio. Out comes an MP4 **and** a
`.timeline.json` with every line's timing and scored cut points.

## Commands
- build: `npm run build` (bundles the overlay, then `tsc`)
- typecheck: `npm run typecheck`
- test: `npm test` — single file: `node --import tsx --test test/<name>.test.ts`
- everything: `npm run verify` (typecheck → springs → build → unit → 2 browser e2e)
- the generated Remotion project: `npm run test:remotion` — outside `verify` because it installs ~270 MB
- environment check: `npm run dev -- doctor` (add `--deep` to prove OpenAI has credit)
- the guided flow: `npm run dev -- script <dir> --about "..." --yes`
- lint/format: none configured. The quality gate is `npm run typecheck` + `npm test`.

## Rules (only what differs from language defaults AND is not tooling-guaranteed)

- **No-shell process spawning.** Call external binaries via `run(bin, args[])` in `src/exec.ts` (array args, no shell). Why: untrusted paths can't be injected. Consequence: no pipes/redirects — use tool flags, and do PATH lookup in Node (`which()` in `doctor.ts`), never `sh -c "command -v"`. Scope: every rec/ffmpeg/ffprobe/xdotool call.
- **Own the recorder child; never `pkill`.** demovid spawns the encoder directly, so the PID it holds *is* the recorder. Stop with **SIGINT** (SIGKILL truncates the container — no moov atom). Pause is **SIGUSR2 and it is a toggle**, so track the state and reconcile against the `Paused`/`Unpaused` lines on stderr. `running` is `exitCode === null && signalCode === null`, never `!child.killed` — Node sets `killed` after any successful signal and SIGUSR2 made it lie. Why: `pkill -f` would also kill a recording the user started themselves. Scope: `src/recorder/`.
- **`importSessionEnv()` runs once, in `src/index.ts`, before anything reads `DISPLAY`.** It scrapes the graphical-session env out of the compositor's `/proc/<pid>/environ`; without it, capture from an agent context dies with `for_each_active_monitor_output_drm failed` — and the *browser* needs it too, not only the recorder. Scope: `src/recorder/session-env.ts`.
- **Capture the window, never a screen region.** Region capture reads the framebuffer, so it records whatever is stacked above the browser: a test take came out containing the operator's chat client and their private conversations. Raising the window first does not fix it — any window can take the foreground mid-recording. Window capture reads the window's own buffer and is structurally immune. Safety property, not a quality one. Scope: `src/record.ts`.
- **The overlay animates with `motion/mini`, and every tween settles.** Mini cancels a superseded animation without firing `onfinish`, so its `finished` promise never resolves — and the Node driver awaits `cursorTo` through `page.evaluate`, so one interrupted travel would hang until Playwright's timeout. `springTo` returns its own deferred, resolved on finish, on retarget, or by a watchdog. Never import `motion` (61.8 KB, main-thread rAF) instead of `motion/mini` (11.2 KB); `build-overlay.ts` fails the build over 34 KB. Scope: `overlay/src/anim.ts`.
- **A selector never reaches the model unverified.** `inventory.ts` publishes a selector only after `querySelectorAll(sel).length === 1` in the live page, so an unaddressable element simply never becomes a target. Also: the crawl navigates with `goto` and **never clicks** — a crawler that clicks will eventually submit a form or delete a row in the operator's dev database. Scope: `src/project/inventory.ts`.
- **`page.evaluate` needs the `__name` shim under tsx.** esbuild's `keepNames` compiles every named function to `__name(fn, "fn")`; the serialised source carries the reference into the page while the helper stays behind, and it fails with `ReferenceError: __name is not defined` — which reads exactly like "this app has no elements". Scope: `installNameShim` in `src/project/inventory.ts`.
- **The camera transforms a `position:fixed` stage, never `document.body`.** Measured 2026-07-29: under a transformed `body`, `position:fixed` behaves like `absolute` — a header scrolls to `y=-800` after scrolling 800px, `bottom:0` resolves against body's *content* height, `height:100%` becomes the full document. The stage must be `position:fixed; width:100%; height:100%; overflow:auto`, mounted with `Element.moveBefore` (atomic — preserves iframes, focus, animations), with `scrollbar-gutter:stable` set **before** mounting and `documentElement.overflow:hidden` after. Scope: `overlay/src/stage.ts`.
- **Never `will-change: transform` on the stage.** It pins the raster scale, so magnified text is blurry *permanently* — not just while moving. Scope: same.
- **Assert the overlay against a baseline captured at identity, not against any viewport metric.** Measured: `innerWidth` reads 1368 because it includes the scrollbar gutter, and `clientWidth` also reads 1368 while a `width:100%` fixed child measures 1353 — neither describes the box the overlay is entitled to. The requirement was never "the overlay equals N pixels"; it is "the overlay did not change when the camera moved". Scope: `assertOverlayUnscaled` in `overlay/src/stage.ts`.
- **`transform-origin` is `0 0` and never changes.** Why: with a fixed origin every camera state is a pure affine matrix, so two states chain smoothly. Moving the origin is why the OSS prior art cannot chain zooms between targets.
- **TTS is one API call per sentence.** Long inputs degrade badly (10–60 s silences, dropped sentences). Cache by content hash so editing one line re-synthesises one line. Scope: `src/openai/tts.ts`.
- **The TTS model is a pinned snapshot, never the `gpt-4o-mini-tts` alias.** The alias retargeted under this code once already — `gpt-4o-mini-tts-2025-03-20` was shut down 2026-07-23 — and `TTS_MODEL` is part of the cache key, so a silent retarget serves audio from weights that no longer exist. Voices: `marin`/`cedar` are the two the docs call best; the other eleven are `tts-1`-era. Scope: `src/openai/tts.ts`.
- **The output mode is a capability record, not a boolean.** `MODE_CAPS` in `src/output-mode.ts` answers four independent questions (pay for TTS · capture audio · burn the balloon · `say` vs `caption`). `remotion` needs voice ON, balloon OFF — no boolean expresses that. It still captures audio **on purpose**: the recorded MP4 keeps its narration, so the default composition cuts one track and inherits the one-clock invariant. Setting that to `false` is the second clock the architecture refuses.
- **`templates/` is in neither `tsconfig`, so `npm run test:remotion` is the only thing that COMPILES it.** It is React that demovid never compiles. Three real type errors shipped in the first version of that template with `npm run verify` green; the e2e installs the generated project and runs `tsc` inside it. Two defects survive a green render and so are caught statically inside `npm test` instead (`test/remotion-template.test.ts`): a viewport unit, which renders correctly and only mis-sizes the Studio preview, and the duration formula drifting between its two copies. Scope: `templates/remotion/**`.
- **In the EDL, a transition is paid for by the handles.** `buildEdl` trims dead air only where `timeline.cuts[]` endorses the boundary (that is where the navigation/failed-step penalties already live), and reserves `HANDLE_MS` of silence on each side. A transition overlaps both neighbours, so one longer than the handle fades out a word still being spoken — `transitionFrames` clamps it and degrades to a hard cut instead. Scope: `src/remotion/edl.ts`.
- **Structured Outputs: hand-written JSON Schema, zod validating after.** `strict:true` rejects `pattern`/`minLength`/`maxItems` with a hard 400. `required` order is load-bearing (action/target before say, so the model commits to what it does before writing what to say about it). Scope: `src/storyboard.ts`.
- **`esbuild` is for the overlay bundle only.** The CLI builds with plain `tsc`. Why: the overlay must be a single IIFE string for `addInitScript`, which `tsc` cannot produce; everything else has no bundling need.
- (Everything else — strict types, `.js` import extensions, `import type` — is enforced by `npm run typecheck`; just run it.)

## Skills
Every task goes through `.agents/skills/project-router` — it asks clarifying questions in Portuguese,
writes a disposable `TASK_PLAN.md`, selects the skill chain, and runs the evolution step at the end.
Catalog: `.agents/skills/catalog.md`. `.claude/skills` is a symlink to `.agents/skills`.

Skills are memory, so writes to them are gated: `node .agents/scripts/skill-verify.mjs <skill>` must
be green before a `SKILL.md` can be edited (a PreToolUse hook enforces it). Rationale and the full
pipeline: `.agents/skills/meta-skill-evolution`.

## Security
- Hooks in `.claude/settings.json` block, deterministically: reads of credential files, a handful of
  unrecoverable shell commands, and any `SKILL.md` write without a fresh validation token. They are
  block-only and never mutate anything — see `.agents/hooks/README.md`.
- Never read or commit `.env` or `~/.secrets`. The shell wrapper loads secrets; code reads `process.env` only.
- The browser always runs with a **disposable** `--user-data-dir`. Never point it at the user's real profile: bookmarks, extensions and their signed-in accounts would end up in the video.
