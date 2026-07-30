---
name: understanding-demovid-architecture
description: Explains demovid's layer map, the one-pass invariant, and which module owns what, so a task never has to re-scan the repository to orient itself. Use whenever a change touches more than one module, whenever you are deciding where new code belongs, whenever a symptom crosses layers (audio missing from the video, camera not moving, recorder left running), and whenever you would otherwise start by reading several directories. Load this first on any non-trivial task, even if the user does not mention skills.
metadata:
  type: knowledge
  verification_signal: npm run typecheck
---

# demovid architecture

## When to use

Any task spanning more than one module; any "where does this belong" question; any symptom whose
cause could be in a different layer than where it shows up. Load before the domain skills, not after.

## Injected knowledge

### The one-pass invariant

demovid produces a finished MP4 in a single pass — there is no post-production timeline. Everything
downstream follows from this and it is the first thing to check a proposal against.

Narration is synthesised to files **before** the browser opens, played through the speakers during
the take, and captured back through the sink monitor. Step advance is driven by `audio.onended`
(`src/record.ts:4-12@a394a34`). There is therefore **one clock**, which is why the project needs no
forced alignment, no word timestamps, and no drift correction.

A proposal that introduces a second clock — rendering audio and video separately and muxing later —
is not an optimisation of this design, it is a different design. Say so rather than half-adopting it.

### Layer map

```
CLI (src/index.ts)  →  record()  (src/record.ts, the conductor)
                          │
        ┌─────────────────┼──────────────────┬─────────────────┐
        ▼                 ▼                  ▼                 ▼
  openai/tts.ts      browser.ts           rec.ts         presets/ + storyboard.ts
  (narration,       (Brave, disposable   (the recorder    (what to do, and how it
   cached by hash)   profile, injects     child process)   should look and feel)
                     the overlay)
                          │
                          ▼
                   overlay/src/**  — runs INSIDE the page
                   stage · spotlight · cursor · balloon · sequencer
```

- `src/record.ts` is the only module that knows the order of operations. Nothing else orchestrates.
- `overlay/src/**` never imports from `src/**` except the shared contract, and it is bundled by
  esbuild, not `tsc` (`scripts/build-overlay.ts:13@a394a34`).
- `src/overlay-api.ts` is the driver↔overlay contract and lives under `src/` **on purpose**: a
  `declare global` in the overlay tree is invisible to `tsconfig.build.json`
  (`src/overlay-api.ts:10-14@a394a34`). Moving it back would produce a green typecheck and a red build.

### Ownership, so you edit in one place

| Concern | Owner | Do not duplicate in |
|---|---|---|
| Order of operations | `src/record.ts` | anywhere |
| External binaries | `run()` in `src/exec.ts:68@a394a34` | any module |
| Recorder process + signals | `src/recorder/**` (`src/rec.ts` is a re-export facade) | `src/record.ts` |
| Which resolution fits the screen | `src/resolution.ts` | `src/record.ts` |
| Reading X11 (monitors, work area, geometry) | `src/x11.ts` | anywhere |
| Timing of everything, for the sidecar | `src/timeline.ts` | `src/record.ts` (it only marks) |
| Discovering the app's addressable elements | `src/project/inventory.ts` | the model's prompt |
| Project detection (git, pkg.json, workspaces, framework, config port, routes) | `src/project/scan.ts` | `src/scriptflow.ts` (it only consumes) |
| Asking an agent what the files do not say (how to run, auth, what to demo) | `src/project/discover.ts` | `src/project/scan.ts` — it stays deterministic |
| The `.demovid.json` cache and its fingerprint | `src/project/config.ts` | anywhere |
| The guided flow's order | `src/scriptflow.ts` | `src/index.ts` (it only parses flags) |
| Camera transform | `overlay/src/stage.ts` | `src/record.ts` (it only sets state) |
| Look and pace | `src/presets/**` | the overlay (it receives style, never defines it) |
| What the demo does | the user's `demo.yaml` | presets — they never carry `scenes` (`src/presets/types.ts:12-13@a394a34`) |

### Two axes that are deliberately orthogonal

The **preset** is look and pace: how much help does the viewer need. The **camera rung** is safety:
how aggressively may we touch the app (`src/presets/types.ts:1-13@a394a34`). They are independent —
a cautious camera with an energetic look is a valid combination, and conflating them would force a
user who wants a safer camera to also accept a different visual style.

Only `R1` and `R3` are ever produced (`src/record.ts:65@a394a34`). `R0` — transforming
`document.body` — was measured broken and removed; see `working-with-the-camera-stage`.

### Where a symptom usually lives

| Symptom | Look here first | Why |
|---|---|---|
| Video has no audio | `src/record.ts` clip serving, then the sink | Route interception on `https://demovid.invalid` (`src/record.ts:30@a394a34`); an audio *track* can exist and be silent |
| Camera does not move | `mount()` returned `stage:false` → rung `R3` | Degrades on purpose rather than failing (`src/record.ts:186-193@a394a34`) |
| Balloon in the wrong place | `overlay/src/balloon.ts`, not the storyboard | Placement is computed from a live rect |
| Recorder still running after a crash | `Recording.dispose()` | Cleanup must never consult `running` (`src/recorder/index.ts:266@72303c9`) |
| Green typecheck, red build | the two tsconfigs | See `following-typescript-conventions` |

## References

- `.agents/bootstrap/project-analysis.md` — the full map with the tooling/prose split.
- `AGENTS.md` — the always-on rules. Skills carry depth; `AGENTS.md` stays short.
