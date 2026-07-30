/**
 * The guided flow: `npx demovid` inside a project, and a video comes out.
 *
 *   scan → configure → dev server → crawl → ask → gpt-5.4 → rehearse → approve → record
 *
 * Three things shape the order.
 *
 * **Configuration is deterministic first, agent second.** `scan.ts` answers most
 * projects from their manifests and build config, for free and instantly. The
 * `pi` agent is asked only for what no file states plainly — and its answer is
 * cached in the project's `.demovid.json`, so it is asked once per project
 * rather than once per run. When the scan is confident the agent's infrastructure
 * answer is discarded in favour of the measured one; the agent is still worth
 * asking, because authentication and "what is worth showing" have no deterministic
 * source at all.
 *
 * Two more things shape the order.
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
import { run } from "./exec.js";
import { launchBrowser } from "./browser.js";
import { defaultWindowOrigin } from "./x11.js";
import { allowedSelectors, crawlApp, serializeInventory } from "./project/inventory.js";
import { ensureDevServer, type DevOverride } from "./project/devserver.js";
import { hasGitRepo, scanProject, type ProjectScan } from "./project/scan.js";
import { CONFIG_FILE, fingerprint, readConfig, writeConfig, type DiscoveredConfig, type ProjectConfig } from "./project/config.js";
import { discoverProject, DiscoveryError } from "./project/discover.js";
import { refineStoryboard, writeStoryboard } from "./openai/script.js";
import { ask, askRequired, closePrompt, gate, isInteractive } from "./prompt.js";
import { record, type RecordOptions, type RecordReport } from "./record.js";
import { restore, readJournal } from "./annotate.js";
import { extensionFor, MODE_CAPS, type OutputMode } from "./output-mode.js";
import type { Storyboard } from "./storyboard.js";
import type { Voice } from "./openai/tts.js";

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
  /** `--voice` / `--wpm`, stamped onto the generated storyboard. */
  voice?: Voice | undefined;
  wpm?: number | undefined;
  /** `--no-discover`: never call the agent, even when the scan is unsure. */
  noDiscover?: boolean | undefined;
  /** Skip the prepare step even when config has commands. */
  skipPrepare?: boolean | undefined;
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

/** The dev command the scan itself proves, for a project it understood. */
function devFromScan(scan: ProjectScan): DevOverride {
  return {
    bin: scan.packageManager,
    args: ["run", scan.script ?? "dev"],
    cwd: ".",
    url: `http://localhost:${scan.port}`,
    readyTimeoutMs: 90_000,
  };
}

/**
 * Resolve the project's configuration: cache, then agent, then nothing.
 *
 * Returns null when demovid should just use the scan — which is the right answer
 * whenever the agent is unavailable and the scan was confident enough to stand
 * on its own. The failure is only fatal the other way round: a project whose
 * framework was not recognised has no working default to fall back to, and that
 * is the case the operator asked to fail loudly.
 */
async function configureProject(
  scan: ProjectScan,
  opts: { noDiscover: boolean; log: (l: string) => void },
): Promise<ProjectConfig | null> {
  const { log } = opts;
  const fp = await fingerprint(scan.dir, scan.workspaces);

  const { config, stale } = await readConfig(scan.dir, fp);
  if (config) {
    log(`configuração de ${CONFIG_FILE} (edite à mão se algo estiver errado)`);
    return config;
  }
  if (stale) log(`${CONFIG_FILE} descreve outras dependências — vou descobrir de novo`);

  if (opts.noDiscover) {
    if (!scan.confident) {
      throw new Error(
        `não reconheci este projeto e \`--no-discover\` proíbe perguntar ao agente. ` +
          `Passe \`--url <url do app>\`.`,
      );
    }
    return null;
  }

  let discovered: DiscoveredConfig;
  try {
    discovered = await discoverProject({ scan, log });
  } catch (err: unknown) {
    // Fatal only when nothing else can answer. With a confident scan the run
    // continues without suggestions rather than refusing to record at all.
    if (!scan.confident || !(err instanceof DiscoveryError)) throw err;
    log(`aviso: ${err.message}`);
    log("sigo com o que descobri sozinho — sem sugestões de demo e sem checagem de login");
    return null;
  }

  // A measured port and a proven script outrank the agent's reading of them.
  // The agent is authoritative only where nothing measured it.
  const effective: DiscoveredConfig = scan.confident
    ? { ...discovered, framework: scan.framework, dev: devFromScan(scan) }
    : discovered;

  const written = await writeConfig(scan.dir, effective, fp);
  log(`configuração salva em ${CONFIG_FILE} — a próxima execução não precisa perguntar de novo`);
  for (const n of effective.notes) log(`  ${n}`);
  return written;
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

  // ── o projeto existe? ──────────────────────────────────────────────────
  const [isGit, scan] = await Promise.all([hasGitRepo(dir), scanProject(dir)]);
  if (!isGit) {
    log("não achei repositório git aqui. Rode dentro de um projeto com git.");
    return 1;
  }
  if (!scan.hasPkg) {
    log("não achei package.json. Rode dentro de um projeto frontend.");
    return 1;
  }

  log(`projeto: ${scan.name} · ${scan.framework} · ${scan.packageManager}`);
  for (const n of scan.notes) log(`  ${n}`);

  // `--url` says the app is already up, so there is nothing to configure and
  // nothing to start. Skipping discovery here is what keeps the escape hatch
  // that every error message in this path points at.
  const config = opts.url
    ? null
    : await configureProject(scan, { noDiscover: opts.noDiscover ?? false, log });

  if (config?.auth.required) {
    log(`este app exige login${config.auth.how ? `: ${config.auth.how}` : ""}`);
    if (config.auth.username) {
      log(`  credencial de dev encontrada: ${config.auth.username} / ${config.auth.password ?? "?"}`);
    }
  }

  // ── preparação ─────────────────────────────────────────────────────────
  if (!opts.skipPrepare && config?.prepare?.commands.length) {
    log("preparando dados de demonstração");
    for (const cmd of config.prepare.commands) {
      const cwd = resolve(dir, cmd.cwd);
      log(`  $ ${cmd.bin} ${cmd.args.join(" ")}`);
      await run(cmd.bin, cmd.args, { cwd });
    }
  }

  const server = opts.url
    ? { url: opts.url, started: false, stop: async (): Promise<void> => {} }
    : await ensureDevServer({ scan, log, ...(config ? { override: config.dev } : {}) });

  // Ctrl+C must not orphan the dev server. `finally` does not run on a signal,
  // and the orphan then holds the port — so the next run adopts a server nobody
  // owns, which is how a stale build ends up in someone's video. Measured: a
  // SIGTERM'd run left `npm run dev` alive holding 5271/5273.
  const onSignal = (sig: NodeJS.Signals): void => {
    log(`recebi ${sig} — encerrando`);
    void (async (): Promise<void> => {
      closePrompt();
      if (server.started) await server.stop();
      process.exit(130);
    })();
  };
  if (server.started) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  let exitCode = 0;

  try {
    // ── varredura ─────────────────────────────────────────────────────────
    log("varrendo o app para descobrir o que dá para apontar");
    // A start route the agent identified — a dashboard behind `/`, say — beats
    // the server's root, which for some apps is a redirect stub with nothing on it.
    const startUrl =
      config && config.startRoute && config.startRoute !== "/"
        ? new URL(config.startRoute, server.url).href
        : server.url;
    const origin = await defaultWindowOrigin();
    const probe = await launchBrowser({ probe: true, width: 1440, height: 900, x: origin.x, y: origin.y });
    let inventory;
    try {
      inventory = await crawlApp({ page: probe.page, startUrl, scan, log });
    } finally {
      await probe.close();
    }

    if (inventory.items.length === 0) {
      // The generic version of this message ("o app pode exigir login") sent
      // people looking for a login that was often not the problem. When the
      // agent actually checked, say what it found instead of speculating.
      if (config?.auth.required) {
        log("não achei nenhum elemento endereçável, e este app exige login.");
        if (config.auth.how) log(`  ${config.auth.how}`);
        log("  demovid ainda não faz login sozinho — suba o app já autenticado e use --url.");
      } else {
        log("não achei nenhum elemento endereçável — o app pode exigir login.");
      }
      return 1;
    }
    log(`${inventory.items.length} elementos em ${inventory.routes.length} rota(s)`);

    // ── o pedido ──────────────────────────────────────────────────────────
    // The agent's suggestion is offered, never imposed: Enter takes it, anything
    // typed replaces it. It exists because the hardest part of this prompt is
    // starting from a blank line in someone else's codebase — not because a model
    // knows better than the operator what their demo is about.
    const suggestion = config?.suggestions[0];
    const request =
      opts.about ??
      (suggestion && isInteractive()
        ? (await ask(
            `O que você quer demonstrar? Descreva em português, como explicaria para alguém.\n` +
              `Sugestão do pi (Enter aceita, ou escreva a sua):\n  ${suggestion}` +
              (config && config.suggestions.length > 1
                ? `\nOutras ideias: ${config.suggestions.slice(1).join(" · ")}`
                : ""),
          )) || suggestion
        : await askRequired(
            "O que você quer demonstrar? Descreva em português, como explicaria para alguém.",
            "descreva a demo em uma ou duas frases.",
          ));

    // ── formato ───────────────────────────────────────────────────────────
    // O modo de saída é o que define o produto, e o produto define o texto: sem
    // voz, o modelo escreve `caption` (o balão é o único canal) em vez de só
    // `say`. Derivado do modo em vez de ser um parâmetro próprio para que não
    // exista o estado incoerente "roteiro de GIF, gravação de vídeo".
    let mode: OutputMode | undefined =
      opts.recording.mode ?? opts.recording.animate?.format;
    if (!mode && isInteractive()) {
      const choice = await ask(
        "Formato de saída?\n" +
          "  [r] remotion — MP4 + projeto editável (voz, transições, frases de impacto)\n" +
          "  [m] mp4      — vídeo narrado (padrão)\n" +
          "  [g] gif      — animação silenciosa com balão de texto\n" +
          "Enter = mp4",
      );
      const key = choice.trim().toLowerCase();
      mode = key === "r" || key === "remotion" ? "remotion"
        : key === "g" || key === "gif" ? "gif"
        : "mp4";
      log(`formato: ${mode}`);
    }
    mode ??= "mp4";
    // Stamp the choice into opts so the recording phase sees it.
    opts.recording.mode = mode;
    // When the user picks an animated format interactively, build the encoder
    // options that `record()` needs — otherwise the GIF pass is skipped and an
    // MP4 comes out instead.
    if ((mode === "gif" || mode === "webp") && !opts.recording.animate) {
      opts.recording.animate = { format: mode };
    }

    const silent = !MODE_CAPS[mode].voice;

    // ── roteiro ───────────────────────────────────────────────────────────
    const inventoryText = serializeInventory(inventory);
    const allowed = allowedSelectors(inventory);

    let storyboard = await writeStoryboard({
      request,
      inventory: inventoryText,
      allowed,
      appName: scan.name,
      url: server.url,
      silent,
      log,
    });

    // The model never chooses a voice (the field is absent from its JSON Schema),
    // so `--voice` / `--wpm` are applied here — before the storyboard is written,
    // so the YAML the operator ends up holding records the choice instead of
    // depending on the flag being typed again next time.
    if (opts.voice !== undefined) storyboard.voice = opts.voice;
    if (opts.wpm !== undefined) storyboard.wpm = opts.wpm;

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
        silent,
        log,
      });
    }

    // ── gravar ────────────────────────────────────────────────────────────
    const ext = extensionFor(mode);
    const output =
      opts.recording.output ||
      resolve(dir, `${basename(storyboardPath).replace(/\.ya?ml$/, "")}.${ext}`);

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
      if (report.remotion) {
        log(`projeto Remotion: ${report.remotion.dir}`);
        log(`roteiro de edição: ${report.remotion.edl}`);
        if (report.remotion.url) log(`Studio: ${report.remotion.url}`);
      }
      process.stdout.write(`${report.output}\n`);
    }
    exitCode = failed.length > 0 ? 1 : 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
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
