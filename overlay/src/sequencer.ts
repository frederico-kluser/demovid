/**
 * Narration playback and step advance.
 *
 * This is the heart of the single-pass design. The audio is synthesised BEFORE
 * recording starts and preloaded before its step begins, so `play()` has no
 * latency; the `rec` capture picks it up through the sink monitor; and
 * `onended` is the advance signal. Synchronisation is free because there is only
 * one clock — no timeline, no forced alignment, no drift.
 *
 * Which is exactly why the watchdog is not optional. If advance depends on
 * `onended` and an audio element never ends — decode failure, a sink that went
 * away mid-take, an `AbortError` on autoplay — the demo hangs forever and `rec`
 * fills the disk. Every wait here is bounded, and every timeout is reported
 * rather than swallowed.
 */
export interface ClipRef {
  /** Object URL or data URL. Fetched and decoded before the step runs. */
  src: string;
  /** From ffprobe, in ms. Used to size the watchdog. */
  durationMs: number;
  text: string;
}

export interface SequencerEvent {
  type: "clip-start" | "clip-end" | "timeout" | "error";
  index: number;
  text: string;
  detail?: string;
}

/** Grace on top of the known duration before we call an audio element stuck. */
const WATCHDOG_SLACK_MS = 4000;

export class Sequencer {
  #events: SequencerEvent[] = [];
  #preloaded = new Map<string, HTMLAudioElement>();

  get events(): readonly SequencerEvent[] {
    return this.#events;
  }

  #emit(e: SequencerEvent): void {
    this.#events.push(e);
  }

  /**
   * Decode ahead of time. Called for step N+1 while step N is still playing, so
   * the trigger is instant — the user's explicit requirement, and the reason the
   * audio is pre-rendered at all.
   */
  async preload(clip: ClipRef): Promise<void> {
    if (this.#preloaded.has(clip.src)) return;
    const el = new Audio();
    el.preload = "auto";
    el.src = clip.src;
    this.#preloaded.set(clip.src, el);
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      el.addEventListener("canplaythrough", done, { once: true });
      el.addEventListener("error", done, { once: true }); // play() will report it properly
      const t = setTimeout(done, 5000);
      el.addEventListener("canplaythrough", () => clearTimeout(t), { once: true });
    });
  }

  /**
   * Play one clip and resolve when it ends — or when the watchdog fires.
   *
   * Resolves either way, deliberately. A stuck clip must cost one step, not the
   * whole recording; the event log is what tells the operator it happened.
   */
  async play(clip: ClipRef, index: number): Promise<"ended" | "timeout" | "error"> {
    const el = this.#preloaded.get(clip.src) ?? new Audio(clip.src);
    this.#preloaded.set(clip.src, el);
    this.#emit({ type: "clip-start", index, text: clip.text });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: "ended" | "timeout" | "error", detail?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        el.onended = null;
        el.onerror = null;
        if (r !== "ended") {
          this.#emit({ type: r === "timeout" ? "timeout" : "error", index, text: clip.text, detail });
          // Leave nothing playing into the next step.
          try {
            el.pause();
          } catch {
            /* ignore */
          }
        } else {
          this.#emit({ type: "clip-end", index, text: clip.text });
        }
        resolve(r);
      };

      const budget = Math.max(2000, clip.durationMs) + WATCHDOG_SLACK_MS;
      const timer = setTimeout(() => finish("timeout", `passou de ${budget}ms sem terminar`), budget);

      el.onended = () => finish("ended");
      el.onerror = () => finish("error", el.error ? `code ${el.error.code}` : "erro de mídia");

      el.currentTime = 0;
      el.play().catch((err: unknown) => {
        // Autoplay policy is the likely culprit. The recording browser is
        // launched with a disposable profile so no gesture ever happens — this
        // must be visible, not silent, or the video ships mute.
        finish("error", `play() rejeitado: ${(err as Error).message}`);
      });
    });
  }

  /** Free decoded audio. Long demos would otherwise hold every clip in memory. */
  release(src: string): void {
    const el = this.#preloaded.get(src);
    if (!el) return;
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch {
      /* ignore */
    }
    this.#preloaded.delete(src);
  }

  /** Bounded sleep, so preset gaps cannot become infinite either. */
  static wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, 60_000))));
  }
}
