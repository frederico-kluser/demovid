/**
 * Works out what the project in the current directory is, and how to run it.
 *
 * Reads `package.json`, the lockfile, the workspace members' manifests, and the
 * dev-server block of the build tool's config. Component source is deliberately
 * NOT read: class names are compiled away by CSS modules and styled-components,
 * so feeding source to the model teaches it to invent selectors that will not
 * exist at runtime. The live DOM is the only honest source of selectors, and
 * `inventory.ts` reads that.
 *
 * The one thing the filesystem knows that the DOM cannot is the **route list**:
 * a file-routed framework has pages that no link points at, so a crawl would
 * never find them.
 *
 * **The root manifest is not the project.** Measured 2026-07-30 on GitCraque: a
 * workspaces monorepo whose root `package.json` depends only on `ws`, while
 * React and Vite live in `web/package.json`. Matching frameworks against the
 * root alone reported `desconhecido`, which defaulted the port to 3000 while the
 * real Vite server was on 5273 — so demovid started the operator's dev server,
 * waited 90s on the wrong port, then killed it. Both halves of that failure are
 * fixed here: members are scanned, and the config file's `server.port` outranks
 * every default.
 */
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type Framework =
  | "next"
  | "nuxt"
  | "sveltekit"
  | "vite"
  | "cra"
  | "angular"
  | "vue-cli"
  | "astro"
  | "remix"
  | "static"
  | "desconhecido";

/** Where `port` came from, weakest last. Only `default` is a guess. */
export type PortSource = "script" | "config" | "default";

export interface ProjectScan {
  dir: string;
  name: string;
  /** False when no package.json was found in the directory. */
  hasPkg: boolean;
  framework: Framework;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  /** The script to run, e.g. `dev`. Null when none looks like a dev server. */
  script: string | null;
  /** Port from the script, then the build config, then the framework default. */
  port: number;
  portSource: PortSource;
  /**
   * Absolute path to the directory the frontend actually lives in — `dir` for a
   * plain app, a workspace member for a monorepo. Routes and build config are
   * read from here, not from `dir`.
   */
  webDir: string;
  /** Workspace members found, relative to `dir`. Empty for a non-monorepo. */
  workspaces: string[];
  /** Routes discovered on disk, for frameworks that route by file. */
  routes: string[];
  /** Everything interesting that was noticed, for the operator and the model. */
  notes: string[];
  /**
   * True when the framework was recognised AND there is a script to run it, i.e.
   * every field below came from evidence rather than a fallback. False is what
   * sends the project to `discover.ts` for an LLM to work out.
   */
  confident: boolean;
}

const DEFAULT_PORT: Record<Framework, number> = {
  next: 3000,
  nuxt: 3000,
  sveltekit: 5173,
  vite: 5173,
  cra: 3000,
  angular: 4200,
  "vue-cli": 8080,
  astro: 4321,
  remix: 3000,
  static: 8080,
  desconhecido: 3000,
};

/** Dependency name → framework, in priority order (a Next app also has Vite). */
const SIGNATURES: Array<[string, Framework]> = [
  ["next", "next"],
  ["nuxt", "nuxt"],
  ["@sveltejs/kit", "sveltekit"],
  ["@remix-run/react", "remix"],
  ["astro", "astro"],
  ["@angular/core", "angular"],
  ["@vue/cli-service", "vue-cli"],
  ["react-scripts", "cra"],
  ["vite", "vite"],
];

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  /** npm/yarn/bun accept both shapes; pnpm keeps the list in its own YAML file. */
  workspaces?: string[] | { packages?: string[] };
}

async function readJson(path: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * File-only existence check. Uses `readFile`, which fails with `EISDIR` on
 * directories — that is intentional here, because the callers wanted "is this a
 * readable file", not "does this path exist".
 *
 * For directory checks (e.g. `.git`), use `access()` directly — `readFile` on
 * a directory returns `false` here, which is the opposite of what you want.
 */
async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

/** The workspace globs, from `package.json` or from pnpm's separate YAML file. */
async function workspacePatterns(dir: string, pkg: PackageJson): Promise<string[]> {
  const declared = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg.workspaces?.packages)
      ? pkg.workspaces.packages
      : [];
  if (declared.length > 0) return declared;

  const yamlText = await readFile(join(dir, "pnpm-workspace.yaml"), "utf8").catch(() => null);
  if (yamlText === null) return [];
  const parsed = parseYaml(yamlText) as { packages?: unknown } | null;
  return Array.isArray(parsed?.packages)
    ? parsed.packages.filter((p): p is string => typeof p === "string")
    : [];
}

/**
 * `["packages/*", "web"]` → the member directories that actually hold a manifest.
 *
 * Only the last segment may glob, and `*` and `**` are treated alike: every real
 * workspace list means "each child of this directory", and a full glob engine
 * here would be a dependency bought for a case nobody writes.
 */
export async function expandWorkspaces(dir: string, patterns: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const raw of patterns) {
    const pattern = raw.replace(/\/+$/, "");
    if (!pattern || pattern.startsWith("!")) continue;

    const star = pattern.indexOf("*");
    if (star === -1) {
      if (await exists(join(dir, pattern, "package.json"))) found.add(pattern);
      continue;
    }

    const base = pattern.slice(0, star).replace(/\/+$/, "");
    const entries = await readdir(join(dir, base), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (await exists(join(dir, rel, "package.json"))) found.add(rel);
    }
  }
  return [...found].sort();
}

/** Config files that can carry an explicit dev-server port. */
const CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "nuxt.config.ts",
  "nuxt.config.js",
  "svelte.config.js",
  "svelte.config.ts",
  "astro.config.ts",
  "astro.config.mjs",
  "astro.config.js",
  "vue.config.js",
  "vue.config.ts",
];

/**
 * The dev-server port written into a build tool's config source.
 *
 * Scoped to the `server` / `devServer` block on purpose. A bare `/\bport\s*:/`
 * also matches `preview: { port }` and a proxy target, and picking one of those
 * is worse than the default it would replace: demovid would then wait on a port
 * nothing ever listens on. Returns null rather than guessing — the caller falls
 * back to the framework default, and `devserver.ts` still believes the URL the
 * server prints over both.
 *
 * Regex rather than parsing: these files are TypeScript that imports plugins,
 * so reading the value honestly would mean executing them.
 */
export function portFromConfigSource(source: string): number | null {
  const block = /\b(?:server|devServer)\s*:\s*\{/.exec(source);
  if (!block) return null;
  const from = block.index + block[0].length;
  // A fixed window instead of brace matching — long enough for a normal server
  // block, short enough that a `port` three keys later is not attributed here.
  const port = /\bport\s*:\s*(\d{2,5})/.exec(source.slice(from, from + 600));
  return port ? Number(port[1]) : null;
}

/** First explicit port found in any build config under `dir`. */
async function portFromConfig(dir: string): Promise<{ port: number; file: string } | null> {
  for (const file of CONFIG_FILES) {
    const source = await readFile(join(dir, file), "utf8").catch(() => null);
    if (source === null) continue;
    const port = portFromConfigSource(source);
    if (port !== null) return { port, file };
  }
  return null;
}

/** Walk a routes directory, collecting URL paths. Bounded, never recursive-forever. */
async function fileRoutes(dir: string, framework: Framework): Promise<string[]> {
  const roots: Record<string, string[]> = {
    next: ["app", "src/app", "pages", "src/pages"],
    nuxt: ["pages"],
    sveltekit: ["src/routes"],
    remix: ["app/routes"],
    astro: ["src/pages"],
  };
  const candidates = roots[framework];
  if (!candidates) return [];

  const pageFile = /^(page|index|\+page)\.(t|j)sx?$|^\+page\.svelte$|\.(astro|vue)$/;
  const found = new Set<string>();

  const walk = async (base: string, rel: string, depth: number): Promise<void> => {
    if (depth > 4 || found.size > 60) return;
    const entries = await readdir(join(base, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "api") continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(base, next, depth + 1);
      } else if (pageFile.test(e.name)) {
        // `app/dashboard/page.tsx` → `/dashboard`; `pages/about.tsx` → `/about`.
        const url = `/${rel}`.replace(/\/index$/, "").replace(/\/+/g, "/");
        const leaf = e.name.replace(/\.(t|j)sx?$|\.svelte$|\.astro$|\.vue$/, "");
        const path = /^(page|index|\+page)$/.test(leaf) ? url : `${url}/${leaf}`.replace(/\/+/g, "/");
        found.add(path === "" ? "/" : path.replace(/\/$/, "") || "/");
      }
    }
  };

  // No existence pre-check: `readdir` inside `walk` already yields [] for a
  // missing directory, and the module-level `exists` cannot answer for one.
  for (const root of candidates) {
    await walk(join(dir, root), "", 0);
  }
  return [...found].sort();
}

/**
 * True when a `.git` directory (or file, for worktrees) exists at `dir`.
 * Uses `access` rather than the module-level `exists` because `exists` calls
 * `readFile`, which fails with `EISDIR` on the directory that a normal repo
 * has at `.git`. `access` works for both files and directories.
 */
export async function hasGitRepo(dir: string): Promise<boolean> {
  return access(join(dir, ".git")).then(() => true, () => false);
}

export async function scanProject(dir: string): Promise<ProjectScan> {
  const notes: string[] = [];
  const pkg = await readJson(join(dir, "package.json"));

  if (!pkg) {
    notes.push("sem package.json — tratando como site estático");
    return {
      dir,
      name: dir.split("/").pop() ?? "projeto",
      hasPkg: false,
      framework: "static",
      packageManager: "npm",
      script: null,
      port: DEFAULT_PORT.static,
      portSource: "default",
      webDir: dir,
      workspaces: [],
      routes: [],
      notes,
      confident: false,
    };
  }

  // The framework is looked for in the root first, then in the workspace members.
  // Root-first matters: a monorepo whose root really is the Next app must not be
  // reassigned to a member that happens to also depend on vite.
  const workspaces = await expandWorkspaces(dir, await workspacePatterns(dir, pkg));
  if (workspaces.length > 0) {
    notes.push(`monorepo: ${workspaces.length} workspace(s) — ${workspaces.join(", ")}`);
  }

  const rootDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  let framework = SIGNATURES.find(([name]) => name in rootDeps)?.[1] ?? "desconhecido";
  let webDir = dir;

  if (framework === "desconhecido") {
    for (const member of workspaces) {
      const memberPkg = await readJson(join(dir, member, "package.json"));
      if (!memberPkg) continue;
      const memberDeps = { ...memberPkg.dependencies, ...memberPkg.devDependencies };
      const hit = SIGNATURES.find(([name]) => name in memberDeps)?.[1];
      if (hit) {
        framework = hit;
        webDir = join(dir, member);
        notes.push(`front-end em ./${member} (${hit}), não na raiz`);
        break;
      }
    }
  }
  if (framework === "desconhecido") notes.push("não reconheci o framework pelas dependências");

  const packageManager: ProjectScan["packageManager"] = (await exists(join(dir, "pnpm-lock.yaml")))
    ? "pnpm"
    : (await exists(join(dir, "yarn.lock")))
      ? "yarn"
      : (await exists(join(dir, "bun.lockb")))
        ? "bun"
        : "npm";

  const scripts = pkg.scripts ?? {};
  const script = ["dev", "start", "serve", "develop"].find((s) => s in scripts) ?? null;
  if (!script) notes.push("nenhum script de dev encontrado (dev/start/serve)");

  // Three sources, strongest first. The script is the strongest because it is
  // what actually runs; the config is next because the tool reads it; the table
  // is only a guess, and is the one `confident` refuses to vouch for.
  const body = script ? (scripts[script] ?? "") : "";
  const inScript = /(?:--port[= ]|-p\s+)(\d{2,5})/.exec(body)?.[1];
  // The config is looked for beside the frontend, then at the root — a monorepo
  // keeps `vite.config.ts` in the member, a plain app keeps it where it stands.
  const inConfig = inScript
    ? null
    : ((await portFromConfig(webDir)) ?? (webDir === dir ? null : await portFromConfig(dir)));

  const port = inScript ? Number(inScript) : (inConfig?.port ?? DEFAULT_PORT[framework]);
  const portSource: PortSource = inScript ? "script" : inConfig ? "config" : "default";
  if (inScript) notes.push(`porta ${port} lida do próprio script`);
  else if (inConfig) notes.push(`porta ${port} lida de ${inConfig.file}`);

  const routes = await fileRoutes(webDir, framework);
  if (routes.length > 0) notes.push(`${routes.length} rota(s) encontradas no sistema de arquivos`);

  return {
    dir,
    name: pkg.name ?? dir.split("/").pop() ?? "projeto",
    hasPkg: true,
    framework,
    packageManager,
    script,
    port,
    portSource,
    webDir,
    workspaces,
    routes,
    notes,
    confident: framework !== "desconhecido" && script !== null,
  };
}
