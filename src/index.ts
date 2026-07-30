#!/usr/bin/env node
import "./env.js"; // MUST be first — see src/env.ts
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { doctor } from "./doctor.js";
import { BinaryNotFoundError, CommandFailedError } from "./exec.js";
import { importSessionEnv, RecCapabilityError, RecError, resolveBackend } from "./rec.js";
import { restore } from "./annotate.js";
import { isInteractive } from "./prompt.js";
import { record, resolvePreset, type AnimateOptions } from "./record.js";
import { extensionFor, isOutputMode, MODE_CAPS, type OutputMode } from "./output-mode.js";
import { LOCALES } from "./presets/index.js";
import { scriptFlow } from "./scriptflow.js";
import { parseResolutionSpec, planCapture, resolutionNames, type CapturePlan } from "./resolution.js";
import { parseStoryboard } from "./storyboard.js";
import { isVoice, isVoiceEngine, speedFor, TTS_MODEL, TtsError, VOICE_ENGINES, VOICES, type Voice, type VoiceEngine } from "./openai/tts.js";
import { frameExtents, listMonitors, workArea } from "./x11.js";

const HELP = `demovid — vídeos de demonstração narrados, de qualquer projeto frontend

USAGE
  demovid <command> [options]

COMMANDS
  (sem comando)               Dentro de um projeto: varre, pergunta o que demonstrar,
                              escreve o roteiro com IA, ensaia, mostra e grava
  script [dir]                O mesmo, explicitamente (padrão: diretório atual)
  doctor                      Checa o ambiente: gravador, browser, ffmpeg, X11, OpenAI
  rehearse <demo.yaml>        Ensaio: valida seletores e a câmera SEM gravar
  record <demo.yaml>          Grava de verdade e entrega o MP4 + a timeline
  restore [dir]               Desfaz anotações que o demovid tenha deixado no seu código

OPTIONS
  -o, --out <file>            Caminho de saída ("-" = stdout, onde fizer sentido)
      --res <formato>         Resolução da gravação. Aceita um preset, um WxH,
                              ou o nome de um device do Playwright:
                                720p 1080p 1440p desktop square reels mobile tablet
                                1920x1080 · "iPhone 15" · "Pixel 7"
                              Formato que não couber na tela é capturado no maior
                              tamanho possível e ampliado no final.
      --monitor <nome>        Em qual saída gravar (padrão: a primária)
      --chrome <modo>         auto | crop | keep             (padrão: auto)
                              Se a barra do browser entra no vídeo. \`auto\` e
                              \`crop\` a removem — junto com qualquer aviso que o
                              browser resolva mostrar ali — ao custo de um passe
                              de ffmpeg. \`keep\` mantém o passe único puro.
      --format <fmt>          mp4 | gif | webp | remotion    (padrão: mp4)
                              \`gif\`/\`webp\` entregam SÓ a imagem animada, sem voz:
                              nenhuma chamada de TTS, o balão é o único canal, e
                              o arquivo é reduzido tirando quadros até caber no
                              limite. Sem \`--preset\`, usa o preset \`readme\`.
                              \`remotion\` entrega o MP4 mais um projeto Remotion
                              ao lado: o roteiro de edição em JSON, as cenas já
                              cortadas nos pontos de silêncio medidos, transições,
                              frases de impacto — e abre o Studio para preview.
                              Sem \`--preset\`, usa o preset \`comercial\`.
      --max-mb <n>            Teto do gif/webp em MB            (padrão: 5)
      --fps <n>               Quadros por segundo do gif/webp   (padrão: 15)
      --preset <nome>         boardroom | helpdesk | readme | comercial
                                                             (padrão: o do roteiro)
                              Aparência e ritmo: quanta ajuda o espectador precisa.
                              Traz junto a voz, o wpm e as \`instructions\`.
      --locale <tag>          pt-BR | en-US                  (padrão: pt-BR)
      --voice <nome>          Sobrescreve a voz do preset. As de melhor qualidade
                              são \`marin\` e \`cedar\` — as outras onze existem desde
                              o \`tts-1\` e soam como isso.
      --wpm <n>               Palavras por minuto (60–400). Até 140 quem manda é
                              \`instructions\`; acima disso entra o \`speed\`.
      --voice-engine <e>      speech | audio-1.5             (padrão: speech)
                              \`speech\` é /v1/audio/speech: um leitor, barato e
                              verbatim por construção. \`audio-1.5\` é o
                              \`gpt-audio-1.5\` — locução muito mais dirigida, mas é
                              um modelo GENERATIVO (pode parafrasear) e custa ~duas
                              ordens de grandeza mais. Cada frase é conferida contra
                              a transcrição e, na dúvida, cai para \`speech\`.
      --browser <path>        Executável do browser (o mesmo que DEMOVID_BROWSER;
                              padrão: detecta Brave)
  -y, --yes                   Pula o portão de aprovação e grava direto
      --about "<texto>"       O que demonstrar, em vez de perguntar (uso não-interativo)
      --url <url>             Usa esta URL em vez de subir o servidor de dev
  -n, --dry-run               Em \`record\`/\`rehearse\`: resolve saída, preset, voz,
                              captura e gravador, imprime e sai. Não abre browser
                              nem gasta chamada de API.
      --no-open               Com \`--format remotion\`: gera o projeto e NÃO instala
                              nem abre o Studio. Imprime os dois comandos.
      --deep                  No \`doctor\`: gasta uma chamada mínima pra provar que há saldo
  -v, --verbose               Log detalhado no stderr
  -h, --help                  Esta ajuda

ENV
  DEMOVID_RECORDER            gsr | ffmpeg — força o backend de captura

ENVIRONMENT
  OPENAI_API_KEY              Obrigatória para o fluxo guiado (escreve o roteiro) e para a
                              narração. Com \`--format gif|webp\` a narração não é
                              sintetizada, então só o roteiro precisa dela.
  DEMOVID_BROWSER             Sobrescreve o executável do browser
  DEMOVID_REC_DIR             Onde os MP4 são escritos (padrão: ~/Videos)

EXAMPLES
  demovid doctor
  demovid script ~/Projects/meu-app -o demo.yaml
  demovid rehearse demo.yaml
  demovid record demo.yaml --preset helpdesk
  demovid record demo.yaml --format gif
  demovid record demo.yaml --format webp --max-mb 2
  demovid record demo.yaml --voice marin --wpm 165
  demovid record demo.yaml --dry-run
  demovid record demo.yaml --format remotion
`;

type CliValues = {
  out?: string | undefined;
  format?: string | undefined;
  "max-mb"?: string | undefined;
  fps?: string | undefined;
  preset?: string | undefined;
  res?: string | undefined;
  monitor?: string | undefined;
  chrome?: string | undefined;
  yes?: boolean | undefined;
  about?: string | undefined;
  url?: string | undefined;
  voice?: string | undefined;
  wpm?: string | undefined;
  "voice-engine"?: string | undefined;
  "no-open"?: boolean | undefined;
};

/** Build the guided flow's options out of the parsed flags. */
async function runScriptFlow(dir: string, values: CliValues): Promise<number> {
  const capture = await buildCapturePlan(values.res, values.monitor);
  const chrome = values.chrome === "keep" || values.chrome === "crop" ? values.chrome : "auto";
  const mode = resolveOutputMode(values.format);
  const animate = buildAnimate(mode, { maxMb: values["max-mb"], fps: values.fps });
  return scriptFlow({
    dir,
    yes: values.yes ?? false,
    about: values.about,
    url: values.url,
    voice: parseVoiceFlag(values.voice),
    wpm: parseWpmFlag(values.wpm),
    recording: {
      output: values.out ?? "",
      chrome,
      mode,
      openStudio: values["no-open"] !== true,
      ...(parseEngineFlag(values["voice-engine"]) ? { voiceEngine: parseEngineFlag(values["voice-engine"]) } : {}),
      ...(capture ? { capture } : {}),
      ...(animate ? { animate } : {}),
    },
  });
}

/**
 * Carrega e valida um demo.yaml. Erros do zod já nomeiam o passo culpado.
 *
 * `url` relativa resolve contra o diretório do YAML, não contra o cwd. Sem isso
 * um storyboard só funciona da pasta de onde foi escrito — e um caminho absoluto
 * cravado no arquivo o torna intransferível entre máquinas.
 */
async function loadStoryboard(path: string): Promise<ReturnType<typeof parseStoryboard>> {
  const file = resolve(path);
  const raw = await readFile(file, "utf8");
  const sb = parseStoryboard(parseYaml(raw));
  if (!/^[a-z]+:\/\//i.test(sb.url)) {
    sb.url = pathToFileURL(resolve(dirname(file), sb.url)).href;
  }
  return sb;
}

/**
 * Validate `--voice` at the boundary, where the value is still a bare string.
 * Shared by both entry points so the two cannot disagree about what a voice is.
 */
function parseVoiceFlag(v: string | undefined): Voice | undefined {
  if (!v) return undefined;
  if (!isVoice(v)) {
    throw new Error(
      `voz desconhecida: "${v}". Disponíveis: ${VOICES.join(", ")}. ` +
        `As de melhor qualidade são marin e cedar.`,
    );
  }
  return v;
}

/** `--voice-engine`, validated where the value is still a bare string. */
function parseEngineFlag(v: string | undefined): VoiceEngine | undefined {
  if (!v) return undefined;
  if (!isVoiceEngine(v)) {
    throw new Error(`motor de voz desconhecido: "${v}". Use ${VOICE_ENGINES.join(" ou ")}.`);
  }
  return v;
}

function parseWpmFlag(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 60 || n > 400) {
    throw new Error(`--wpm precisa ser um inteiro entre 60 e 400 (recebi "${v}")`);
  }
  return n;
}

interface RunRecordOptions {
  rehearse: boolean;
  out?: string | undefined;
  res?: string | undefined;
  monitor?: string | undefined;
  chrome?: string | undefined;
  preset?: string | undefined;
  locale?: string | undefined;
  format?: string | undefined;
  maxMb?: string | undefined;
  fps?: string | undefined;
  voice?: string | undefined;
  wpm?: string | undefined;
  voiceEngine?: string | undefined;
  dryRun?: boolean | undefined;
  noOpen?: boolean | undefined;
}

/** `--format` → the output mode. Absent means MP4, the behaviour that always was. */
function resolveOutputMode(format: string | undefined): OutputMode {
  const spec = format?.toLowerCase();
  if (!spec) return "mp4";
  if (!isOutputMode(spec)) {
    throw new Error(`formato desconhecido: "${format}". Use mp4, gif, webp ou remotion.`);
  }
  return spec;
}

/**
 * Encoder knobs for `gif`/`webp`, or `undefined` for every other mode.
 *
 * Still `undefined` rather than `{format:"mp4"}`: the GIF encoder runs on the
 * *presence* of this object, so there is no way for a default here to send an MP4
 * through a palette pass.
 */
function buildAnimate(
  mode: OutputMode,
  o: { maxMb?: string | undefined; fps?: string | undefined },
): AnimateOptions | undefined {
  if (mode !== "gif" && mode !== "webp") {
    if (o.maxMb || o.fps) {
      console.warn("[demovid] --max-mb e --fps só valem com --format gif|webp — ignorados");
    }
    return undefined;
  }

  const maxMb = o.maxMb === undefined ? undefined : Number(o.maxMb);
  if (maxMb !== undefined && (!Number.isFinite(maxMb) || maxMb <= 0)) {
    throw new Error(`--max-mb precisa ser um número de MB maior que zero (recebi "${o.maxMb}")`);
  }
  const fps = o.fps === undefined ? undefined : Number(o.fps);
  if (fps !== undefined && (!Number.isInteger(fps) || fps < 1 || fps > 60)) {
    throw new Error(`--fps precisa ser um inteiro entre 1 e 60 (recebi "${o.fps}")`);
  }

  return {
    format: mode,
    ...(maxMb !== undefined ? { maxBytes: Math.round(maxMb * 1024 * 1024) } : {}),
    ...(fps !== undefined ? { fps } : {}),
  };
}

/** `demo.mp4` → `demo.gif`. The recorder's own extension is never the answer here. */
const withExtension = (path: string, ext: string): string => path.replace(/\.[^./]+$/, "") + `.${ext}`;

/**
 * Resolve `--res` into a concrete plan. Returns undefined when the user did not
 * ask for a format, which keeps the historical window size and, with it, the
 * guarantee that nothing is post-processed.
 */
async function buildCapturePlan(
  spec: string | undefined,
  monitorName: string | undefined,
): Promise<CapturePlan | undefined> {
  if (!spec) return undefined;

  const preset = parseResolutionSpec(spec);
  if (!preset) {
    throw new Error(
      `resolução desconhecida: "${spec}". ` +
        `Use um preset (${resolutionNames().join(", ")}), um WxH como 1920x1080, ` +
        `ou o nome de um device do Playwright como "iPhone 15".`,
    );
  }

  const [monitors, area, frame] = await Promise.all([
    listMonitors().catch(() => []),
    workArea(),
    frameExtents(),
  ]);

  return planCapture(preset, {
    monitors,
    area,
    frame,
    ...(monitorName ? { monitorName } : {}),
  });
}

async function runRecord(path: string, o: RunRecordOptions): Promise<number> {
  const sb = await loadStoryboard(path);
  // CLI overrides the storyboard, and only when actually given. These two used
  // to be parsed and thrown away — the flags existed in `--help` and did
  // nothing at all.
  if (o.preset) sb.preset = o.preset;
  if (o.locale) sb.locale = o.locale;
  const voice = parseVoiceFlag(o.voice);
  const wpm = parseWpmFlag(o.wpm);
  const engine = parseEngineFlag(o.voiceEngine);
  if (voice !== undefined) sb.voice = voice;
  if (wpm !== undefined) sb.wpm = wpm;

  const mode = resolveOutputMode(o.format);
  const caps = MODE_CAPS[mode];
  const animate = buildAnimate(mode, o);

  // `--preset` still wins; this only fills the gap. Without it, `--format gif`
  // on any existing storyboard would inherit boardroom's 17px balloon — and in
  // silent output that balloon is the entire message. Logged rather than applied
  // quietly, because a preset the operator did not type is a surprise either way.
  if (caps.requiresPreset && !o.preset && sb.preset !== caps.requiresPreset) {
    console.warn(`[demovid] --format ${mode}: usando o preset ${caps.requiresPreset} (era ${sb.preset})`);
    sb.preset = caps.requiresPreset;
  }

  const ext = extensionFor(mode);
  const output = o.out
    ? (mode === "mp4" ? o.out : withExtension(o.out, ext))
    : resolve(
        process.env["DEMOVID_REC_DIR"] ?? `${process.env["HOME"]}/Videos`,
        `${basename(path).replace(/\.ya?ml$/, "")}.${ext}`,
      );

  const capture = await buildCapturePlan(o.res, o.monitor);
  if (capture) {
    console.warn(
      `[demovid] formato: ${capture.label} → janela ${capture.window.w}x${capture.window.h} ` +
        `em ${capture.monitor} (dsf ${capture.deviceScaleFactor}, viewport ` +
        `${capture.cssViewport.w}x${capture.cssViewport.h}${capture.mobile ? ", mobile" : ""})`,
    );
  }

  const chrome = o.chrome === "keep" || o.chrome === "crop" ? o.chrome : "auto";

  // `--dry-run` was parsed and never read. It resolves everything that can be
  // resolved without touching the screen — preset, voice, output path, capture
  // plan, which encoder would be picked — and stops there. Nothing here launches
  // a browser or spends an API call, which is the whole point of asking.
  if (o.dryRun) {
    const preset = resolvePreset(sb, (w) => console.warn(`[demovid] aviso: ${w}`));
    const backend = await resolveBackend().catch((e: unknown) => ({ why: `indisponível (${(e as Error).message})` }));
    process.stdout.write(
      [
        `storyboard    ${path} — ${sb.steps.length} passo(s), "${sb.title}"`,
        `url           ${sb.url}`,
        `saída         ${output} (${ext})`,
        `preset        ${sb.preset} · locale ${sb.locale}`,
        `voz           ${preset.voice.voice} · ${preset.voice.targetWpm} wpm · speed ${speedFor(preset.voice.targetWpm)}`,
        `motor de voz  ${engine ?? "speech"} · modelo ${engine === "audio-1.5" ? "gpt-audio-1.5" : TTS_MODEL}`,
        `captura       ${capture ? `${capture.label} → ${capture.window.w}x${capture.window.h}` : "janela histórica 1600x1000"}`,
        `gravador      ${backend.why}`,
        `chrome        ${chrome}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  const t0 = Date.now();
  const report = await record({
    storyboard: sb,
    output,
    rehearse: o.rehearse,
    chrome,
    mode,
    openStudio: o.noOpen !== true,
    ...(engine ? { voiceEngine: engine } : {}),
    ...(capture ? { capture } : {}),
    ...(animate ? { animate } : {}),
    onLog: (l) => console.warn(`[demovid] ${l}`),
  });

  const failed = report.steps.filter((s) => !s.ok);
  console.warn("");
  for (const s of report.steps) {
    const mark = s.ok ? "✓" : "✗";
    console.warn(
      `  ${mark} ${String(s.index).padStart(2)}. ${s.action.padEnd(7)} ` +
        `${(s.target ?? "").slice(0, 40).padEnd(40)} ${(s.ms / 1000).toFixed(1)}s` +
        (s.detail ? `\n       ${s.detail}` : ""),
    );
  }
  console.warn("");
  console.warn(`[demovid] câmera: ${report.cameraRung}${report.cameraRung === "R3" ? " (sem zoom)" : ""}`);
  for (const w of report.warnings) console.warn(`[demovid] aviso: ${w}`);

  if (o.rehearse) {
    console.warn(`[demovid] ensaio concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s — nada foi gravado.`);
  } else if (report.output) {
    const v = report.video;
    console.warn(
      `[demovid] pronto: ${report.output} (${(report.bytes / 1024 / 1024).toFixed(1)} MB, ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s` +
        (v ? `, ${v.width}x${v.height} @${v.fps}fps, ${(v.durationMs / 1000).toFixed(1)}s` : "") +
        `)`,
    );
    if (report.timeline) console.warn(`[demovid] timeline: ${report.timeline}`);
    if (report.remotion) {
      console.warn(`[demovid] projeto Remotion: ${report.remotion.dir}`);
      console.warn(`[demovid] roteiro de edição: ${report.remotion.edl}`);
      if (report.remotion.url) console.warn(`[demovid] Studio: ${report.remotion.url}`);
    }
    // Ouvir antes de publicar não é formalidade: nada medido prova que
    // `instructions` trava o sotaque em pt-BR.
    if (report.remotion || MODE_CAPS[mode].voice) {
      const overlay = LOCALES[sb.locale as keyof typeof LOCALES];
      if (overlay?.requireHumanListen) {
        console.warn(`[demovid] ouça antes de publicar: ${sb.locale} tem deriva de sotaque relatada e não verificada`);
      }
    }
    process.stdout.write(`${report.output}\n`);
  }
  return failed.length > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  // Before anything reads DISPLAY. When demovid runs from a shell that did not
  // inherit the graphical session — an agent, a cron job — both the recorder
  // AND the browser are blind without this, and the resulting error names
  // neither of them.
  await importSessionEnv();

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      res: { type: "string" },
      monitor: { type: "string" },
      chrome: { type: "string", default: "auto" },
      // `preset` and `locale` have no default on purpose: absent means "use
      // what the storyboard says", and a default here would silently override
      // the YAML on every run.
      preset: { type: "string" },
      locale: { type: "string" },
      // Mesma razão: ausente significa "a voz que o preset escolheu".
      voice: { type: "string" },
      wpm: { type: "string" },
      "voice-engine": { type: "string" },
      // Sem default, como `preset` e `locale`: ausente significa "MP4, o
      // comportamento de sempre", e um default aqui é uma flag que age sozinha.
      format: { type: "string" },
      "max-mb": { type: "string" },
      fps: { type: "string" },
      browser: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      about: { type: "string" },
      url: { type: "string" },
      "dry-run": { type: "boolean", short: "n", default: false },
      "no-open": { type: "boolean", default: false },
      deep: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const cmd = positionals[0];

  // `--browser` was parsed and thrown away. It is documented as overriding the
  // executable, and `DEMOVID_BROWSER` is exactly that override — so the flag
  // becomes the env var rather than a second resolution path to keep in sync.
  if (values.browser) process.env["DEMOVID_BROWSER"] = values.browser;

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  // `npx demovid` with no arguments is the guided flow — but only when there is
  // someone there to answer it. Behind a pipe or in CI, blocking on a read that
  // never returns would look like a hang, so print the help instead.
  if (cmd === undefined) {
    if (!isInteractive() && !values.about) {
      console.error("[demovid] sem terminal interativo — use `--about \"...\"` ou veja a ajuda.\n");
      process.stdout.write(HELP);
      process.exit(1);
    }
    process.exit(await runScriptFlow(process.cwd(), values));
  }

  switch (cmd) {
    case "doctor": {
      const ok = await doctor({ verbose: values.verbose, deep: values.deep });
      process.exit(ok ? 0 : 1);
      break;
    }
    case "rehearse":
    case "record": {
      const file = positionals[1];
      if (!file) {
        console.error(`[demovid] \`${cmd}\` precisa de um demo.yaml\n`);
        process.stdout.write(HELP);
        process.exit(1);
      }
      process.exit(
        await runRecord(file, {
          rehearse: cmd === "rehearse",
          out: values.out,
          res: values.res,
          monitor: values.monitor,
          chrome: values.chrome,
          preset: values.preset,
          locale: values.locale,
          format: values.format,
          maxMb: values["max-mb"],
          fps: values.fps,
          voice: values.voice,
          wpm: values.wpm,
          voiceEngine: values["voice-engine"],
          dryRun: values["dry-run"],
          noOpen: values["no-open"],
        }),
      );
      break;
    }
    case "script": {
      process.exit(await runScriptFlow(positionals[1] ?? process.cwd(), values));
      break;
    }
    case "restore": {
      const dir = resolve(positionals[1] ?? process.cwd());
      const r = await restore(dir);
      console.error(
        `[demovid] ${r.reverted} edição(ões) desfeita(s), ${r.alreadyGone} já não existiam.`,
      );
      for (const c of r.conflicts) console.error(`[demovid] conflito: ${c}`);
      process.exit(r.conflicts.length > 0 ? 1 : 0);
      break;
    }
    default:
      console.error(`[demovid] comando desconhecido: ${cmd}\n`);
      process.stdout.write(HELP);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  if (
    err instanceof BinaryNotFoundError ||
    err instanceof CommandFailedError ||
    err instanceof RecError ||
    err instanceof RecCapabilityError ||
    err instanceof TtsError
  ) {
    console.error(`[demovid] ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`[demovid] ${err.message}`);
  } else {
    console.error("[demovid] erro inesperado:", err);
  }
  process.exit(1);
});
