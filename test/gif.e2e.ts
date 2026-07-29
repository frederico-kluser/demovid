/**
 * O encoder de imagem animada, contra o ffmpeg de verdade.
 *
 * Não é unit test e não está em `test/*.test.ts` de propósito: chama um binário
 * externo e escreve arquivos, e a suíte barata tem que continuar rodando sem
 * display, sem browser e sem chave de API. Mas também NÃO precisa de display nem
 * de browser — a fonte é sintetizada pelo próprio ffmpeg (`lavfi`), então isto
 * roda em qualquer máquina que tenha ffmpeg.
 *
 *   node --import tsx test/gif.e2e.ts
 *
 * O que só um encode real prova:
 *  - que a cadeia de filtros é aceita (um `-lavfi` inválido é erro de runtime,
 *    e o typecheck não olha para strings);
 *  - que o laço de orçamento realmente reduz bytes ao descer de degrau;
 *  - que o arquivo resultante é do formato que foi pedido.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/exec.js";
import { encodeAnimation } from "../src/gif.js";

let failures = 0;

// Mesmo contrato do harness de `stage.e2e.mjs`: `fn` pode ser async e o
// resultado é aguardado. Uma assinatura `() => void` aceita um callback async
// calado, e a rejeição dele mata o processo ANTES do `finally` — o que deixaria
// o diretório temporário para trás.
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    console.error(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(e as Error).message.split("\n")[0]}`);
  }
};

const dir = await mkdtemp(join(tmpdir(), "demovid-gif-e2e-"));

try {
  // Fonte com movimento de verdade: `testsrc` muda em todo quadro, que é o pior
  // caso para GIF e portanto o caso que mede o orçamento com honestidade.
  const src = join(dir, "src.mp4");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", src,
  ]);

  const gif = await encodeAnimation({ input: src, output: join(dir, "a.gif"), format: "gif" });
  await check("gif: encoda e fica dentro do teto de 5 MB", () => {
    assert.ok(gif.withinBudget, `ficou em ${(gif.bytes / 1024 / 1024).toFixed(2)} MB`);
    assert.equal(gif.attempts, 1, "não deveria ter precisado tirar quadros");
    assert.equal(gif.fps, 15);
  });

  await check("gif: o arquivo é mesmo um GIF, com as dimensões pedidas", async () => {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width", "-of", "csv=p=0", join(dir, "a.gif"),
    ]);
    assert.match(stdout, /^gif,960/, `ffprobe disse "${stdout.trim()}"`);
  });

  const webp = await encodeAnimation({ input: src, output: join(dir, "a.webp"), format: "webp" });
  await check("webp: sai muito menor que o gif no mesmo clipe", () => {
    // Medido nesta máquina: ~0.10 MB contra ~1.08 MB num clipe de 3s. A asserção
    // é frouxa de propósito (só "menor"), porque a razão depende do conteúdo —
    // mas a ordem nunca se inverte, e é isso que justifica oferecer o webp.
    assert.ok(webp.bytes < gif.bytes, `webp ${webp.bytes} não é menor que gif ${gif.bytes}`);
  });

  // ── o laço de orçamento ───────────────────────────────────────────────────
  const squeezed = await encodeAnimation({
    input: src,
    output: join(dir, "tiny.gif"),
    format: "gif",
    maxBytes: 50 * 1024, // inalcançável de propósito: exercita a escala inteira
  });

  await check("orçamento apertado: desce a escala inteira e admite que não caiu", () => {
    assert.equal(squeezed.withinBudget, false, "não pode alegar sucesso com o teto estourado");
    assert.equal(squeezed.fps, 5, "tinha que ter parado no piso da escala");
    assert.ok(squeezed.attempts > 1, "não tentou reduzir");
  });

  await check("tirar quadros de fato tira bytes", () => {
    // A propriedade que o mecanismo inteiro assume. Se isto falhasse, o laço
    // estaria gastando encodes sem chegar a lugar nenhum.
    assert.ok(
      squeezed.bytes < gif.bytes,
      `a 5fps deu ${squeezed.bytes} bytes, a 15fps deu ${gif.bytes}`,
    );
  });

  await check("o arquivo pedido existe no fim, mesmo fora do orçamento", async () => {
    // Entregar um GIF grande com um aviso é mais útil que não entregar nada.
    const st = await stat(join(dir, "tiny.gif"));
    assert.ok(st.size > 0);
  });

  await check("a paleta temporária não fica para trás", async () => {
    const { stdout } = await run("ls", ["-a", dir]);
    assert.ok(!stdout.includes("demovid-palette"), `sobrou paleta em ${dir}:\n${stdout}`);
  });
} finally {
  // Incondicional. Nunca sob um `if`: o estado que o teste consulta é
  // exatamente o que pode estar errado.
  await rm(dir, { recursive: true, force: true });
}

console.error(failures === 0 ? "\n[gif e2e] tudo verde" : `\n[gif e2e] ${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
