#!/usr/bin/env node
import "./env.js"; // MUST be first — see src/env.ts
import { parseArgs } from "node:util";
import { doctor } from "./doctor.js";
import { BinaryNotFoundError, CommandFailedError } from "./exec.js";
import { RecError } from "./rec.js";

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
  voice: "src/openai/tts.ts",
  rehearse: "src/rehearse.ts",
  record: "src/record.ts",
};

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
    case "script":
    case "refine":
    case "voice":
    case "rehearse":
    case "record": {
      console.error(
        `[demovid] \`${cmd}\` ainda não está implementado — o módulo é ${NOT_YET[cmd]}.\n` +
          `[demovid] Rode \`demovid doctor\` para conferir o ambiente enquanto isso.`,
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
  if (err instanceof BinaryNotFoundError || err instanceof CommandFailedError || err instanceof RecError) {
    console.error(`[demovid] ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`[demovid] ${err.message}`);
  } else {
    console.error("[demovid] erro inesperado:", err);
  }
  process.exit(1);
});
