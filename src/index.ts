#!/usr/bin/env node
import "./env.js"; // MUST be first — see src/env.ts
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { doctor } from "./doctor.js";
import { BinaryNotFoundError, CommandFailedError } from "./exec.js";
import { RecError } from "./rec.js";
import { record } from "./record.js";
import { parseStoryboard } from "./storyboard.js";
import { TtsError } from "./openai/tts.js";

const HELP = `demovid — vídeos de demonstração narrados, de qualquer projeto frontend

USAGE
  demovid <command> [options]

COMMANDS
  doctor                      Checa o ambiente: rec, Brave, ffmpeg, X11, chave da OpenAI
  script <dir|url>            O agente explora o app e escreve um demo.yaml de rascunho
  refine <demo.yaml> "<...>"  Descreve em português o que mudar; a IA regenera o YAML
  voice <demo.yaml>           Sintetiza a narração (uma chamada por frase) + manifesto por hash
  rehearse <demo.yaml>        Ensaio: valida seletores e a câmera SEM gravar
  record <demo.yaml>          Grava de verdade e entrega o MP4

OPTIONS
  -o, --out <file>            Caminho de saída ("-" = stdout, onde fizer sentido)
      --preset <name>         boardroom | helpdesk           (padrão: boardroom)
      --camera <rung>         auto | R1 | R2 | R3            (padrão: auto)
      --quality <mode>        smooth | crisp                 (padrão: smooth)
      --locale <tag>          pt-BR | en-US                  (padrão: pt-BR)
      --browser <path>        Executável do browser (padrão: detecta Brave)
  -n, --dry-run               Mostra o que faria e sai
      --deep                  No \`doctor\`: gasta uma chamada mínima pra provar que há saldo
  -v, --verbose               Log detalhado no stderr
  -h, --help                  Esta ajuda

ENVIRONMENT
  OPENAI_API_KEY              Obrigatória para \`script\`, \`refine\` e \`voice\`
  DEMOVID_BROWSER             Sobrescreve o executável do browser
  DEMOVID_REC_DIR             Onde os MP4 são escritos (padrão: ~/Videos)

EXAMPLES
  demovid doctor
  demovid script ~/Projects/meu-app -o demo.yaml
  demovid refine demo.yaml "mais curto, foca no fluxo de login"
  demovid voice demo.yaml
  demovid rehearse demo.yaml
  demovid record demo.yaml --preset helpdesk
`;

const NOT_YET: Record<string, string> = {
  script: "src/openai/script.ts",
  refine: "src/openai/script.ts",
};

/** Carrega e valida um demo.yaml. Erros do zod já nomeiam o passo culpado. */
async function loadStoryboard(path: string): Promise<ReturnType<typeof parseStoryboard>> {
  const raw = await readFile(resolve(path), "utf8");
  return parseStoryboard(parseYaml(raw));
}

async function runRecord(path: string, rehearse: boolean, out: string | undefined): Promise<number> {
  const sb = await loadStoryboard(path);
  const output = out ?? resolve(
    process.env["DEMOVID_REC_DIR"] ?? `${process.env["HOME"]}/Videos`,
    `${basename(path).replace(/\.ya?ml$/, "")}.mp4`,
  );

  const t0 = Date.now();
  const report = await record({
    storyboard: sb,
    output,
    rehearse,
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

  if (rehearse) {
    console.warn(`[demovid] ensaio concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s — nada foi gravado.`);
  } else if (report.output) {
    console.warn(
      `[demovid] pronto: ${report.output} (${(report.bytes / 1024 / 1024).toFixed(1)} MB, ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s)`,
    );
    process.stdout.write(`${report.output}\n`);
  }
  return failed.length > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      preset: { type: "string", default: "boardroom" },
      camera: { type: "string", default: "auto" },
      quality: { type: "string", default: "smooth" },
      locale: { type: "string", default: "pt-BR" },
      browser: { type: "string" },
      "dry-run": { type: "boolean", short: "n", default: false },
      deep: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const cmd = positionals[0];

  if (values.help || cmd === undefined) {
    process.stdout.write(HELP);
    process.exit(values.help ? 0 : 1);
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
      process.exit(await runRecord(file, cmd === "rehearse", values.out));
      break;
    }
    case "voice": {
      const file = positionals[1];
      if (!file) {
        console.error("[demovid] `voice` precisa de um demo.yaml\n");
        process.exit(1);
      }
      // `record --rehearse` já sintetiza tudo e não grava nada; `voice` é o
      // mesmo trabalho sem abrir o browser, então reaproveita o caminho.
      console.error("[demovid] `voice` avulso ainda não existe — use `demovid rehearse`, que já sintetiza.");
      process.exit(2);
      break;
    }
    case "script":
    case "refine": {
      console.error(
        `[demovid] \`${cmd}\` ainda não está implementado — o módulo é ${NOT_YET[cmd]}.\n` +
          `[demovid] Escreva o demo.yaml à mão por enquanto; \`demovid rehearse\` valida.`,
      );
      process.exit(2);
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
