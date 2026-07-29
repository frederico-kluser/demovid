/**
 * Prova a integração mais arriscada do projeto, de ponta a ponta e de verdade:
 * abre o browser → resolve o window id no X11 → manda o `rec` gravar AQUELA
 * janela → monta o overlay → mexe a câmera → para o `rec` → confere o MP4.
 *
 * Grava ~8 segundos reais. Nada é simulado.
 *
 *   node --import tsx test/record.e2e.ts
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "../src/browser.js";
import { run } from "../src/exec.js";
import { previewCommand, startRecording } from "../src/rec.js";

const OUT = join(tmpdir(), `demovid-e2e-${Date.now()}.mp4`);

const APP = `data:text/html,${encodeURIComponent(`<!doctype html>
<meta charset=utf-8><title>demovid record e2e</title><style>
 body{margin:0;font:15px system-ui;background:#fff}
 header{position:fixed;top:0;left:0;right:0;height:56px;background:#0F172A;color:#F1F5F9;
        display:flex;align-items:center;padding:0 20px;font-weight:600}
 main{height:2400px;padding:80px 24px}
 #alvo{width:360px;padding:14px;border:2px solid #3B82F6;border-radius:8px;margin-left:120px}
 #alvo p{margin:6px 0 0;font-size:11px;color:#64748b}
</style>
<header>Painel de Exames</header>
<main><div id=alvo><b>Requisições pendentes</b>
<p>Hemograma completo e glicemia de jejum aguardando coleta.</p></div></main>`)}`;

let failures = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    console.error(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(e as Error).message.split("\n").slice(0, 6).join("\n      ")}`);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const browser = await launchBrowser({ width: 1440, height: 900, x: 2200, y: 120 });
let recording: Awaited<ReturnType<typeof startRecording>> | null = null;

try {
  console.error(`  · browser: ${browser.browserPath}`);
  console.error(`  · janela X11: ${browser.windowId}`);

  check("o window id resolvido é uma janela real", async () => {
    assert.match(browser.windowId, /^\d+$/, `id inesperado: ${browser.windowId}`);
  });

  const { stdout: geom } = await run("xdotool", ["getwindowgeometry", "--shell", browser.windowId]);
  check("a janela tem o tamanho que pedimos", () => {
    const w = Number(/^WIDTH=(\d+)$/m.exec(geom)?.[1] ?? 0);
    const h = Number(/^HEIGHT=(\d+)$/m.exec(geom)?.[1] ?? 0);
    assert.ok(w >= 1400 && w <= 1480, `largura ${w}, esperado ~1440`);
    assert.ok(h >= 820 && h <= 920, `altura ${h}, esperado ~900`);
  });

  await browser.page.goto(APP, { waitUntil: "load" });
  await browser.page.waitForSelector("#alvo", { state: "attached" });

  const mounted = await browser.page.evaluate(() => window.__demovid?.mount());
  check("o overlay foi injetado pelo addInitScript do contexto", () => {
    assert.ok(mounted, "window.__demovid não existe — o init script não rodou");
    assert.ok(mounted.stage, `palco não montou: ${mounted.why ?? "?"}`);
    assert.ok(mounted.overlay, "overlay não montou");
  });

  const cmd = previewCommand({
    target: { kind: "window", windowId: browser.windowId },
    output: OUT,
    audio: "system",
  });
  console.error(`  · ${cmd}`);

  recording = await startRecording({
    target: { kind: "window", windowId: browser.windowId },
    output: OUT,
    audio: "system",
    fps: 60,
  });

  check("o rec iniciou e continua vivo", () => {
    assert.ok(recording!.running, `rec morreu ao iniciar:\n${recording!.stderrTail}`);
  });

  // Toca um tom pela Web Audio API. É o teste do caminho de áudio inteiro:
  // página → sink do PipeWire → monitor → rec. Sem isso a faixa fica muda e a
  // asserção de conteúdo lá embaixo não prova nada.
  await browser.page.evaluate(() => {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.25;
    osc.connect(gain).connect(ac.destination);
    osc.start();
    // Para junto com a gravação; nada de deixar um oscilador tocando.
    setTimeout(() => { osc.stop(); void ac.close(); }, 5000);
  });

  // Uma coreografia mínima, para o vídeo ter movimento de verdade.
  await sleep(1200);
  const cam = await browser.page.evaluate(() => window.__demovid!.cameraFor("#alvo", 1.6));
  assert.ok(cam, "cameraFor não resolveu #alvo");
  await browser.page.evaluate((c) => window.__demovid!.setCamera(c!), cam);
  await sleep(2000);

  const unscaled = await browser.page.evaluate(() => window.__demovid!.assertUnscaled());
  check("durante a gravação, o overlay segue 1:1", () => {
    assert.ok(unscaled.ok, unscaled.detail);
  });

  // Exercita o pause, que é o toggle SIGUSR2.
  recording.setPaused(true);
  await sleep(700);
  check("pause é refletido no estado", () => {
    assert.equal(recording!.paused, true);
  });
  recording.setPaused(false);
  await sleep(1200);
  check("resume volta o estado", () => {
    assert.equal(recording!.paused, false);
  });

  await browser.page.evaluate(() => window.__demovid!.setCamera({ tx: 0, ty: 0, k: 1 }));
  await sleep(1200);

  const stopped = await recording.stop();
  recording = null;
  console.error(`  · MP4: ${stopped.output} (${(stopped.bytes / 1024 / 1024).toFixed(2)} MB)`);

  check("o MP4 saiu com tamanho plausível", () => {
    assert.ok(stopped.bytes > 50_000, `só ${stopped.bytes} bytes — provavelmente truncado`);
  });

  const { stdout: probe } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
    "-of", "default=nw=1", stopped.output,
  ]);
  console.error(`  · ${probe.trim().split("\n").join(" · ")}`);

  check("o container tem vídeo e áudio, e dura o que gravamos", () => {
    assert.match(probe, /codec_type=video/, "sem faixa de vídeo");
    assert.match(probe, /codec_type=audio/, "sem faixa de áudio (o som do sistema não entrou)");
    const d = Number(/duration=([\d.]+)/.exec(probe)?.[1] ?? 0);
    assert.ok(d > 4 && d < 20, `duração ${d}s fora do esperado (~7s)`);
  });

  // Faixa de áudio EXISTIR e ter CONTEÚDO são coisas diferentes. A checagem
  // acima passaria com silêncio absoluto — que é exatamente como um vídeo mudo
  // chegaria ao usuário sem ninguém notar.
  const { stderr: vol } = await run("ffmpeg", [
    "-hide_banner", "-i", stopped.output, "-af", "volumedetect", "-f", "null", "-",
  ]).catch((e: unknown) => ({ stderr: String((e as { stderrTail?: string }).stderrTail ?? "") }));
  const meanDb = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(vol)?.[1] ?? NaN);
  console.error(`  · áudio: mean ${meanDb} dB`);
  check("a faixa de áudio tem sinal, não silêncio", () => {
    assert.ok(Number.isFinite(meanDb), `não consegui medir o volume: ${vol.slice(0, 160)}`);
    // Silêncio digital mede −91 dB. Fala normalizada a −14 LUFS fica bem acima.
    assert.ok(meanDb > -50, `mean_volume ${meanDb} dB — a faixa está praticamente muda`);
  });
} finally {
  // dispose() incondicional — nunca `if (recording.running)`. Foi exatamente
  // esse guard que deixou um gpu-screen-recorder órfão gravando quando o getter
  // `running` estava bugado.
  await recording?.dispose();
  await browser.close();
  if (process.env["DEMOVID_KEEP"] !== "1") await rm(OUT, { force: true });
}

console.error(failures === 0 ? "\n[record-e2e] tudo verde" : `\n[record-e2e] ${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
