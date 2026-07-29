---
name: recording-with-rec
description: Carries the process and signal semantics of the `rec` recorder child and the Brave launch that feeds it, including a Node API that actively misreports whether the recorder is alive. Use whenever you touch src/rec.ts or src/browser.ts, start or stop a recording, add pause behaviour, debug a truncated MP4, a recorder left capturing after the process exits, a browser that closes mid-run, or a window id that resolves to the wrong window. Assume the obvious implementation is wrong here — each rule below replaced one that looked correct.
metadata:
  type: task
  verification_signal: npm run test:record
---

# Recording with `rec`

## When to use

Any edit to `src/rec.ts` or `src/browser.ts`; any recording that produced no file, a truncated file,
or an orphaned process.

## Injected knowledge

### `rec` is a wrapper that `exec`s, so the child you spawn IS the recorder

`bin/rec` ends with `exec gpu-screen-recorder …` (`src/rec.ts:4-16@a394a34`). Three consequences:

- No `pgrep`, no `pkill`, no PID file. Signal the child directly. `pkill -f` would also kill a
  recording the user started themselves — the reason this matters is that the user records their own
  screen with the same tool.
- **Stop is SIGINT**, because it finalises the container. SIGKILL leaves a truncated file with no
  moov atom, which most players refuse entirely.
- **Pause is SIGUSR2 and it is a toggle**, not set/clear. The backend prints `Paused`/`Unpaused` on
  stderr; local state is tracked and reconciled against those lines
  (`src/rec.ts:118-120@a394a34`). A toggle you cannot query is one you will eventually desynchronise.

Always invoke `rec`, never `gpu-screen-recorder` directly: `rec_import_session_env()` scrapes the
graphical-session environment out of the compositor's `/proc/<pid>/environ`, and without it capture
from an agent context dies with `for_each_active_monitor_output_drm failed`.

### `child.killed` lies — do not use it for liveness

Node sets `killed = true` after any *successful signal delivery*, not after the child dies. Since
pause is SIGUSR2, the first pause made `killed` true and every later call believed the recording was
dead. Caught by the recording e2e: `Paused` was on stderr while `setPaused(false)` threw "recording is
not running".

The correct predicate is `exitCode === null && signalCode === null`
(`src/rec.ts:136-151@a394a34`).

### Cleanup must not consult your own bookkeeping

`dispose()` is unconditional, idempotent, never throws, and deliberately does **not** check `running`
(`src/rec.ts:201-226@a394a34`). An early e2e guarded cleanup with `if (recording.running)`; the lying
getter above then left a `gpu-screen-recorder` capturing the desktop after the test process exited.

The general form: cleanup that trusts our own state fails exactly when that state is what broke. Use
`dispose()` in every `finally`; use `stop()` only on the success path, where the returned file matters.

`stop()` un-pauses first (a paused encoder has no reason to flush promptly), SIGINTs, waits 15 s,
then SIGKILLs and throws (`src/rec.ts:172-199@a394a34`).

### Startup is detected by surviving a grace window

`rec` refuses to start when another capture is already live, and that failure is immediate — so a
1200 ms window distinguishes "running" from "died on launch" without polling anything
(`src/rec.ts:229-234@a394a34`). `detached: false` so the recorder dies with demovid; `-y` always, so
the interactive menu never opens.

### The browser exists to produce a window id

`src/browser.ts` launches Brave with a **disposable** `--user-data-dir`. Never the real profile: the
user's bookmarks, extensions and signed-in accounts would be in the video, and Chromium locks a
profile to one process, so it would also require closing the browser they are using.

- The window id is found by **diffing the X11 window set** before and after launch
  (`src/browser.ts:61-69@a394a34`), never `xdotool search --name`. Matching on the title would mean
  either depending on the target app's title or rewriting `document.title` — and that rewrite is
  visible in the recorded tab strip.
- `addInitScript` goes on the **context**, not the page (`src/browser.ts:142-144@a394a34`): an init
  script added to a page applies only to that page's later navigations, and `setContent` is not a
  full navigation.
- `reducedMotion: 'no-preference'` is mandatory, or WAAPI flattens every camera move.
- `--no-sandbox` avoids a V8 fatal that kills the whole Node process uncatchably.

### Log noise is filtered on purpose

`BENIGN_REC_NOISE` (`src/record.ts:33-46@a394a34`) suppresses two lines that look alarming and are
not. The ffmpeg one is measured: gsr warns that ffmpeg < 8 may stutter in MP4, but a 50 s capture on
this machine gave a 16.66 ms median frame interval against an ideal 16.67, σ = 0.67 ms, one 31 ms
hiccup in 3000 frames. A log that cries wolf on every run trains the operator to ignore the run that
actually failed.

## Procedure

1. Change `src/rec.ts` or `src/browser.ts`.
2. `npm run test:record` — it records ~8 s for real, exercises pause/resume, and checks the container
   has both streams *and that the audio track carries signal*, not merely that a track exists.
3. Afterwards, confirm nothing was orphaned: `pgrep -f 'gpu-screen-recorder -w'` must be empty.

## References

- `.agents/bootstrap/project-analysis.md` §4 — every `run()` call site and the one deliberate bypass.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Claims here are gated by
`npm run test:record`, which needs a display and a free capture slot; if it cannot run, that is a
missing signal and the write is discarded rather than assumed.
