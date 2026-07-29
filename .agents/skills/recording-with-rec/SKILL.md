---
name: recording-with-rec
description: Carries the process and signal semantics of the recorder child, the two backends and how they differ, and the Node API that actively misreports whether the recorder is alive. Use whenever you touch src/recorder/**, src/record.ts or src/browser.ts, start or stop a recording, add pause behaviour, debug a truncated MP4, a recorder left capturing after the process exits, a browser that closes mid-run, or a window id that resolves to the wrong window. Assume the obvious implementation is wrong here — each rule below replaced one that looked correct.
metadata:
  type: task
  verification_signal: npm run test:record
---

# Recording

## When to use

Any edit under `src/recorder/`, or to `src/record.ts` / `src/browser.ts`; any recording that produced
no file, a truncated file, an orphaned process, or the wrong pixels.

## Injected knowledge

### demovid spawns the encoder itself, so the child it holds IS the recorder

There used to be a bash wrapper living outside the repository. Reading it end to end established that
only three of its 277 lines were load-bearing here; those moved into `src/recorder/`, and the menus,
fzf pickers, microphone tracks and container selection were never reachable from demovid anyway.

Consequences, all still true and all still easy to get wrong:

- No `pgrep`, no `pkill`, no PID file. Signal the child directly. `pkill -f` would also kill a
  recording the user started themselves — which matters because the user records their own screen
  with the same tool.
- **Stop is SIGINT**, because it finalises the container. SIGKILL leaves a file with no moov atom,
  which most players refuse entirely. Stopping is a staged escalation, never an immediate kill
  (`src/recorder/index.ts:215@72303c9`).
- **Pause is SIGUSR2 and it is a toggle**, not set/clear. The backend prints `Paused`/`Unpaused` on
  stderr; local state is tracked and reconciled against those lines
  (`src/recorder/index.ts:186@72303c9`). A toggle you cannot query is one you will desynchronise.

### `child.killed` lies — do not use it for liveness

Node sets `killed = true` after any *successful signal delivery*, not after the child dies. Since
pause is SIGUSR2, the first pause made `killed` true and every later call believed the recording was
dead. Caught by the recording e2e: `Paused` was on stderr while `setPaused(false)` threw "recording is
not running".

The correct predicate is `exitCode === null && signalCode === null`
(`src/recorder/index.ts:164@72303c9`).

### Cleanup must not consult your own bookkeeping

`async dispose()` is unconditional, idempotent, never throws, and deliberately does **not** check
`running` (`src/recorder/index.ts:266@72303c9`). An early e2e guarded cleanup with
`if (recording.running)`; the lying getter above then left a `gpu-screen-recorder` capturing the
desktop after the test process exited.

### The two backends are NOT interchangeable, and say so

`gpu-screen-recorder` encodes on the GPU, can pause, follows a window that moves, and can write the
wall-clock timestamp of the first frame. The ffmpeg fallback can do none of those.
`recording.capabilities` exists so callers branch explicitly rather than discovering it in the output
(`src/recorder/backend-ffmpeg.ts:118@72303c9`), and `setPaused` throws `RecCapabilityError` there
instead of pretending.

Two things measured while building the fallback:

- **x11grab does take `-window_id`** and derives the geometry itself
  (`src/recorder/backend-ffmpeg.ts:135@72303c9`), so the common case is not a fixed region.
- **libx264 refuses odd dimensions.** A real browser window at 1920x1163 fails with `height not
  divisible by 2` and leaves no moov atom. The even-crop at
  `src/recorder/backend-ffmpeg.ts:184@72303c9` is mandatory, not defensive.

`default_output` is a gsr alias, not a PulseAudio source. The real name is `<default sink>.monitor`
and it has to be asked for. `-ac flac` stays banned: it is disabled in gsr 5.13.9.

### Capture the window. Never a screen region.

Region capture reads the framebuffer, so it records whatever is stacked above the browser — a test
take came out containing the operator's chat client and their private conversations. Raising the
window first does not fix it: any window can take the foreground mid-recording. Window capture reads
the window's own buffer and is structurally immune (`src/record.ts:332@72303c9`).

Safety property, not a quality one. Removing the browser's own UI costs an ffmpeg pass, and that is
the cheaper half of the trade.

### `importSessionEnv()` runs once, in the CLI, before anything reads `DISPLAY`

It finds the compositor (`src/recorder/session-env.ts:109@72303c9`), reads its `/proc/<pid>/environ`,
and copies an allowlist of eight variables — only when they are unset. Without it, capture from an
agent or cron context dies with `for_each_active_monitor_output_drm failed`, a message that names
none of the four things actually missing.

Two details the obvious implementation gets wrong:

- Field 22 of `/proc/<pid>/stat` is parsed **after the last `)`**
  (`src/recorder/session-env.ts:61@72303c9`) — field 2 is the executable name in parentheses and may
  itself contain parentheses, which mis-indexes every field after it.
- The **browser** needs `DISPLAY` too, not only the recorder. Calling this from inside the recorder
  would leave the browser blind.

### The real pointer is not Playwright's

`page.mouse` dispatches CDP events and never moves the X11 pointer, so it stays wherever the operator
left it. Over the tab strip, Chromium draws a hover card with the page title and a mute button, right
into the take. `parkPointer` moves it out, and the encoder is told not to draw it at all, because
demovid draws its own cursor.

## References

- `src/recorder/types.ts` — the backend contract and the capability flags.
- `test/recorder.test.ts` — argument construction and the `/proc` readers.
- `test/record.e2e.ts` — the real capture; `DEMOVID_RECORDER=ffmpeg` exercises the fallback.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Update this file only when
`npm run test:record` is green against the change — a signal-free claim about process semantics is
exactly the kind of write this system exists to refuse.
