/**
 * Static checks on the generated Remotion project's source.
 *
 * `templates/` is in neither `tsconfig`, so `npm run typecheck` never sees it and
 * `npm run test:remotion` — the only thing that compiles it — is deliberately outside
 * `npm run verify` because it installs ~270 MB. That leaves a gap, and the two bugs
 * that live in it are both **invisible in the rendered MP4**:
 *
 *  - a viewport unit renders correctly and only breaks the Studio preview;
 *  - the duration formula is duplicated in two files whose agreement was, until this
 *    file existed, guaranteed by a comment saying "if you change one, change both".
 *
 * Both are cheap to assert from here, with no Remotion, no install and no render.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildEdl, edlDurationInFrames } from "../src/remotion/edl.js";
import type { Timeline } from "../src/timeline.js";
import { TIMELINE_FORMAT, TIMELINE_VERSION } from "../src/timeline.js";

const TEMPLATE_SRC = "templates/remotion/src";

/**
 * The template's duration arithmetic, loaded at RUNTIME.
 *
 * Deliberately not a static import. The template is its own compilation universe —
 * `moduleResolution: "bundler"`, extensionless imports, no `"type": "module"` — which
 * is the whole reason it lives outside both of demovid's tsconfigs. A static import
 * would drag it into this program and it fails there for exactly that reason
 * (`TS1287`, top-level `export` in a file NodeNext resolves as CommonJS). Building
 * the specifier from a variable keeps `tsc` out of it while `tsx` still runs the real
 * code, so what is compared is the template's actual function and not a copy of it.
 */
async function templateArithmetic(): Promise<{
  totalFrames: (edl: unknown) => number;
  transitionCostAt: (edl: unknown, index: number) => number;
}> {
  const spec = new URL("../templates/remotion/src/edl.ts", import.meta.url).href;
  return (await import(spec)) as Awaited<ReturnType<typeof templateArithmetic>>;
}

/** Every `.ts`/`.tsx` under the template's `src`, recursively. */
function templateFiles(dir = TEMPLATE_SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return templateFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/**
 * Drop comments so a rule cannot be satisfied — or violated — by prose.
 *
 * `theme.ts` explains the viewport-unit ban by quoting the measurement that produced
 * it ("`20vh` measured 180px"), so a scan of the raw text would flag the very comment
 * telling you not to do it. `skill-verify.mjs` has the same stripper for the same
 * reason: a claim about behaviour must be checked against code, not against writing.
 */
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; ) {
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src[i] === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

test("nenhum componente do template usa unidade de viewport", () => {
  // Num render o viewport do browser É a composição, então `vh` sai certo no MP4 e o
  // erro é invisível. Mas o Studio desenha a composição num contêiner com
  // `transform: scale()` dentro de uma janela normal, e aí `vh` mede a JANELA: numa
  // composição de 1280×720, `20vh` deu 180px numa janela de 900px de altura e 240px
  // numa de 1200px, contra os 144px do render. O preview mentiria — e mentiria
  // diferente a cada redimensionamento. Tamanho vem de `useVideoConfig()`.
  const banned = /\b\d+(?:\.\d+)?(vh|vw|vmin|vmax|rem)\b/;
  const offenders: string[] = [];

  for (const file of templateFiles()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [i, line] of code.split("\n").entries()) {
      const hit = banned.exec(line);
      if (hit) offenders.push(`${file}:${i + 1} usa "${hit[0]}" — derive de useVideoConfig().height`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("o template e o demovid concordam na duração — a mesma fórmula em dois arquivos", async () => {
  const { totalFrames, transitionCostAt } = await templateArithmetic();

  // `totalFrames` (o que o renderizador usa em `calculateMetadata`) e
  // `edlDurationInFrames` (o que o demovid reporta) são a mesma conta escrita duas
  // vezes, porque o template não pode importar do demovid. Até aqui a garantia era um
  // comentário. Uma discordância de um frame é um frame preto no fim do vídeo.
  const timeline = (): Timeline => ({
    format: TIMELINE_FORMAT,
    version: TIMELINE_VERSION,
    video: {
      path: "demo.mp4",
      durationMs: 20_000,
      width: 1600,
      height: 900,
      fps: 60,
      codec: "h264",
      backend: "gsr",
      scaled: false,
    },
    source: { title: "t", url: "u", locale: "pt-BR", preset: "comercial", cameraRung: "R1" },
    clock: { method: "first-frame-ts", epochMs: 0, residualMs: 17, crossCheckDeltaMs: null, note: "" },
    narration: [
      { id: "a", stepIndex: 0, sentenceIndex: 0, text: "um", startMs: 0, endMs: 2000, measured: true },
      { id: "b", stepIndex: 1, sentenceIndex: 0, text: "dois", startMs: 6000, endMs: 8000, measured: true },
      { id: "c", stepIndex: 2, sentenceIndex: 0, text: "três", startMs: 11_000, endMs: 13_000, measured: true },
    ],
    events: [],
    steps: [
      { index: 0, action: "click", startMs: 0, endMs: 5000, ok: true },
      { index: 1, action: "click", startMs: 5000, endMs: 10_000, ok: true },
      { index: 2, action: "click", startMs: 10_000, endMs: 15_000, ok: true },
    ],
    cuts: [4000, 9500].map((atMs) => ({
      atMs,
      score: 0.75,
      kind: "entre-passos" as const,
      reasons: ["fixture"],
      windowMs: [atMs - 500, atMs + 500] as [number, number],
    })),
    warnings: [],
  });

  const edl = buildEdl({
    timeline: timeline(),
    videoSrc: "demo.mp4",
    fps: 30,
    commercial: {
      hook: { text: "gancho", sub: null },
      scenes: [
        { index: 0, transition: "corte", impactAtPercent: 0.25, impact: "duas palavras", kenBurns: false },
        { index: 1, transition: "fade", impactAtPercent: 0.25, impact: null, kenBurns: false },
        { index: 2, transition: "wipe", impactAtPercent: 0.25, impact: null, kenBurns: false },
      ],
      endCard: { title: "fecho", cta: "cta" },
    },
  });

  // A fixture tem de exercitar transições de verdade, senão as duas contas
  // concordariam por não ter nada para subtrair.
  assert.ok(
    edl.scenes.some((s) => s.transitionIn),
    "a fixture precisa de pelo menos uma transição para a conta ter o que comparar",
  );

  assert.equal(totalFrames(edl), edlDurationInFrames(edl));

  // E a regra da transição de borda é a mesma nos dois lados: com gancho, a transição
  // da cena 0 fica ENTRE duas sequências e custa; sem gancho ela é de borda e é grátis.
  for (const [i, scene] of edl.scenes.entries()) {
    const expected = scene.transitionIn && !(i === 0 && !edl.hook) ? scene.transitionIn.durationInFrames : 0;
    assert.equal(
      transitionCostAt(edl, i),
      expected,
      `cena ${i}: o custo da transição divergiu entre template e demovid`,
    );
  }

  // O mesmo EDL sem gancho: a cena 0 passa a ser o primeiro filho, e as duas contas
  // têm de continuar de acordo — é a divergência que corta o fim do vídeo.
  const noHook = { ...edl, hook: null };
  assert.equal(totalFrames(noHook), edlDurationInFrames(noHook));
});
