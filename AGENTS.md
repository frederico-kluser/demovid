# AGENTS.md

Single source of truth for agents working in demovid. Kept short on purpose
(long always-on files reduce adherence). Deep, on-demand knowledge lives in the
skills — see below.

demovid turns any frontend project into a narrated demo video: a Playwright-driven
Chromium loads the app, an injected overlay draws speech balloons / a synthetic
cursor / a spotlight, pre-rendered OpenAI TTS plays through the speakers, and the
user's `rec` captures the browser window with system audio. **One pass, no
post-production.**

## Commands
- build: `npm run build` (bundles the overlay, then `tsc`)
- typecheck: `npm run typecheck`
- test: `npm test` — single file: `node --import tsx --test test/<name>.test.ts`
- environment check: `npm run dev -- doctor` (add `--deep` to prove OpenAI has credit)
- lint/format: none configured. The quality gate is `npm run typecheck` + `npm test`.

## Rules (only what differs from language defaults AND is not tooling-guaranteed)

- **No-shell process spawning.** Call external binaries via `run(bin, args[])` in `src/exec.ts` (array args, no shell). Why: untrusted paths can't be injected. Consequence: no pipes/redirects — use tool flags, and do PATH lookup in Node (`which()` in `doctor.ts`), never `sh -c "command -v"`. Scope: every rec/ffmpeg/ffprobe/xdotool call.
- **Own the `rec` child; never `pkill`.** `bin/rec` ends in `exec`, so the spawned PID *is* `gpu-screen-recorder`. Stop with **SIGINT** (SIGKILL truncates the container — no moov atom). Pause is **SIGUSR2 and it is a toggle**, so track the state and reconcile against the `Paused`/`Unpaused` lines on stderr. Why: `pkill -f` would also kill a recording the user started themselves. Scope: `src/rec.ts`.
- **Invoke `rec`, never `gpu-screen-recorder`.** `rec_import_session_env()` scrapes the graphical-session env out of the compositor's `/proc/<pid>/environ`; without it, capture from an agent context dies with `for_each_active_monitor_output_drm failed`. Scope: anything that starts a capture.
- **The camera transforms a `position:fixed` stage, never `document.body`.** Measured 2026-07-29: under a transformed `body`, `position:fixed` behaves like `absolute` — a header scrolls to `y=-800` after scrolling 800px, `bottom:0` resolves against body's *content* height, `height:100%` becomes the full document. The stage must be `position:fixed; width:100%; height:100%; overflow:auto`, mounted with `Element.moveBefore` (atomic — preserves iframes, focus, animations), with `scrollbar-gutter:stable` set **before** mounting and `documentElement.overflow:hidden` after. Scope: `overlay/src/stage.ts`.
- **Never `will-change: transform` on the stage.** It pins the raster scale, so magnified text is blurry *permanently* — not just while moving. Scope: same.
- **Assert the overlay against a baseline captured at identity, not against any viewport metric.** Measured: `innerWidth` reads 1368 because it includes the scrollbar gutter, and `clientWidth` also reads 1368 while a `width:100%` fixed child measures 1353 — neither describes the box the overlay is entitled to. The requirement was never "the overlay equals N pixels"; it is "the overlay did not change when the camera moved". Scope: `assertOverlayUnscaled` in `overlay/src/stage.ts`.
- **`transform-origin` is `0 0` and never changes.** Why: with a fixed origin every camera state is a pure affine matrix, so two states chain smoothly. Moving the origin is why the OSS prior art cannot chain zooms between targets.
- **TTS is one API call per sentence.** Long inputs degrade badly (10–60 s silences, dropped sentences). Cache by content hash so editing one line re-synthesises one line. Scope: `src/openai/tts.ts`.
- **Structured Outputs: hand-written JSON Schema, zod validating after.** `strict:true` rejects `pattern`/`minLength`/`maxItems` with a hard 400. `required` order is load-bearing. Scope: `src/openai/script.ts`.
- **`esbuild` is for the overlay bundle only.** The CLI builds with plain `tsc`. Why: the overlay must be a single IIFE string for `addInitScript`, which `tsc` cannot produce; everything else has no bundling need.
- (Everything else — strict types, `.js` import extensions, `import type` — is enforced by `npm run typecheck`; just run it.)

## Skills
`.agents/skills/gravando-demos/SKILL.md` — how to drive the CLI end to end.

## Security
- Never read or commit `.env` or `~/.secrets`. The shell wrapper loads secrets; code reads `process.env` only.
- The browser always runs with a **disposable** `--user-data-dir`. Never point it at the user's real profile: bookmarks, extensions and their signed-in accounts would end up in the video.
