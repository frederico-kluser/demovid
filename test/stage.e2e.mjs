/**
 * Verificação de ponta a ponta da camada de câmera + overlay, num Brave real.
 *
 * Não é unit test: o que precisa ser provado aqui só existe num motor de layout
 * de verdade — que o top layer escapa do transform, que os `position:fixed` do
 * app sobrevivem à troca de scroller, e que o overlay continua 1:1 com zoom.
 *
 *   node --import tsx test/stage.e2e.mjs
 */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = "/tmp/demovid-e2e-profile";

const bundleSrc = await readFile(join(ROOT, "src/generated/overlay-bundle.ts"), "utf8");
const OVERLAY = JSON.parse(bundleSrc.slice(bundleSrc.indexOf("= ") + 2, bundleSrc.lastIndexOf(";")));

// App de teste com os cinco padrões de `position:fixed` que quebram o R0.
const APP = `<!doctype html><meta charset=utf-8><title>demovid-e2e</title><style>
 body{margin:0;font:14px sans-serif}
 main{height:4000px;padding:70px 20px 0;background:linear-gradient(#fff,#dde)}
 .f{position:fixed;background:#0F172A;color:#fff;font-size:12px;padding:4px}
 #header{top:0;left:0;right:0;height:56px}
 #footer{bottom:0;left:0;right:0;height:48px}
 #sidebar{top:0;left:0;width:180px;height:100%}
 #fab{bottom:24px;right:24px;width:56px;height:56px}
 #centered{top:50%;left:50%;transform:translate(-50%,-50%);width:280px;height:80px}
 #alvo{border:2px solid #3B82F6;border-radius:6px;padding:10px;width:320px;margin:40px 0 0 200px}
</style>
<div class=f id=header>header</div><div class=f id=footer>footer</div>
<div class=f id=sidebar>sidebar</div><div class=f id=fab>fab</div>
<div class=f id=centered>centered</div>
<main><div id=alvo>alvo do zoom — texto pequeno de propósito</div></main>`;

await rm(PROFILE, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: process.env.DEMOVID_BROWSER ?? "/usr/bin/brave-browser",
  headless: false,
  viewport: null,
  reducedMotion: "no-preference",
  args: [
    "--no-sandbox", "--disable-dev-shm-usage",
    "--window-size=1400,900", "--window-position=2200,150",
    "--no-first-run", "--no-default-browser-check",
  ],
});

let failures = 0;

// `fn` may be async, and the result is awaited: a `() => void` contract silently
// accepts an async callback whose rejection never reaches this try/catch, so a
// failing assertion would be reported as a pass. Call sites must `await check`.
const check = async (name, fn) => {
  try {
    await fn();
    console.error(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name}\n      ${e.message.split("\n")[0]}`);
  }
};

try {
  // addInitScript no CONTEXTO, e navegação de verdade: `setContent` não é uma
  // navegação completa, então o init script não roda de forma confiável nele —
  // e `goto` é como a ferramenta vai funcionar contra um dev server.
  await ctx.addInitScript({ content: OVERLAY });
  const APP_FILE = "/tmp/demovid-e2e-app.html";
  await writeFile(APP_FILE, APP, "utf8");

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`file://${APP_FILE}`, { waitUntil: "load" });
  await page.waitForSelector("#alvo", { state: "attached" });

  const RECTS = ["header", "footer", "sidebar", "fab", "centered"];
  const rects = () =>
    page.evaluate(
      (ids) =>
        Object.fromEntries(
          ids.map((id) => {
            const r = document.getElementById(id).getBoundingClientRect();
            return [id, [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]];
          }),
        ),
      RECTS,
    );

  const baseline = await rects();
  const fpBefore = await page.evaluate(() => window.__demovid.fingerprint());

  await check("o bundle expõe window.__demovid", () => {
    assert.ok(fpBefore, "fingerprint vazio");
  });

  const mounted = await page.evaluate(() => window.__demovid.mount());
  await page.waitForTimeout(250);
  await check("mount() monta palco e overlay, e diz a verdade sobre isso", () => {
    assert.ok(mounted.stage, `palco não montou: ${mounted.why ?? "motivo desconhecido"}`);
    assert.ok(mounted.overlay, "overlay não montou");
    assert.ok(mounted.adopted >= 6, `palco adotou só ${mounted.adopted} filhos`);
  });

  const afterMount = await rects();
  await check("os 5 padrões de position:fixed sobrevivem à montagem", () => {
    assert.deepEqual(afterMount, baseline);
  });

  // O teste que mata o R0: rolar. No R1 os fixed têm que ficar parados.
  await page.evaluate(() => document.getElementById("__demovid_stage").scrollTo({ top: 800 }));
  await page.waitForTimeout(250);
  const afterScroll = await rects();
  await check("rolando 800px, os fixed ficam parados (é onde o R0 morre)", () => {
    assert.deepEqual(afterScroll, baseline);
  });

  // Zoom, e a asserção dura.
  const cam = await page.evaluate(() => window.__demovid.cameraFor("#alvo", 1.6));
  await check("cameraFor() resolve o alvo", () => {
    assert.ok(cam && cam.k === 1.6, `câmera inválida: ${JSON.stringify(cam)}`);
  });

  await page.evaluate((c) => window.__demovid.setCamera(c), cam);
  await page.waitForTimeout(300);

  const unscaled = await page.evaluate(() => window.__demovid.assertUnscaled());
  await check("com o palco em 1.6x, o overlay continua 1:1", () => {
    assert.ok(unscaled.ok, unscaled.detail);
  });

  const zoomed = await rects();
  await check("o conteúdo do app realmente escalou", () => {
    const f = zoomed.header[2] / baseline.header[2];
    assert.ok(f > 1.5 && f < 1.7, `header escalou ${f.toFixed(2)}x, esperado ~1.6x`);
  });

  // Voltar à identidade tem que restaurar o layout exatamente.
  await page.evaluate(() => window.__demovid.setCamera({ tx: 0, ty: 0, k: 1 }));
  await page.evaluate(() => document.getElementById("__demovid_stage").scrollTo({ top: 0 }));
  await page.waitForTimeout(300);
  const zoomedBack = await rects();
  await check("voltando à identidade, os rects voltam ao baseline", () => {
    const diff = Object.keys(baseline)
      .filter((k) => JSON.stringify(baseline[k]) !== JSON.stringify(zoomedBack[k]))
      .map((k) => `${k}: ${JSON.stringify(baseline[k])} -> ${JSON.stringify(zoomedBack[k])}`);
    assert.equal(diff.length, 0, diff.join(" | "));
  });

  // Um modal do app abre DEPOIS de nós: o top layer é ordenado por ativação.
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.setAttribute("popover", "manual");
    d.id = "app-modal";
    document.body.appendChild(d);
    d.showPopover();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__demovid.repromote());
  await page.waitForTimeout(200);
  const afterModal = await page.evaluate(() => window.__demovid.assertUnscaled());
  await check("repromote() sobrevive a um popover do próprio app", () => {
    assert.ok(afterModal.ok, afterModal.detail);
  });
} finally {
  await ctx.close();
  await rm(PROFILE, { recursive: true, force: true });
}

console.error(failures === 0 ? "\n[e2e] tudo verde" : `\n[e2e] ${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
