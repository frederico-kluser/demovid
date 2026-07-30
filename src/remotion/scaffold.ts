/**
 * Writes the Remotion project: template files, the EDL, and the assets.
 *
 * The components are **real versioned files** under `templates/remotion/`, not
 * strings concatenated in TypeScript. They are React code that needs to be read,
 * diffed and edited by a human after generation, and a template held in a string
 * literal is a template nobody ever improves.
 *
 * Two details that are easy to get wrong:
 *
 *  - **`gitignore` is stored without the dot.** A `.gitignore` inside `templates/`
 *    would be applied to the template directory itself by every tool that walks the
 *    tree, and `npm pack` in particular would then ship a template with its own
 *    source files excluded. It is renamed on copy.
 *  - **Assets are copied, never linked.** `public/` has to survive the cache being
 *    cleared and the project being moved to another machine; a symlink into
 *    `.demovid-cache/` breaks both, and Remotion's bundler would refuse to follow it
 *    out of the project root anyway.
 */
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clip } from "../openai/tts.js";
import type { Edl } from "./edl.js";

/**
 * The template directory, resolved from this module.
 *
 * Two levels up works from both `src/remotion/` under `tsx` and `dist/remotion/`
 * after `tsc`, because `dist` mirrors `src`. It is the reason `templates` has to be
 * in `package.json`'s `files` list — without it the published CLI has no template.
 */
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "remotion");

export interface ScaffoldOptions {
  /** Directory to create. Overwritten in place if it already exists. */
  dir: string;
  edl: Edl;
  /** The finished recording. Copied to `public/<edl.video.src>`. */
  videoPath: string;
  /** Narration, copied to `public/audio/<id>.mp3`. */
  clips: Clip[];
  /** Project name for `package.json`. */
  name: string;
  onLog?: ((line: string) => void) | undefined;
}

export interface ScaffoldResult {
  dir: string;
  edlPath: string;
  /** True when `node_modules` is already there, so the Studio can start at once. */
  installed: boolean;
}

export async function scaffoldRemotion(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const log = opts.onLog ?? ((): void => {});
  const { dir } = opts;

  // Preserve `node_modules` across regenerations — it is a few hundred megabytes
  // and nothing demovid writes can invalidate it. Everything else is overwritten,
  // so a re-record cannot leave a stale scene behind.
  await mkdir(dir, { recursive: true });
  for (const stale of ["src", "public", "package.json", "tsconfig.json", "remotion.config.ts", "README.md"]) {
    await rm(join(dir, stale), { recursive: true, force: true });
  }

  await cp(join(TEMPLATE_DIR, "src"), join(dir, "src"), { recursive: true });
  for (const f of ["tsconfig.json", "remotion.config.ts", "README.md"]) {
    await copyFile(join(TEMPLATE_DIR, f), join(dir, f));
  }
  await copyFile(join(TEMPLATE_DIR, "gitignore"), join(dir, ".gitignore"));

  // `package.json` is the one templated file: the project name is the only value
  // that varies, and a placeholder beats generating the whole file from an object.
  const pkg = await readFile(join(TEMPLATE_DIR, "package.json"), "utf8");
  await writeFile(join(dir, "package.json"), pkg.replace("__PROJECT_NAME__", opts.name), "utf8");

  // The roteiro de edição, beside the components that read it.
  await writeFile(join(dir, "src", "edl.json"), `${JSON.stringify(opts.edl, null, 2)}\n`, "utf8");

  // ── assets ────────────────────────────────────────────────────────────────
  const publicDir = join(dir, "public");
  await mkdir(join(publicDir, "audio"), { recursive: true });
  await copyFile(opts.videoPath, join(publicDir, opts.edl.video.src));

  // Only the clips the EDL actually references. The cache is shared across every
  // demo on the machine, so copying all of it would ship other projects' narration.
  const referenced = new Set(opts.edl.scenes.flatMap((s) => s.narration.map((n) => basename(n.src))));
  let copied = 0;
  for (const clip of opts.clips) {
    const name = `${clip.id}.mp3`;
    if (!referenced.has(name)) continue;
    await copyFile(clip.path, join(publicDir, "audio", name));
    copied++;
  }

  log(`projeto Remotion em ${dir} (${opts.edl.scenes.length} cena(s), ${copied} clipe(s) de narração)`);

  // `stat`, not `readFile`: npm's tree lockfile is megabytes on a Remotion install
  // and the question is only whether it exists.
  const installed = await stat(join(dir, "node_modules", ".package-lock.json")).then(
    (s) => s.size > 0,
    () => false,
  );

  return { dir, edlPath: join(dir, "src", "edl.json"), installed };
}
