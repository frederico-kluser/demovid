/**
 * The guided flow: `npx demovid` inside a project, and a video comes out.
 *
 *   scan → dev server → crawl → ask → gpt-5.4 → rehearse → approve → record
 *
 * Two things shape the order.
 *
 * **The rehearsal happens before the gate, not after.** Showing the operator a
 * plan they cannot evaluate is worse than not showing it: they would be
 * approving selectors nobody has tried. Rehearsing first means the plan arrives
 * with its own broken steps already marked, and approval is an informed one.
 *
 * **Narration is synthesised during the rehearsal, so it is paid for once.**
 * The content-hash cache in `src/openai/tts.ts` means a revision only re-pays
 * for the sentences that actually changed, which is what makes an iterate-then-
 * approve loop affordable at all.
 */
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { stringify as toYaml } from "yaml";
import { launchBrowser } from "./browser.js";
import { allowedSelectors, crawlApp, serializeInventory } from "./project/inventory.js";
import { ensureDevServer } from "./project/devserver.js";
import { scanProject } from "./project/scan.js";
import { refineStoryboard, writeStoryboard } from "./openai/script.js";
import { askRequired, closePrompt, gate, isInteractive } from "./prompt.js";
import { record, type RecordOptions, type RecordReport } from "./record.js";
import { restore, readJournal } from "./annotate.js";
import type { Storyboard } from "./storyboard.js";

const log = (line: string): void => console.warn(`[demovid] ${line}`);

export interface ScriptFlowOptions {
  dir: string;
  /** Skip the approval gate. */
  yes?: boolean;
  /** Provided instead of asking, for non-interactive use. */
  about?: string | undefined;
  /** Skip the scan and use this URL directly. */
  url?: string | undefined;
  /** Where to write the storyboard. Defaults to `<dir>/demo.yaml`. */
  storyboardPath?: string | undefined;
  /** Everything `record()` takes: resolution, chrome mode, output path. */
  recording: Omit<RecordOptions, "storyboard" | "rehearse" | "onLog">;
}

function printPlan(sb: Storyboard, report: RecordReport): void {
  console.warn("");
  console.warn(`  ${sb.title}`);
  console.warn("");
  for (const [i, step] of sb.steps.entries()) {
    const r = report.steps.find((s) => s.index === i);
    const mark = r ? (r.ok ? "✓" : "✗") : "·";
    console.warn(
      `  ${mark} ${String(i).padStart(2)}. ${step.action.padEnd(7)} ${(step.target ?? "").slice(0, 42).padEnd(42)}`,
    );
    if (step.say) console.warn(`        "${step.say.slice(0, 96)}"`);
    if (r && !r.ok) console.warn(`        ↳ ${r.detail}`);
  }
  const broken = report.steps.filter((s) => !s.ok).length;
  console.warn("");
  console.warn(
    broken === 0
      ? `  ensaio: todos os ${report.steps.length} passos funcionaram.`
      : `  ensaio: ${broken} de ${report.steps.length} passos falharam — dá para pedir correção abaixo.`,
  );
}

export async function scriptFlow(opts: ScriptFlowOptions): Promise<number> {
  const dir = resolve(opts.dir);

  // A journal left behind means a previous run died mid-edit. Undo it before
  // the dev server starts, so HMR never compiles a file with a stale attribute.
  if (await readJournal(dir)) {
    const r = await restore(dir);
    log(`restaurei ${r.reverted} edição(ões) pendentes de uma execução anterior`);
    for (const c of r.conflicts) log(`conflito: ${c}`);
  }

  const scan = await scanProject(dir);
  log(`projeto: ${scan.name} · ${scan.framework} · ${scan.packageManager}`);
  for (const n of scan.notes) log(`  ${n}`);

  const server = opts.url
    ? { url: opts.url, started: false, stop: async (): Promise<void> => {} }
    : await ensureDevServer({ scan, log });

  let exitCode = 0;

  try {
    // ── varredura ─────────────────────────────────────────────────────────
    log("varrendo o app para descobrir o que dá para apontar");
    const probe = await launchBrowser({ probe: true, width: 1440, height: 900 });
    let inventory;
    try {
      inventory = await crawlApp({ page: probe.page, startUrl: server.url, scan, log });
    } finally {
      await probe.close();
    }

    if (inventory.items.length === 0) {
      log("não achei nenhum elemento endereçável — o app pode exigir login.");
      return 1;
    }
    log(`${inventory.items.length} elementos em ${inventory.routes.length} rota(s)`);

    // ── o pedido ──────────────────────────────────────────────────────────
    const request =
      opts.about ??
      (await askRequired(
        "O que você quer demonstrar? Descreva em português, como explicaria para alguém.",
        "descreva a demo em uma ou duas frases.",
      ));

    // ── roteiro ───────────────────────────────────────────────────────────
    const inventoryText = serializeInventory(inventory);
    const allowed = allowedSelectors(inventory);

    let storyboard = await writeStoryboard({
      request,
      inventory: inventoryText,
      allowed,
      appName: scan.name,
      url: server.url,
      log,
    });

    const storyboardPath = opts.storyboardPath ?? resolve(dir, "demo.yaml");

    // ── ensaiar → mostrar → aprovar ───────────────────────────────────────
    for (;;) {
      await writeFile(storyboardPath, toYaml(storyboard), "utf8");
      log(`roteiro em ${storyboardPath}`);

      log("ensaiando (valida cada seletor e sintetiza a narração, sem gravar)");
      const rehearsal = await record({
        ...opts.recording,
        storyboard,
        rehearse: true,
        onLog: log,
      });
      printPlan(storyboard, rehearsal);

      if (opts.yes || !isInteractive()) break;

      const answer = await gate(
        "Enter grava · `n` cancela · ou escreva o que mudar (ex: \"mais curto, comece pela busca\")",
      );
      if (answer.kind === "approve") break;
      if (answer.kind === "abort") {
        log("cancelado. O roteiro ficou salvo — dá para editar à mão e rodar `demovid record`.");
        return 0;
      }

      storyboard = await refineStoryboard({
        current: storyboard,
        instruction: answer.text,
        inventory: inventoryText,
        allowed,
        appName: scan.name,
        url: server.url,
        log,
      });
    }

    // ── gravar ────────────────────────────────────────────────────────────
    const output =
      opts.recording.output ||
      resolve(dir, `${basename(storyboardPath).replace(/\.ya?ml$/, "")}.mp4`);

    const t0 = Date.now();
    const report = await record({ ...opts.recording, storyboard, output, onLog: log });
    const failed = report.steps.filter((s) => !s.ok);

    for (const w of report.warnings) log(`aviso: ${w}`);
    if (report.output) {
      const v = report.video;
      log(
        `pronto: ${report.output} (${(report.bytes / 1024 / 1024).toFixed(1)} MB` +
          (v ? `, ${v.width}x${v.height}, ${(v.durationMs / 1000).toFixed(1)}s` : "") +
          `, ${((Date.now() - t0) / 1000).toFixed(0)}s)`,
      );
      if (report.timeline) log(`timeline: ${report.timeline}`);
      process.stdout.write(`${report.output}\n`);
    }
    exitCode = failed.length > 0 ? 1 : 0;
  } finally {
    closePrompt();
    if (server.started) await server.stop();
    // Undo any source annotation, whatever happened above.
    if (await readJournal(dir)) {
      const r = await restore(dir);
      if (r.reverted > 0) log(`desfiz ${r.reverted} edição(ões) que eu tinha feito no seu código`);
      for (const c of r.conflicts) log(`conflito ao restaurar: ${c}`);
    }
  }

  return exitCode;
}
