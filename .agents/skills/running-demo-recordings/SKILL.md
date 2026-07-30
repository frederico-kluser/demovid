---
name: running-demo-recordings
description: Drives the demovid CLI end to end to produce a narrated demo video of a frontend project, from environment check through storyboard to MP4. Use whenever the request is to record, produce or regenerate a demo video, a walkthrough, a release clip or a screen demonstration of a web app — including "grave um demo do app X" — and whenever a demo video must be re-recorded after the UI changed. This is about operating the tool, not developing it; for changes to demovid's own code, use the domain skills instead.
metadata:
  type: task
  verification_signal: npm run dev -- doctor
---

# Running a demo recording

## When to use

The user wants a video of an app, not a change to demovid itself.

## Procedure

```bash
demovid doctor                       # 1. can this machine record at all?
demovid rehearse examples/demo.yaml  # 2. validate selectors + camera, record nothing
demovid record   examples/demo.yaml  # 3. → MP4
```

Or the guided flow, which does all three and writes the storyboard for you — run it *inside* the
target project (`src/scriptflow.ts@b4f9175`, dispatched at `src/index.ts:387@b4f9175`):

```bash
cd ~/the-app && demovid                       # interactive: it asks, in Portuguese
demovid script ~/the-app --about "..." --yes  # non-interactive
```

There is no `refine` **command**: revision happens at the guided flow's approval gate, where typing
what to change (instead of Enter) re-drafts and re-rehearses. There is no `voice` command either.

### Silent output: `--format gif` / `--format webp`

A different product, not the MP4 muted (`src/gif.ts@b4f9175`):

```bash
demovid record demo.yaml --format gif             # → demo.gif, ≤ 5 MB, zero TTS calls
demovid record demo.yaml --format webp --max-mb 2
```

- **No `OPENAI_API_KEY` is needed to record one** — synthesis is skipped, not muted, so a
  hand-written storyboard renders with no API access at all. *Writing* a storyboard needs
  `DEEPSEEK_API_KEY`, not the OpenAI one: since 2026-07-30 the two keys have separate jobs and
  neither substitutes for the other — DeepSeek writes the prose, OpenAI synthesises the narration.
  So `--format gif|webp` from a hand-written storyboard needs no key at all, and the same format
  from the guided flow needs only DeepSeek.
- The balloon is the only channel, so it reads the step's `caption` (falling back to `say`), and the
  `readme` preset is applied unless `--preset` says otherwise.
- Over budget, frames are dropped 15→12→10→8→6→5 fps. If 5 fps still misses, you get the file plus a
  warning — shorten the script or switch to `webp`, which measured ~10× smaller on the same clip.
- No audio is captured at all in this mode, so nothing the machine happens to be playing can leak in.

## Injected knowledge

### `rehearse` is not optional

It resolves every selector and mounts the camera without recording. When the UI changed and a
selector no longer matches, you find out in seconds instead of three minutes into a take. It also
reports which camera rung it chose and why it demoted, if it did.

### Narration is synthesised before the browser opens, so the ordering matters

Inside both `rehearse` and `record` (`src/record.ts:183-199@b4f9175`). Running `rehearse` first
therefore warms the cache, so the subsequent `record` costs no API calls for unchanged text — which is
what makes the guided flow's iterate-then-approve loop affordable. With `--format gif|webp` the whole
block is skipped instead, so there is no cache to warm and nothing to pay twice.

### The cache is keyed on everything that changes the audio

Model, voice, instructions, speed and the sentence text (`src/openai/tts.ts:88-93@a394a34`). Edit one
line of narration and one clip is re-synthesised. Change the preset's voice and all of them are.

### Do not touch audio output during a take

The captured audio is the default sink's monitor. Changing the output device or muting mid-recording
silently removes the narration from the video, and there is no way to recover it without re-recording.

### One capture at a time

`rec` refuses to start when another capture is live. If `doctor` reports one running, stop it with
`recstop` first.

### The browser opens with a disposable profile

If the demo needs a login, put the login **in the storyboard** with test credentials. Do not point
demovid at a real profile: bookmarks, extensions and signed-in accounts would appear in the video.

### Presets are look and pace; camera is safety

`--preset boardroom` (an evaluation committee, restrained) or `helpdesk` (a confused user — slower,
heavier dim, larger text). `--camera` only to force a rung; `auto` decides during the rehearsal.

### Storyboard paths are relative to the YAML

`url: ./app.html` resolves against the file's own directory, not the working directory
(`src/index.ts@a394a34`), so a storyboard is portable between machines.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Video is silent | Output device changed mid-take, or the sink monitor is not the captured source — check `demovid doctor` |
| Balloon on the wrong element | A selector matched something else; run `rehearse` and read which node it resolved |
| `rec` refuses to start | A capture is already running → `recstop` |
| Everything ran without zoom | The rehearsal demoted the camera to `R3`; the reason is in its output |
| `insufficient_quota` | An account has no credit. Read the message for *which*: "a chave da OpenAI" is the narration, "a chave da DeepSeek" is the storyboard. `demovid doctor --deep` confirms the OpenAI side — the plain check cannot, because `/v1/models` is free and returns 200 at zero balance. There is no deep check for DeepSeek, so a DeepSeek balance of zero passes `doctor` and fails at the first storyboard |

## References

- `README.md` — requirements, and the `gpu-screen-recorder` command to substitute if the `rec`
  wrapper is not installed.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Operating knowledge is
verified by `demovid doctor` plus the run itself having produced a playable file — an unreproduced
troubleshooting guess is not persisted.
