/**
 * Unit tests for project configuration — the layer that decides how to start an
 * app and where to look for it.
 *
 * Every assertion here is a regression of one real failure, measured 2026-07-30
 * on GitCraque: `npx demovid` reported `desconhecido`, guessed port 3000, waited
 * 90s while Vite served the app on 5273, and killed the operator's dev server.
 * Three independent defects had to line up for that, so each is pinned
 * separately — fixing one and reintroducing another would otherwise look green.
 *
 * The agent call itself is not here: it spends money and needs the network. What
 * IS here is the parsing of its answer, because a stream misread is the failure
 * that looks like "the model said nothing".
 *
 *   node --import tsx --test test/project-config.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expandWorkspaces, portFromConfigSource, scanProject } from "../src/project/scan.js";
import { portInUse, portOfUrl, urlsFromOutput, waitForServer } from "../src/project/devserver.js";
import { extractJsonObject, extractPiText } from "../src/project/discover.js";
import { fingerprint, readConfig, writeConfig } from "../src/project/config.js";

/** A throwaway project tree. Returned path is absolute. */
async function fixture(
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "demovid-scan-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ── o framework mora no workspace, não na raiz ────────────────────────────────

test("o front-end de um monorepo é achado no workspace, não na raiz", async () => {
  // O caso GitCraque: a raiz depende só de `ws`, e React/Vite estão em web/.
  // Casar framework só contra a raiz devolvia `desconhecido`.
  const { dir, cleanup } = await fixture({
    "package.json": JSON.stringify({
      name: "gitcraque",
      workspaces: ["server", "web"],
      scripts: { dev: "node scripts/dev.mjs" },
      dependencies: { ws: "^8.18.0" },
    }),
    "server/package.json": JSON.stringify({ name: "@x/server" }),
    "web/package.json": JSON.stringify({ name: "@x/web", devDependencies: { vite: "^7.1.4" } }),
    "web/vite.config.ts": "export default { server: { port: 5273, strictPort: true } }",
  });
  try {
    const scan = await scanProject(dir);
    assert.equal(scan.framework, "vite");
    assert.equal(scan.webDir, join(dir, "web"));
    assert.deepEqual(scan.workspaces, ["server", "web"]);
    assert.equal(scan.confident, true);
  } finally {
    await cleanup();
  }
});

test("a porta vem do vite.config do workspace, não da tabela de defaults", async () => {
  // 5273 está escrito no config; 5173 é o default do vite e 3000 o do
  // `desconhecido`. Qualquer um dos dois faz o demovid esperar sozinho.
  const { dir, cleanup } = await fixture({
    "package.json": JSON.stringify({
      name: "gitcraque",
      workspaces: ["web"],
      scripts: { dev: "node scripts/dev.mjs" },
      dependencies: { ws: "^8.18.0" },
    }),
    "web/package.json": JSON.stringify({ name: "@x/web", devDependencies: { vite: "^7.1.4" } }),
    "web/vite.config.ts": "export default { server: { port: 5273 } }",
  });
  try {
    const scan = await scanProject(dir);
    assert.equal(scan.port, 5273);
    assert.equal(scan.portSource, "config");
  } finally {
    await cleanup();
  }
});

test("a raiz vence o workspace quando os dois têm framework", async () => {
  // Um monorepo cujo app É a raiz não pode ser reatribuído a um membro que por
  // acaso também depende de vite (um pacote de componentes, por exemplo).
  const { dir, cleanup } = await fixture({
    "package.json": JSON.stringify({
      name: "app",
      workspaces: ["ui"],
      scripts: { dev: "next dev" },
      dependencies: { next: "^15.0.0" },
    }),
    "ui/package.json": JSON.stringify({ name: "@x/ui", devDependencies: { vite: "^7.0.0" } }),
  });
  try {
    const scan = await scanProject(dir);
    assert.equal(scan.framework, "next");
    assert.equal(scan.webDir, dir);
  } finally {
    await cleanup();
  }
});

test("um projeto sem monorepo continua sendo lido como antes", async () => {
  const { dir, cleanup } = await fixture({
    "package.json": JSON.stringify({
      name: "app",
      scripts: { dev: "next dev" },
      dependencies: { next: "^15.0.0" },
    }),
  });
  try {
    const scan = await scanProject(dir);
    assert.equal(scan.framework, "next");
    assert.equal(scan.port, 3000);
    assert.equal(scan.portSource, "default");
    assert.deepEqual(scan.workspaces, []);
    assert.equal(scan.confident, true);
  } finally {
    await cleanup();
  }
});

test("a porta escrita no script vence a do arquivo de config", async () => {
  const { dir, cleanup } = await fixture({
    "package.json": JSON.stringify({
      name: "app",
      scripts: { dev: "vite --port 4444" },
      devDependencies: { vite: "^7.0.0" },
    }),
    "vite.config.ts": "export default { server: { port: 5273 } }",
  });
  try {
    const scan = await scanProject(dir);
    assert.equal(scan.port, 4444);
    assert.equal(scan.portSource, "script");
  } finally {
    await cleanup();
  }
});

test("um projeto que o scan não reconhece não se declara confiante", async () => {
  // `confident: false` é o que manda o projeto para o agente. Um falso positivo
  // aqui faz o demovid subir com um palpite em vez de perguntar.
  const { dir, cleanup } = await fixture({
    "package.json": JSON.stringify({ name: "app", scripts: { dev: "node server.js" } }),
  });
  try {
    const scan = await scanProject(dir);
    assert.equal(scan.framework, "desconhecido");
    assert.equal(scan.confident, false);
  } finally {
    await cleanup();
  }
});

test("workspaces com glob expandem só para diretórios que têm manifesto", async () => {
  const { dir, cleanup } = await fixture({
    "packages/a/package.json": "{}",
    "packages/b/package.json": "{}",
    "packages/nao-e-pacote/leia.md": "sem package.json",
  });
  try {
    assert.deepEqual(await expandWorkspaces(dir, ["packages/*"]), ["packages/a", "packages/b"]);
  } finally {
    await cleanup();
  }
});

// ── a porta do config ────────────────────────────────────────────────────────

test("a porta é lida do bloco server, e um proxy vizinho não confunde", () => {
  const source = `export default defineConfig({
    resolve: { alias: { "@": "./src" } },
    server: {
      port: 5273,
      strictPort: true,
      proxy: { "/api": { target: "http://127.0.0.1:5271" } },
    },
  })`;
  assert.equal(portFromConfigSource(source), 5273);
});

test("uma porta fora do bloco server é ignorada em vez de chutada", () => {
  // `preview.port` é a armadilha: o valor existe, parece uma porta, e nada
  // escuta nele durante `dev`. Devolver null deixa o default agir — e o
  // default, ao contrário deste, perde para a URL que o servidor anuncia.
  assert.equal(portFromConfigSource("export default { preview: { port: 4173 } }"), null);
  assert.equal(portFromConfigSource("export default { plugins: [react()] }"), null);
});

// ── a corrida entre o palpite e o que o servidor anuncia ─────────────────────

test("todas as URLs anunciadas são coletadas, não só a primeira", () => {
  // Um `dev` que sobe API e front anuncia duas. Ficar com a primeira é como se
  // escolhia a API.
  assert.deepEqual(
    urlsFromOutput("api em http://127.0.0.1:5271\n  ➜  Local: http://localhost:5273/"),
    ["http://127.0.0.1:5271", "http://localhost:5273/"],
  );
});

test("a porta implícita de uma URL sai do protocolo", () => {
  assert.equal(portOfUrl("http://localhost:5273/"), 5273);
  assert.equal(portOfUrl("http://localhost"), 80);
  assert.equal(portOfUrl("https://localhost"), 443);
  assert.equal(portOfUrl("nao e uma url"), null);
});

test("um palpite vindo de evidência vence a URL anunciada primeiro", async () => {
  // GitCraque anuncia a API (5271) antes do Vite (5273), e 5273 veio do
  // vite.config. Preferir o anúncio aqui grava a API em vez do app.
  const listening = new Set([5271, 5273]);
  const url = await waitForServer(
    { port: 5273, trusted: true },
    () => ["http://127.0.0.1:5271"],
    1_000,
    // Injetado para não abrir socket em teste unitário.
    async (p: number) => listening.has(p),
  );
  assert.equal(url, "http://localhost:5273");
});

test("um anúncio que sobe antes do palpite confiável não rouba a vez", async () => {
  // Medido: uma API órfã de uma execução anterior segurava a 5271, então a API
  // nova foi para a 5272 e anunciou em 300ms — enquanto o Vite, na 5273
  // confiável, ainda subia. Sem o período de carência o único candidato vivo
  // naquele instante era a API, e o demovid gravava um 404.
  const listening = new Set([5272]);
  setTimeout(() => listening.add(5273), 300);

  const url = await waitForServer(
    { port: 5273, trusted: true },
    () => ["http://127.0.0.1:5272"],
    3_000,
    async (p: number) => listening.has(p),
    2_000, // carência maior que os 300ms que o Vite leva para subir
  );
  assert.equal(url, "http://localhost:5273");
});

test("passada a carência, um anúncio ainda resgata um palpite que não subiu", async () => {
  // O Vite move para 5274 quando a 5273 está ocupada. A carência atrasa esse
  // resgate; não pode cancelá-lo.
  const url = await waitForServer(
    { port: 5273, trusted: true },
    () => ["http://localhost:5274/"],
    2_000,
    async (p: number) => p === 5274,
    300,
  );
  assert.equal(url, "http://localhost:5274/");
});

test("sem evidência, a URL anunciada vence o palpite da tabela", async () => {
  // O caso inverso: framework `desconhecido` chuta 3000, e o servidor diz 5273.
  // Antes desta correção o anúncio só era lido DEPOIS que a espera na 3000
  // desse certo — ou seja, nunca, no caso para o qual foi escrito.
  const listening = new Set([5273]);
  const url = await waitForServer(
    { port: 3000, trusted: false },
    () => ["http://localhost:5273/"],
    1_000,
    async (p: number) => listening.has(p),
  );
  assert.equal(url, "http://localhost:5273/");
});

test("um servidor que só escuta em IPv6 é visto como no ar", async () => {
  // Medido: o Vite 7 ligou em [::1]:5273 e em nada no 127.0.0.1. Sondar só IPv4
  // dizia que a porta estava livre enquanto o app respondia 200 — e o demovid
  // subia um segundo servidor contra uma porta já ocupada. O contrário também
  // acontece, então nenhuma das duas famílias pode ser a única perguntada.
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "::1", r));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    assert.equal(await portInUse(address.port), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("uma porta livre continua sendo livre nas duas famílias", async () => {
  // O falso positivo é o pior dos dois: faria o demovid adotar um servidor que
  // não existe e nunca subir o do projeto.
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const address = probe.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise((r) => probe.close(r));
  assert.equal(await portInUse(port), false);
});

test("a espera devolve null quando nada responde, em vez de travar", async () => {
  const url = await waitForServer({ port: 3000, trusted: false }, () => [], 600, async () => false);
  assert.equal(url, null);
});

// ── a resposta do pi ─────────────────────────────────────────────────────────

const PI_STREAM = [
  JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }),
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "vou olhar o vite.config" },
        { type: "text", text: '{"framework":"vite"}' },
      ],
    },
  }),
  JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [] } }),
].join("\n");

test("a resposta do pi é o texto do message_end, não a última linha do stream", () => {
  // O stream termina em `turn_end`/`agent_end`; parsear a última linha, ou o
  // arquivo inteiro como um JSON só, devolve nada — que é indistinguível de
  // "o modelo não respondeu".
  assert.equal(extractPiText(PI_STREAM), '{"framework":"vite"}');
});

test("o bloco de raciocínio do pi não é confundido com a resposta", () => {
  // `content[0]` é o thinking. Lê-lo devolve prosa onde se espera JSON.
  const text = extractPiText(PI_STREAM);
  assert.ok(text !== null && !text.includes("vite.config"));
});

test("uma linha truncada no fim do stream não derruba o parse", () => {
  assert.equal(extractPiText(`${PI_STREAM}\n{"type":"agent_e`), '{"framework":"vite"}');
});

test("um stream sem mensagem nenhuma devolve null, não uma string vazia", () => {
  assert.equal(extractPiText('{"type":"message_update"}\nlixo\n'), null);
});

test("o JSON é extraído mesmo cercado por markdown ou prosa", () => {
  // Modelos cercam JSON em ``` mesmo mandados não cercar.
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('Aqui está:\n{"a":1}\nespero que ajude'), { a: 1 });
  assert.throws(() => extractJsonObject("não tenho como responder"), SyntaxError);
});

// ── o cache em .demovid.json ─────────────────────────────────────────────────

const CONFIG = {
  framework: "vite",
  dev: {
    bin: "npm",
    args: ["run", "dev"],
    cwd: ".",
    url: "http://localhost:5273",
    readyTimeoutMs: 90_000,
  },
  startRoute: "/",
  auth: { required: false, how: null, username: null, password: null },
  suggestions: ["mostre o grafo de commits"],
  notes: [],
};

test("a configuração salva é lida de volta igual", async () => {
  const { dir, cleanup } = await fixture({ "package.json": '{"name":"app"}' });
  try {
    const fp = await fingerprint(dir, []);
    await writeConfig(dir, CONFIG, fp);
    const { config } = await readConfig(dir, fp);
    assert.equal(config?.dev.url, "http://localhost:5273");
    assert.deepEqual(config?.suggestions, ["mostre o grafo de commits"]);
  } finally {
    await cleanup();
  }
});

test("mudar as dependências invalida a configuração", async () => {
  // O sinal tem de ser o conteúdo do manifesto: um TTL ou expira uma resposta
  // ainda certa, ou serve uma errada.
  const { dir, cleanup } = await fixture({ "package.json": '{"name":"app"}' });
  try {
    const antes = await fingerprint(dir, []);
    await writeConfig(dir, CONFIG, antes);

    await writeFile(join(dir, "package.json"), '{"name":"app","dependencies":{"vite":"^7"}}', "utf8");
    const depois = await fingerprint(dir, []);
    assert.notEqual(antes, depois);

    const { config, stale } = await readConfig(dir, depois);
    assert.equal(config, null);
    assert.equal(stale, true);
  } finally {
    await cleanup();
  }
});

test("o manifesto de um workspace entra no fingerprint", async () => {
  // Adicionar vite a web/ muda como o projeto sobe, e tem de invalidar.
  const { dir, cleanup } = await fixture({
    "package.json": '{"name":"app"}',
    "web/package.json": '{"name":"@x/web"}',
  });
  try {
    const antes = await fingerprint(dir, ["web"]);
    await writeFile(join(dir, "web/package.json"), '{"name":"@x/web","devDependencies":{"vite":"^7"}}', "utf8");
    assert.notEqual(antes, await fingerprint(dir, ["web"]));
  } finally {
    await cleanup();
  }
});

test("um .demovid.json editado à mão e quebrado degrada para descoberta", async () => {
  // O arquivo é editável de propósito, então é entrada hostil. Explodir aqui
  // seria uma ferramenta que não sobe até alguém apagar um arquivo que ela
  // nunca mencionou.
  const { dir, cleanup } = await fixture({
    "package.json": '{"name":"app"}',
    ".demovid.json": '{"version":1,"dev":{"bin":42}}',
  });
  try {
    const { config, stale } = await readConfig(dir, await fingerprint(dir, []));
    assert.equal(config, null);
    assert.equal(stale, false);
  } finally {
    await cleanup();
  }
});

test("um .demovid.json que não é JSON degrada para descoberta", async () => {
  const { dir, cleanup } = await fixture({
    "package.json": '{"name":"app"}',
    ".demovid.json": "{ isto não é json",
  });
  try {
    const { config } = await readConfig(dir, await fingerprint(dir, []));
    assert.equal(config, null);
  } finally {
    await cleanup();
  }
});
