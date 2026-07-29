/**
 * Bundles `overlay/src/index.ts` into ONE self-contained IIFE string, then emits
 * it as a TypeScript module that `src/browser.ts` imports and hands to
 * `page.addInitScript()`.
 *
 * Why esbuild here and plain `tsc` everywhere else: `addInitScript` takes a
 * single script *source string*, so the overlay genuinely needs bundling. The
 * CLI does not, and AGENTS.md keeps it on `tsc`.
 *
 * IIFE, never UMD — the UMD build of any library assigns to `globalThis`, and
 * we must not collide with a target app that ships the same dependency.
 */
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "overlay/src/index.ts");
const OUT_TS = join(ROOT, "src/generated/overlay-bundle.ts");

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "iife",
  // Deliberately NO `globalName`: esbuild would emit `var __demovid = <module
  // exports>` AFTER the IIFE body runs, overwriting the `window.__demovid = api`
  // that `overlay/src/index.ts` sets on purpose. One global, assigned by us.
  platform: "browser",
  target: ["chrome120"],
  minify: true,
  write: false,
  legalComments: "none",
});

const out = result.outputFiles[0];
if (!out) throw new Error("esbuild produced no output");
const code = out.text;

await mkdir(dirname(OUT_TS), { recursive: true });
await writeFile(
  OUT_TS,
  `// GERADO POR scripts/build-overlay.ts — NÃO EDITE À MÃO.\n` +
    `// Fonte: overlay/src/**. Rode \`npm run build:overlay\` para regenerar.\n` +
    `export const OVERLAY_BUNDLE = ${JSON.stringify(code)};\n`,
  "utf8",
);

// addInitScript ships this as raw UTF-8 over CDP on every navigation and every
// frame — gzip does not help. Size is a budget, so print it.
console.error(`[build-overlay] ${(code.length / 1024).toFixed(1)} KB → src/generated/overlay-bundle.ts`);
