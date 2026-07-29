/**
 * Unit tests for the timeline's two pieces of real logic: which clock anchor to
 * trust, and where a cut would not interrupt anything.
 *
 * Both are pure, and both fail silently in production if they are wrong — a bad
 * clock produces a file full of confidently wrong timestamps, and a bad cut
 * score produces suggestions that land mid-sentence.
 *
 *   node --import tsx --test test/timeline.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveClock,
  scoreCuts,
  TimelineRecorder,
  timelinePathFor,
  type NarrationSpan,
  type TimelineEvent,
} from "../src/timeline.js";

const STOP = 1_000_000;
const DURATION = 50_000;

test("the exact anchor wins when the two agree", () => {
  const clock = resolveClock({
    stoppedAtMs: STOP,
    startedAtMs: STOP - DURATION - 600,
    durationMs: DURATION,
    // 40ms away from the duration anchor — well inside tolerance.
    firstFrameRealtimeUs: (STOP - DURATION + 40) * 1000,
  });
  assert.equal(clock.method, "first-frame-ts");
  assert.equal(clock.epochMs, STOP - DURATION + 40);
  assert.equal(clock.crossCheckDeltaMs, 40);
  assert.ok(clock.residualMs <= 20, "o timestamp real do primeiro frame vale ~1 frame de erro");
});

test("a disagreement between anchors discards BOTH, loudly", () => {
  // If they disagree an assumption is broken somewhere, and picking the
  // prettier number would just be confidently wrong.
  const clock = resolveClock({
    stoppedAtMs: STOP,
    startedAtMs: STOP - DURATION - 600,
    durationMs: DURATION,
    firstFrameRealtimeUs: (STOP - DURATION + 900) * 1000,
  });
  assert.equal(clock.method, "start-anchored");
  assert.equal(clock.crossCheckDeltaMs, 900);
  assert.ok(clock.residualMs >= 300, "um relógio ruim tem que declarar erro grande");
  assert.match(clock.note, /discordaram/);
});

test("without a first-frame timestamp, anchor at the END not the start", () => {
  const clock = resolveClock({
    stoppedAtMs: STOP,
    startedAtMs: STOP - DURATION - 600,
    durationMs: DURATION,
    firstFrameRealtimeUs: null,
  });
  assert.equal(clock.method, "duration-anchored");
  // All the error collects in the encoder's trailer flush, one nameable place.
  assert.equal(clock.epochMs, STOP - DURATION);
  assert.equal(clock.crossCheckDeltaMs, null);
});

test("with no anchor at all it degrades to spawn time and says so", () => {
  const clock = resolveClock({
    stoppedAtMs: null,
    startedAtMs: 12345,
    durationMs: DURATION,
    firstFrameRealtimeUs: null,
  });
  assert.equal(clock.method, "start-anchored");
  assert.equal(clock.epochMs, 12345);
  assert.ok(clock.residualMs >= 300);
});

const say = (i: number, startMs: number, endMs: number): NarrationSpan => ({
  id: `c${i}`,
  stepIndex: i,
  sentenceIndex: 0,
  text: `fala ${i}`,
  startMs,
  endMs,
  measured: true,
});

const ev = (t: TimelineEvent["t"], startMs: number, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  t,
  seq: startMs,
  startMs,
  ...extra,
});

test("cuts land in the silences, never inside a spoken line", () => {
  const narration = [say(0, 1000, 5000), say(1, 9000, 13000)];
  const events = [ev("step-start", 800), ev("step-end", 5200), ev("step-start", 8800)];
  const cuts = scoreCuts(events, narration, 20_000);

  assert.ok(cuts.length > 0, "esperava pelo menos um corte");
  for (const c of cuts) {
    for (const n of narration) {
      assert.ok(
        c.atMs <= n.startMs || c.atMs >= n.endMs,
        `corte em ${c.atMs}ms cai dentro da fala ${n.startMs}–${n.endMs}`,
      );
    }
    assert.ok(c.score >= 0.5, "só pontos >= 0.5 devem ser emitidos");
    assert.ok(c.reasons.length > 0, "um score sem justificativa é inajustável");
  }
});

test("a camera move nearby costs the point its silence bonus", () => {
  const narration = [say(0, 1000, 5000), say(1, 12000, 15000)];
  const still = scoreCuts([], narration, 20_000);
  const moving = scoreCuts(
    [ev("camera-move", 8000, { endMs: 8600 })],
    narration,
    20_000,
  );

  const gapMid = 8500; // centre of the 5000–12000 silence
  const findNear = (cs: ReturnType<typeof scoreCuts>): number | undefined =>
    cs.find((c) => Math.abs(c.atMs - gapMid) < 100)?.score;

  const a = findNear(still);
  const b = findNear(moving);
  assert.ok(a !== undefined, "o silêncio longo tem que virar candidato");
  assert.ok(b === undefined || b < a, `câmera em movimento devia baixar o score (${a} → ${b})`);
});

test("a navigation nearby is a strong penalty", () => {
  const narration = [say(0, 1000, 5000), say(1, 12000, 15000)];
  const withNav = scoreCuts([ev("navigate", 8400)], narration, 20_000);
  const near = withNav.find((c) => Math.abs(c.atMs - 8500) < 200);
  assert.ok(
    near === undefined || near.reasons.some((r) => r.includes("navegação")),
    "cortar em cima de uma navegação tem que ser penalizado e dito",
  );
});

test("cuts come back sorted by score, best first", () => {
  const narration = [say(0, 1000, 2000), say(1, 12000, 13000), say(2, 14000, 15000)];
  const cuts = scoreCuts([ev("step-start", 11800)], narration, 30_000);
  for (let i = 1; i < cuts.length; i++) {
    assert.ok(cuts[i - 1]!.score >= cuts[i]!.score, "a lista tem que vir ordenada");
  }
});

test("TimelineRecorder keeps insertion order stable for identical instants", () => {
  const tl = new TimelineRecorder();
  const a = tl.mark("step-start");
  tl.mark("spotlight-on");
  tl.mark("balloon-show");
  tl.end(a);

  const seqs = tl.events.map((e) => e.seq);
  assert.deepEqual(seqs, [0, 1, 2], "seq tem que ser monotônico");
  assert.ok(a.endMs !== undefined, "end() tem que fechar o evento");
});

test("the sidecar sits beside the video, whatever the extension", () => {
  assert.equal(timelinePathFor("/tmp/demo.mp4"), "/tmp/demo.timeline.json");
  assert.equal(timelinePathFor("/a/b/c.mkv"), "/a/b/c.timeline.json");
  assert.equal(timelinePathFor("/tmp/sem-extensao"), "/tmp/sem-extensao.timeline.json");
});
