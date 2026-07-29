# demovid

Turns any frontend project into a narrated demo video. One pass, no post-production.

A Playwright-driven Chromium loads your app and an injected overlay draws speech balloons, a
synthetic cursor and a spotlight. Narration is pre-rendered with OpenAI TTS and played through the
speakers; a screen recorder captures the browser window with system audio. Because the audio plays
live and `audio.onended` drives step advance, there is **no timeline to synchronise** — no forced
alignment, no word timestamps, no drift.

```bash
cd ~/my-app
npx demovid                # scan → ask what to demo → gpt-5.4 writes it → rehearse → record
```

It reads your `package.json`, starts (or adopts) your dev server, crawls the app
for elements it can actually address, asks in Portuguese what you want to show,
has `gpt-5.4` write the storyboard, rehearses it so broken selectors surface
before anything is recorded, and only then records. You get `demo.mp4` and
`demo.timeline.json`.

The hand-written path still works, and the guided flow just writes the same file:

```bash
demovid doctor                      # does this machine have what it needs?
demovid rehearse demo.yaml          # validate selectors and camera, record nothing
demovid record   demo.yaml --res reels   # → demo.mp4 + demo.timeline.json
```

```yaml
# examples/demo.yaml
title: Painel de Exames
url: ./app.html          # relative to the YAML
locale: pt-BR
preset: boardroom

steps:
  - action: focus
    target: "#kpi-pendentes"
    say: Aqui em cima ficam os indicadores do dia.
  - action: type
    target: "#busca"
    value: "REQ-88413"
    say: A busca aceita o protocolo ou o nome do paciente.
```

---

## Status

Working: the guided flow, `doctor`, `rehearse`, `record`, `restore`. Presets `boardroom` and
`helpdesk`, locale `pt-BR`. Resolutions from `720p` to `reels` (9:16 vertical), plus any of
Playwright's 207 device names.

## Requirements

- **Linux/X11.** Window capture is native there. Wayland falls back to the desktop portal and is
  untested.
- **Node ≥ 20**, a **Chromium-family browser** (Brave, Chrome, Chromium — Firefox will not work, no
  CDP), **ffmpeg**, **xdotool**, and an **`OPENAI_API_KEY`**.
- **A screen recorder — optional.** demovid prefers
  [`gpu-screen-recorder`](https://git.dec05eba.com/gpu-screen-recorder/about/) and drives it
  directly; there is no wrapper script to install. Without it, it falls back to ffmpeg (`x11grab` +
  the PulseAudio monitor, with NVENC or VAAPI when available). The fallback cannot pause and cannot
  follow a window that moves, and it says so rather than pretending otherwise.

Run `demovid doctor` — it names the backend it picked and why.

## What comes out

Two files. The MP4, and a `.timeline.json` that demovid can produce and a screen recorder cannot,
because demovid *caused* everything in the frame:

```jsonc
{ "clock": { "method": "first-frame-ts", "residualMs": 17 },
  "narration": [{ "text": "Aqui em cima ficam os indicadores…",
                  "startMs": 15341, "endMs": 18805, "measured": true }],
  "events":    [{ "t": "camera-move", "startMs": 14980, "endMs": 15430 }],
  "cuts":      [{ "atMs": 33174, "score": 0.75, "kind": "entre-passos",
                  "reasons": ["silêncio de 4375ms (+0.35)", "câmera parada (+0.25)",
                              "fronteira de passo (+0.15)"] }] }
```

`clock.method` says which anchor was trusted and `residualMs` is the honest error bar on every
timestamp in the file. Cut scores carry their derivation, because a score you cannot explain is a
score you cannot tune.

Run `demovid doctor` — it checks every one of these and tells you which is missing. Add `--deep` to
spend one minimal API call proving the OpenAI key has **credit**, not just that it is valid:
`/v1/models` is free and returns 200 on an account with zero balance.

## How it works

```
┌─ recorder ── captures the browser window + system audio ─────────┐
│ ┌─ Chromium (disposable profile, headed) ──────────────────────┐ │
│ │  document.documentElement                                    │ │
│ │   ├── <div id=__demovid_stage>  ← THE STAGE, position:fixed  │ │
│ │   │     translate3d(…) scale(k) · transform-origin 0 0        │ │
│ │   │     (the whole app was moved in here)                    │ │
│ │   └── <div popover=manual>      ← THE OVERLAY, top layer     │ │
│ │         + shadow root. Balloon · cursor · mask · audio       │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**The overlay never scales.** Top-layer elements escape ancestor transforms — CSS Position L4 §3:
they "generate boxes as if they were siblings of the root element… Ancestor elements with `overflow`,
`opacity`, `mask`, etc. cannot affect it." But the balloon still *follows* the zoom for free, because
`getBoundingClientRect()` on an element inside the stage already returns the transformed rect.

## Things this project measured, so you do not have to

Most of these contradict what the surrounding literature says. Every one is reproducible from the
tests in `test/`.

**Transforming `document.body` does not work.** It is what the existing open-source tools in this
space do, and it is broken: under a transformed `body`, `position: fixed` behaves like `absolute`. A
header scrolls to `y=-800` after scrolling 800px, `bottom: 0` resolves against the *content* height
(y=4004 instead of 669), and `height: 100%` becomes the whole document. `body` is viewport-**width**
but content-**height** — only half of "coincident with the viewport" is true. The stage has to be a
`position: fixed` element instead.

**`scrollbar-width: none` on the stage is structural, not cosmetic.** The moment *any* transform is
set — even `scale(1)` — a `position: fixed; left:0; right:0` header switches containing block from
the viewport to the stage's padding box, and a visible scrollbar makes that box 15px narrower. The
header silently goes 1353 → 1338px.

**`transform: scale()` does not blur text.** Captured the real window mid-zoom at k=1.4/2/3 and
magnified 200% with nearest-neighbour: clean glyph edges in both a WAAPI and a rAF-driven camera.
What *does* blur permanently is `will-change: transform` — it pins the raster scale. Never use it here.

**OpenAI TTS narrates imperatives correctly.** A widely-repeated claim says `gpt-4o-mini-tts` *answers*
commands instead of reading them, which would be fatal for demo scripts. Transcribing the output and
comparing to the input gives 100% fidelity, with and without `instructions`.

**`instructions` controls pace up to ~140 wpm, then saturates.** Asking for 130 delivered 129; asking
for 170 still delivered 140. Above that the only working lever is `speed`, which *is* reliable here
and linear (1.15→1.19×, 1.30→1.32×, 1.50→1.58×).

**Trim edge silence — with one clip per sentence it is worth ~840 ms each.** Measured on a single long
clip it looks like 80 ms and not worth doing. That is the wrong measurement for this architecture:
short clips carry proportionally huge padding, about 17 s of dead air across a 20-sentence script —
and since `onended` drives advance, that is 17 s of frozen screen. Trimming took a clip from 101 wpm
to 140 wpm, and makes the gap between steps a preset knob instead of an accident.

## Development

```bash
npm install
npm run verify   # typecheck + bake springs + build + unit tests + 2 browser e2e (one records)
```

The e2e tests open a real browser and one of them records ~8 s of real video. They are not mocked
because the things worth proving — that the top layer escapes a transform, that a `position: fixed`
header survives the scroller swap, that audio actually reaches the file — only exist in a real
engine.

## Prior art

This space got crowded in 2026. Read these before assuming demovid is the right tool for you:
[`playwright-recast`](https://github.com/ThePatriczek/playwright-recast),
[`argo`](https://github.com/shreyaskarnik/argo),
[`shot-scraper video`](https://shot-scraper.datasette.io/en/stable/video.html),
[`Cap`](https://github.com/CapSoftware/Cap).

demovid's difference is the single pass: OS-level capture at 60 fps with GPU encoding, and live audio
playback instead of a post-production timeline.

Ideas and constants borrowed with thanks — see [NOTICE](./NOTICE).

## License

Apache-2.0. See [LICENSE](./LICENSE).
