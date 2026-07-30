/**
 * Works out what the project in the current directory is, and how to run it.
 *
 * Reads `package.json` and the lockfile, and nothing else. Component source is
 * deliberately NOT read: class names are compiled away by CSS modules and
 * styled-components, so feeding source to the model teaches it to invent
 * selectors that will not exist at runtime. The live DOM is the only honest
 * source of selectors, and `inventory.ts` reads that.
 *
 * The one thing the filesystem knows that the DOM cannot is the **route list**:
 * a file-routed framework has pages that no link points at, so a crawl would
 * never find them.
 */
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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

export interface ProjectScan {
  dir: string;
  name: string;
  /** False when no package.json was found in the directory. */
  hasPkg: boolean;
  framework: Framework;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  /** The script to run, e.g. `dev`. Null when none looks like a dev server. */
  script: string | null;
  /** Port parsed from the script, or the framework's default. */
  port: number;
  /** Routes discovered on disk, for frameworks that route by file. */
  routes: string[];
  /** Everything interesting that was noticed, for the operator and the model. */
  notes: string[];
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

  for (const root of candidates) {
    if (await exists(join(dir, root, "."))) continue; // readFile on a dir fails; try anyway
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
      routes: [],
      notes,
    };
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = SIGNATURES.find(([name]) => name in deps)?.[1] ?? "desconhecido";
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

  // A port written into the script beats any default table.
  const body = script ? (scripts[script] ?? "") : "";
  const explicit = /(?:--port[= ]|-p\s+)(\d{2,5})/.exec(body)?.[1];
  const port = explicit ? Number(explicit) : DEFAULT_PORT[framework];
  if (explicit) notes.push(`porta ${port} lida do próprio script`);

  const routes = await fileRoutes(dir, framework);
  if (routes.length > 0) notes.push(`${routes.length} rota(s) encontradas no sistema de arquivos`);

  return {
    dir,
    name: pkg.name ?? dir.split("/").pop() ?? "projeto",
    hasPkg: true,
    framework,
    packageManager,
    script,
    port,
    routes,
    notes,
  };
}
