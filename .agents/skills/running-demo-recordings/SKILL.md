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

`script` and `refine` (having an agent draft and revise the storyboard) are **not implemented**.
Write the YAML by hand; `rehearse` validates it.

## Injected knowledge

### `rehearse` is not optional

It resolves every selector and mounts the camera without recording. When the UI changed and a
selector no longer matches, you find out in seconds instead of three minutes into a take. It also
reports which camera rung it chose and why it demoted, if it did.

### There is no separate `voice` step, and the ordering still matters

Narration is synthesised before the browser opens, inside both `rehearse` and `record`
(`src/record.ts:129-138@a394a34`). Running `rehearse` first therefore warms the cache, so the
subsequent `record` costs no API calls for unchanged text. The CLI still lists a `voice` command; it
currently exits telling you to use `rehearse` (`src/index.ts@a394a34`).

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
| `insufficient_quota` | The OpenAI account has no credit. `demovid doctor --deep` confirms it — the plain check cannot, because `/v1/models` is free and returns 200 at zero balance |

## References

- `README.md` — requirements, and the `gpu-screen-recorder` command to substitute if the `rec`
  wrapper is not installed.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Operating knowledge is
verified by `demovid doctor` plus the run itself having produced a playable file — an unreproduced
troubleshooting guess is not persisted.
