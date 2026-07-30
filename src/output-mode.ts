/**
 * What this run produces, and what that implies about how to record it.
 *
 * This file exists because one boolean was answering four questions. `silent`
 * (`const silent = opts.animate !== undefined`) decided, all at once: whether to
 * pay for TTS, whether the recorder captures system audio, which storyboard field
 * the balloon shows, and — indirectly, through a check in the CLI — which preset
 * to force. For MP4 and GIF those four happen to move together, so the boolean
 * was a faithful description of two modes.
 *
 * `remotion` is the mode where they come apart: it needs narration synthesised
 * (the clips are shipped as editable assets), audio captured (see below), and the
 * balloon **off** — because the text is drawn by React with real typography, and a
 * balloon burnt into the pixels would be a second caption competing with the
 * first. No value of a boolean expresses that.
 *
 * **Why `remotion` still captures audio.** `understanding-demovid-architecture`
 * warns that rendering audio and video separately and muxing later is a different
 * design, not an optimisation — it introduces a second clock. That warning is
 * respected here: the recorded MP4 keeps its narration, so the default Remotion
 * composition cuts a single track and inherits demovid's one clock for free. The
 * per-sentence MP3s go along as *assets*, for an editor who wants to take the
 * timing over deliberately; they are not how the default composition plays sound.
 *
 * The presets are named here rather than in the CLI because "this mode only makes
 * sense with that look" is a property of the mode.
 */

export const OUTPUT_MODES = ["mp4", "gif", "webp", "remotion"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export function isOutputMode(s: string): s is OutputMode {
  return (OUTPUT_MODES as readonly string[]).includes(s);
}

export interface ModeCaps {
  /** Call the TTS API at all. `false` is free, not muted — nothing is paid for. */
  voice: boolean;
  /** Let the recorder pull the default sink monitor into the container. */
  captureAudio: boolean;
  /** Draw the balloon in the page, burning it into the pixels. */
  balloon: boolean;
  /** Which storyboard field carries the message in this mode. */
  text: "say" | "caption";
  /**
   * The look this mode requires. `undefined` means "any preset is fine" — which
   * is why MP4 does not name one: forcing `boardroom` there would override a
   * storyboard that legitimately asked for `helpdesk`.
   */
  requiresPreset?: string;
}

export const MODE_CAPS: Record<OutputMode, ModeCaps> = {
  mp4: { voice: true, captureAudio: true, balloon: true, text: "say" },
  // Silent output pays for nothing it throws away, and the balloon is the entire
  // message — hence `caption`, which is written to stand alone mid-loop.
  gif: { voice: false, captureAudio: false, balloon: true, text: "caption", requiresPreset: "readme" },
  webp: { voice: false, captureAudio: false, balloon: true, text: "caption", requiresPreset: "readme" },
  remotion: { voice: true, captureAudio: true, balloon: false, text: "say", requiresPreset: "comercial" },
};

/** The artefact's file extension. `remotion` delivers the MP4 plus a directory. */
export function extensionFor(mode: OutputMode): string {
  return mode === "remotion" ? "mp4" : mode;
}
