/**
 * O projeto Remotion gerado, contra o Remotion de verdade.
 *
 * Fora de `test/*.test.ts` e fora de `npm run verify` de propósito: instala
 * ~270 MB de `node_modules` e renderiza vídeo. Um `verify` que baixa isso é um
 * `verify` que ninguém roda.
 *
 *   node --import tsx test/remotion.e2e.ts
 *
 * Também NÃO precisa de display, de browser, de chave de API nem de gravação: a
 * fonte é sintetizada pelo ffmpeg e a montagem é escrita à mão aqui, então o que
 * está sob teste é só o template mais o `buildEdl`.
 *
 * O que só um render real prova:
 *  - que o projeto **typecheca** — três erros reais escaparam do typecheck do
 *    demovid, porque `templates/` não está em nenhum dos dois `tsconfig`;
 *  - que `trimBefore`/`trimAfter` são frames absolutos no source, e não offsets
 *    (a leitura errada renderiza sem erro, mostrando o pedaço errado do vídeo);
 *  - que `<TransitionSeries.Transition>` aceita as três presentations que o EDL
 *    tem permissão de nomear — um mapa de presentations compila para uma união e
 *    NÃO compila;
 *  - que a duração da composição é `Σcenas − Σtransições`, porque um frame a mais
 *    é um frame preto no fim.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, which } from "../src/exec.js";
import type { Commercial } from "../src/openai/commercial.js";
import { buildEdl, edlDurationInFrames } from "../src/remotion/edl.js";
import { scaffoldRemotion } from "../src/remotion/scaffold.js";
import { TIMELINE_FORMAT, TIMELINE_VERSION, type Timeline } from "../src/timeline.js";

let failures = 0;

/** Mesmo contrato dos outros harnesses: `fn` pode ser async e É aguardado. */
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    console.error(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(e as Error).message.split("\n").slice(0, 3).join("\n      ")}`);
  }
};

const FPS = 30;

/**
 * Uma timeline de quatro passos com silêncio medido entre eles, e pontos de corte
 * que endossam as três primeiras fronteiras. Números redondos para que a conta de
 * frames seja verificável de cabeça.
 */
function fixtureTimeline(): Timeline {
  const steps = [0, 1, 2, 3].map((i) => ({
    index: i,
    action: i === 0 ? "wait" : "click",
    target: i === 0 ? undefined : `#alvo-${i}`,
    startMs: i * 3000,
    endMs: i * 3000 + 3000,
    ok: true,
  }));
  return {
    format: TIMELINE_FORMAT,
    version: TIMELINE_VERSION,
    video: {
      path: "demo.mp4",
      durationMs: 12_000,
      width: 640,
      height: 360,
      fps: 30,
      codec: "h264",
      backend: "ffmpeg",
      scaled: false,
    },
    source: { title: "Fixture", url: "about:blank", locale: "pt-BR", preset: "comercial", cameraRung: "R1" },
    clock: { method: "first-frame-ts", epochMs: 0, residualMs: 17, crossCheckDeltaMs: null, note: "" },
    // Fala nos primeiros 1.2s de cada passo — deixa 1.8s de silêncio na fronteira.
    narration: steps.map((s, i) => ({
      id: `clip${i}`,
      stepIndex: s.index,
      sentenceIndex: 0,
      text: `Frase ${i}.`,
      startMs: s.startMs + 100,
      endMs: s.startMs + 1300,
      measured: true,
    })),
    // A câmera se moveu no passo 2, então o kenBurns dele tem de ser ignorado.
    events: [{ t: "camera-move", seq: 0, startMs: 6100, stepIndex: 2 }],
    steps,
    cuts: [1, 2, 3].map((i) => ({
      atMs: i * 3000,
      score: 0.75,
      kind: "entre-passos" as const,
      reasons: ["fixture"],
      windowMs: [i * 3000 - 900, i * 3000 + 900] as [number, number],
    })),
    warnings: [],
  };
}

/** Uma montagem que exercita as TRÊS presentations, o kenBurns e as frases. */
const COMMERCIAL: Commercial = {
  hook: { text: "O gancho", sub: "O subtítulo" },
  scenes: [
    { index: 0, transition: "corte", impactAtPercent: 0.3, impact: "primeira frase", kenBurns: true },
    { index: 1, transition: "fade", impactAtPercent: 0.3, impact: null, kenBurns: false },
    { index: 2, transition: "wipe", impactAtPercent: 0.4, impact: "com camera movida", kenBurns: true },
    { index: 3, transition: "slide", impactAtPercent: 0.5, impact: null, kenBurns: false },
  ],
  endCard: { title: "O fecho", cta: "A chamada" },
};

const dir = await mkdtemp(join(tmpdir(), "demovid-remotion-e2e-"));
const project = join(dir, "proj");

try {
  const npm = await which("npm");
  if (!npm) throw new Error("npm não está no PATH — sem ele este e2e não tem sinal nenhum");

  // ── fonte sintetizada, sem gravação ─────────────────────────────────────
  const video = join(dir, "demo.mp4");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", video,
  ]);

  // Clipes de narração: silêncio de 1.2s cada, só para o scaffold ter o que copiar.
  const clips = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const path = join(dir, `clip${i}.mp3`);
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "1.2",
        "-c:a", "libmp3lame", "-y", path,
      ]);
      return { id: `clip${i}`, text: `Frase ${i}.`, spoken: `Frase ${i}.`, path, durationS: 1.2, cached: false };
    }),
  );

  const timeline = fixtureTimeline();
  const edl = buildEdl({ timeline, videoSrc: "demo.mp4", commercial: COMMERCIAL, fps: FPS });

  await check("as três presentations sobreviveram ao clamp — senão o render não as testa", () => {
    const kinds = edl.scenes.map((s) => s.transitionIn?.presentation).filter(Boolean);
    assert.deepEqual(kinds, ["fade", "wipe", "slide"], `saiu ${JSON.stringify(kinds)}`);
  });

  await check("kenBurns foi ignorado no passo onde a câmera da página se moveu", () => {
    assert.ok(edl.scenes[0]?.kenBurns, "passo 0 tinha câmera parada e pediu kenBurns");
    assert.equal(edl.scenes[2]?.kenBurns, null, "passo 2 teve camera-move");
  });

  const result = await scaffoldRemotion({
    dir: project,
    edl,
    videoPath: video,
    clips,
    name: "e2e-comercial",
    onLog: (l) => console.error(`  · ${l}`),
  });

  await check("o scaffold escreveu o projeto e o roteiro de edição", async () => {
    for (const f of ["package.json", "tsconfig.json", "remotion.config.ts", "src/Root.tsx", "src/edl.json"]) {
      assert.ok((await stat(join(project, f))).size > 0, `${f} faltando ou vazio`);
    }
    const written = JSON.parse(await readFile(result.edlPath, "utf8")) as typeof edl;
    assert.equal(written.scenes.length, 4);
    assert.equal(written.audio, "embedded");
  });

  await check("só os clipes que o EDL referencia foram copiados", async () => {
    // O cache é compartilhado entre todos os demos da máquina; copiar tudo
    // embarcaria a narração de outros projetos.
    for (const i of [0, 1, 2, 3]) {
      assert.ok((await stat(join(project, "public", "audio", `clip${i}.mp3`))).size > 0);
    }
    const extra = await stat(join(project, "public", "audio", "naoexiste.mp3")).then(
      () => true,
      () => false,
    );
    assert.equal(extra, false);
  });

  console.error("  · instalando (uma vez, ~270 MB)");
  await run(npm, ["install", "--no-audit", "--no-fund", "--loglevel", "error"], {
    cwd: project,
    maxBuffer: 32 * 1024 * 1024,
  });

  await check("o projeto gerado TYPECHECA", async () => {
    // `templates/` não está em tsconfig.json nem em tsconfig.build.json, então
    // este é o único lugar onde um erro de tipo no template aparece.
    await run(join(project, "node_modules", ".bin", "tsc"), ["--noEmit"], { cwd: project });
  });

  await check("renderiza, e a duração é Σcenas − Σtransições", async () => {
    const out = join(project, "out.mp4");
    await run(join(project, "node_modules", ".bin", "remotion"), ["render", "Comercial", out, "--log=error"], {
      cwd: project,
      maxBuffer: 32 * 1024 * 1024,
    });
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out,
    ]);
    const expected = edlDurationInFrames(edl) / FPS;
    const actual = Number.parseFloat(stdout.trim());
    // Um frame de tolerância: o container arredonda, a conta não.
    assert.ok(
      Math.abs(actual - expected) <= 1 / FPS + 0.05,
      `esperado ~${expected.toFixed(2)}s, saiu ${actual.toFixed(2)}s`,
    );
  });

  await check("um frame DENTRO de uma cena mostra o pedaço certo do source", async () => {
    // Se `trimAfter` fosse lido como "tire N frames do fim" em vez de "corte no
    // frame N", isto renderizaria sem erro e mostraria outro momento do vídeo.
    // `testsrc` tem um contador de tempo desenhado, então os pixels diferem entre
    // dois instantes — e dois stills de cenas diferentes têm de diferir.
    const bin = join(project, "node_modules", ".bin", "remotion");
    const a = join(project, "a.png");
    const b = join(project, "b.png");
    const hook = edl.hook?.durationInFrames ?? 0;
    const s0 = hook + Math.floor((edl.scenes[0]?.durationInFrames ?? 2) / 2);
    const s3 = hook + edl.scenes.slice(0, 3).reduce((n, s) => n + s.durationInFrames, 0);
    await run(bin, ["still", "Comercial", a, `--frame=${s0}`, "--log=error"], { cwd: project });
    await run(bin, ["still", "Comercial", b, `--frame=${s3}`, "--log=error"], { cwd: project });
    const [pa, pb] = await Promise.all([readFile(a), readFile(b)]);
    assert.ok(!pa.equals(pb), "duas cenas distintas renderizaram pixels idênticos");
  });

  console.error(failures === 0 ? "\n[remotion-e2e] tudo verde" : `\n[remotion-e2e] ${failures} falha(s)`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
