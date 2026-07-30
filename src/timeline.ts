/**
 * The timeline sidecar: every spoken line and every on-screen event, in
 * milliseconds relative to the video's own t=0, plus scored suggestions for
 * where the video can be cut.
 *
 * demovid can produce this and a screen recorder cannot, because demovid is
 * what *caused* everything in the frame. It does not infer that a click
 * happened at 12.480s; it knows, because it issued the click.
 *
 * ## The one hard problem: which clock
 *
 * Timestamps are born on the orchestrator's clock. The video's t=0 is whenever
 * the encoder produced its first frame, which is later and by an unknown
 * amount. Three anchors, in descending order of trust, and the one actually
 * used is recorded in `clock.method` rather than assumed:
 *
 *  1. **`first-frame-ts`** — gpu-screen-recorder can write the wall-clock time
 *     of the first encoded frame. Exact to about one frame interval, and that
 *     error is a fixed bias, not a drift.
 *  2. **`duration-anchored`** — anchor at the END. The instant the stop was
 *     requested is known precisely, and `ffprobe` gives the exact duration, so
 *     `t0 = stopWall − duration`. Anchoring at the end is better than at the
 *     start because all the error collects in one nameable place: the
 *     encoder's trailer flush. Expect tens of milliseconds.
 *  3. **`start-anchored`** — spawn time plus a guess. Hundreds of milliseconds.
 *     Good enough for chapter marks, not for subtitles, and it says so.
 *
 * When 1 and 2 are both available they are cross-checked; a disagreement wider
 * than 150ms means something is wrong with the assumption, so both are
 * abandoned for 3 and the file says why.
 *
 * ## What this is NOT
 *
 * Not word-level. Sentence boundaries come from `audio.onended`, which fires up
 * to one audio buffer late. `narration[].measured` says whether a line's span
 * was observed in the page or predicted from the MP3's duration — a reader that
 * needs frame accuracy has to know which it is holding.
 */
import { writeFile } from "node:fs/promises";
import type { VideoInfo } from "./postprocess.js";

export const TIMELINE_FORMAT = "demovid.timeline";
export const TIMELINE_VERSION = 1;

export type EventType =
  | "lead-in"
  | "step-start"
  | "step-end"
  | "camera-move"
  | "spotlight-on"
  | "spotlight-off"
  | "cursor-travel"
  | "cursor-click"
  | "click"
  | "type"
  | "hover"
  | "focus"
  | "scroll"
  | "navigate"
  | "balloon-show"
  | "balloon-hide"
  | "clip-start"
  | "clip-end"
  // Waiting for the app, as opposed to waiting for the viewer, which is `dwell`.
  // Separate types because the editor's question about them is opposite: dwell is
  // deliberate pacing worth keeping, and a settle is dead air that only exists
  // because the app was busy — the first thing to trim when a cut needs room.
  | "settle"
  | "expect"
  | "dwell"
  | "lead-out"
  | "error";

export interface TimelineEvent {
  t: EventType;
  /** Monotonic, so equal timestamps still sort stably. */
  seq: number;
  startMs: number;
  endMs?: number;
  stepIndex?: number;
  /** Free-form, per event type: selector, url, text, camera state. */
  data?: Record<string, unknown>;
}

export interface NarrationSpan {
  id: string;
  stepIndex: number;
  sentenceIndex: number;
  text: string;
  startMs: number;
  endMs: number;
  /** False when the span was predicted from the MP3 rather than observed. */
  measured: boolean;
}

export interface CutPoint {
  atMs: number;
  /** 0..1. Only points at or above 0.5 are emitted. */
  score: number;
  kind: "entre-passos" | "silencio" | "fim-de-fala" | "camera-parada";
  /** Why it scored what it scored. A score with no reasons is untunable. */
  reasons: string[];
  /** The quiet window this point sits in. */
  windowMs: [number, number];
}

export type ClockMethod = "first-frame-ts" | "duration-anchored" | "start-anchored";

export interface Timeline {
  format: typeof TIMELINE_FORMAT;
  version: typeof TIMELINE_VERSION;
  video: {
    path: string;
    durationMs: number;
    width: number;
    height: number;
    fps: number;
    codec: string;
    backend: string;
    scaled: boolean;
  };
  source: {
    title: string;
    url: string;
    locale: string;
    preset: string;
    cameraRung: string;
  };
  clock: {
    method: ClockMethod;
    /** Wall-clock epoch (ms) that maps to video time 0. */
    epochMs: number;
    /** Honest error bar on every timestamp in this file. */
    residualMs: number;
    crossCheckDeltaMs: number | null;
    note: string;
  };
  narration: NarrationSpan[];
  events: TimelineEvent[];
  steps: Array<{
    index: number;
    action: string;
    target?: string;
    startMs: number;
    endMs: number;
    ok: boolean;
    detail?: string;
  }>;
  cuts: CutPoint[];
  warnings: string[];
}

/**
 * Collects marks during a take.
 *
 * Wall-clock only — `performance.now()` would be monotonic but cannot be
 * compared against the recorder's own timestamps, which are wall-clock. The
 * risk that trades against is an NTP step mid-recording, which would have to
 * land inside a one-minute window to matter.
 */
export class TimelineRecorder {
  #events: TimelineEvent[] = [];
  #narration: NarrationSpan[] = [];
  #seq = 0;

  /** Record an instant. Returns the event so a caller can close it later. */
  mark(t: EventType, data?: Record<string, unknown>, stepIndex?: number): TimelineEvent {
    const e: TimelineEvent = {
      t,
      seq: this.#seq++,
      startMs: Date.now(),
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      ...(data ? { data } : {}),
    };
    this.#events.push(e);
    return e;
  }

  /** Close an event opened by `mark`. */
  end(e: TimelineEvent): void {
    e.endMs = Date.now();
  }

  /** Record an interval whose duration is already known. */
  span(t: EventType, startMs: number, endMs: number, data?: Record<string, unknown>, stepIndex?: number): void {
    this.#events.push({
      t,
      seq: this.#seq++,
      startMs,
      endMs,
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      ...(data ? { data } : {}),
    });
  }

  narrate(span: NarrationSpan): void {
    this.#narration.push(span);
  }

  get events(): TimelineEvent[] {
    return this.#events;
  }

  get narration(): NarrationSpan[] {
    return this.#narration;
  }
}

export interface ClockInputs {
  /** Wall-clock instant the stop was requested. */
  stoppedAtMs: number | null;
  /** Wall-clock instant the recorder was spawned. */
  startedAtMs: number;
  /** Exact duration of the finished file. */
  durationMs: number;
  /** `realtime_microsec` of the first encoded frame, when the backend wrote it. */
  firstFrameRealtimeUs: number | null;
}

/** Decide which anchor to trust, and be explicit about the error it carries. */
export function resolveClock(input: ClockInputs): Timeline["clock"] {
  const fromFirstFrame =
    input.firstFrameRealtimeUs !== null ? Math.round(input.firstFrameRealtimeUs / 1000) : null;
  const fromDuration =
    input.stoppedAtMs !== null ? input.stoppedAtMs - input.durationMs : null;

  const crossCheckDeltaMs =
    fromFirstFrame !== null && fromDuration !== null ? fromFirstFrame - fromDuration : null;

  // Both available and they agree: take the exact one.
  if (fromFirstFrame !== null && (crossCheckDeltaMs === null || Math.abs(crossCheckDeltaMs) <= 150)) {
    return {
      method: "first-frame-ts",
      epochMs: fromFirstFrame,
      residualMs: 17,
      crossCheckDeltaMs,
      note: "timestamp real do primeiro frame, escrito pelo gravador. Erro ≈ um intervalo de frame.",
    };
  }

  // They disagree: an assumption is wrong somewhere, so trust neither.
  if (crossCheckDeltaMs !== null && Math.abs(crossCheckDeltaMs) > 150) {
    return {
      method: "start-anchored",
      epochMs: input.startedAtMs,
      residualMs: 300,
      crossCheckDeltaMs,
      note:
        `as duas âncoras discordaram em ${crossCheckDeltaMs}ms, então nenhuma foi usada. ` +
        `Estes tempos servem para capítulos, não para legendas.`,
    };
  }

  if (fromDuration !== null) {
    return {
      method: "duration-anchored",
      epochMs: fromDuration,
      residualMs: 60,
      crossCheckDeltaMs,
      note: "ancorado no fim: instante da parada menos a duração medida. O erro fica no flush do encoder.",
    };
  }

  return {
    method: "start-anchored",
    epochMs: input.startedAtMs,
    residualMs: 300,
    crossCheckDeltaMs,
    note: "nenhuma âncora melhor disponível — tempos aproximados.",
  };
}

/** Shift a wall-clock instant into video time, clamped to the file. */
const toVideo = (wallMs: number, epochMs: number, durationMs: number): number =>
  Math.max(0, Math.min(durationMs, Math.round(wallMs - epochMs)));

/**
 * Score the moments where a cut would not interrupt anything.
 *
 * Additive and clamped, and every contribution is named in `reasons` — a score
 * whose derivation is invisible cannot be tuned, only replaced.
 */
export function scoreCuts(
  events: TimelineEvent[],
  narration: NarrationSpan[],
  durationMs: number,
): CutPoint[] {
  const cuts: CutPoint[] = [];
  const sorted = [...narration].sort((a, b) => a.startMs - b.startMs);

  // Candidate windows: the silences between spoken lines, plus the head and the
  // tail. Everything else is someone talking.
  const gaps: Array<{ from: number; to: number; kind: CutPoint["kind"] }> = [];
  let cursor = 0;
  for (const line of sorted) {
    if (line.startMs - cursor > 300) gaps.push({ from: cursor, to: line.startMs, kind: "silencio" });
    cursor = Math.max(cursor, line.endMs);
  }
  if (durationMs - cursor > 300) gaps.push({ from: cursor, to: durationMs, kind: "fim-de-fala" });

  const stepBounds = events
    .filter((e) => e.t === "step-start" || e.t === "step-end")
    .map((e) => e.startMs);
  const cameraMoves = events.filter((e) => e.t === "camera-move");
  const navigations = events.filter((e) => e.t === "navigate");
  const failed = new Set(
    events.filter((e) => e.t === "error").map((e) => e.stepIndex ?? -1),
  );

  for (const gap of gaps) {
    const at = Math.round((gap.from + gap.to) / 2);
    const silenceMs = gap.to - gap.from;
    const reasons: string[] = [];
    let score = 0;

    const silenceScore = 0.35 * Math.min(1, silenceMs / 1500);
    score += silenceScore;
    reasons.push(`silêncio de ${silenceMs}ms (+${silenceScore.toFixed(2)})`);

    const movingCamera = cameraMoves.some(
      (e) => at >= e.startMs - 400 && at <= (e.endMs ?? e.startMs) + 400,
    );
    if (!movingCamera) {
      score += 0.25;
      reasons.push("câmera parada (+0.25)");
    }

    const nearBoundary = stepBounds.some((b) => Math.abs(b - at) < 600);
    if (nearBoundary) {
      score += 0.15;
      reasons.push("fronteira de passo (+0.15)");
    }

    const nearNav = navigations.some((e) => Math.abs(e.startMs - at) < 600);
    if (nearNav) {
      score -= 0.4;
      reasons.push("navegação por perto (−0.40)");
    }

    const inFailedStep = events.some(
      (e) =>
        e.t === "step-start" &&
        failed.has(e.stepIndex ?? -1) &&
        at >= e.startMs &&
        at <= (e.endMs ?? e.startMs),
    );
    if (inFailedStep) {
      score -= 0.3;
      reasons.push("passo falhou (−0.30)");
    }

    score = Math.max(0, Math.min(1, score));
    if (score >= 0.5) {
      cuts.push({
        atMs: at,
        score: Number(score.toFixed(3)),
        kind: nearBoundary ? "entre-passos" : gap.kind,
        reasons,
        windowMs: [gap.from, gap.to],
      });
    }
  }

  return cuts.sort((a, b) => b.score - a.score);
}

export interface BuildTimelineInput {
  outputPath: string;
  video: VideoInfo;
  backend: string;
  scaled: boolean;
  storyboard: { title: string; url: string; locale: string; preset: string };
  cameraRung: string;
  clock: ClockInputs;
  recorder: TimelineRecorder;
  steps: Array<{
    index: number;
    action: string;
    target?: string | undefined;
    ok: boolean;
    detail?: string;
    startedAtMs: number;
    endedAtMs: number;
  }>;
  warnings: string[];
}

export function buildTimeline(input: BuildTimelineInput): Timeline {
  const clock = resolveClock(input.clock);
  const d = input.video.durationMs;
  const rel = (ms: number): number => toVideo(ms, clock.epochMs, d);

  const events: TimelineEvent[] = input.recorder.events
    .map((e) => ({
      ...e,
      startMs: rel(e.startMs),
      ...(e.endMs !== undefined ? { endMs: rel(e.endMs) } : {}),
    }))
    .sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);

  const narration: NarrationSpan[] = input.recorder.narration
    .map((n) => ({ ...n, startMs: rel(n.startMs), endMs: rel(n.endMs) }))
    .sort((a, b) => a.startMs - b.startMs);

  return {
    format: TIMELINE_FORMAT,
    version: TIMELINE_VERSION,
    video: {
      path: input.outputPath,
      durationMs: d,
      width: input.video.width,
      height: input.video.height,
      fps: input.video.fps,
      codec: input.video.videoCodec,
      backend: input.backend,
      scaled: input.scaled,
    },
    source: {
      title: input.storyboard.title,
      url: input.storyboard.url,
      locale: input.storyboard.locale,
      preset: input.storyboard.preset,
      cameraRung: input.cameraRung,
    },
    clock,
    narration,
    events,
    steps: input.steps.map((s) => ({
      index: s.index,
      action: s.action,
      ...(s.target !== undefined ? { target: s.target } : {}),
      startMs: rel(s.startedAtMs),
      endMs: rel(s.endedAtMs),
      ok: s.ok,
      ...(s.detail !== undefined ? { detail: s.detail } : {}),
    })),
    cuts: scoreCuts(events, narration, d),
    warnings: input.warnings,
  };
}

/** `<video>.timeline.json`, beside the MP4. */
export function timelinePathFor(videoPath: string): string {
  return `${videoPath.replace(/\.[^./]+$/, "")}.timeline.json`;
}

export async function writeTimeline(path: string, timeline: Timeline): Promise<void> {
  await writeFile(path, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
}
