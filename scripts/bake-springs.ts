/**
 * Bakes spring simulations into CSS `linear()` easing strings, at build time.
 *
 * Why this exists. The whole auto-zoom screen-recorder category (Screen Studio,
 * FocuSee, Cap, Tella) runs spring *simulations* rather than duration+easing —
 * Cap's source says it outright: "There are no fixed animation durations". That
 * is why no vendor publishes durations: they do not have any.
 *
 * But their problem is not ours. They post-process *human* recordings with
 * unpredictable retargeting. A demovid demo is choreographed — every target is
 * known up front, and every move must fit narration of known length. We want the
 * spring's *feel* with a duration we can schedule.
 *
 * `spring(...).toString()` from Motion emits exactly that: a CSS duration plus a
 * `linear()` easing that samples the simulation. Running it here, in Node, means
 * the overlay ships zero animation JS — it becomes plain CSS transitions.
 *
 * Constants are Cap's (MIT), read from `crates/project/src/configuration.rs`.
 * ζ (damping ratio) = c / (2·√(k·m)); the house style is ζ ≈ 0.93–0.99, i.e.
 * barely underdamped, with no visible bounce.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spring } from "motion";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/generated/springs.ts");

interface SpringSpec {
  name: string;
  stiffness: number;
  damping: number;
  mass: number;
  note: string;
}

/** Cap's shipped constants. */
const SPECS: SpringSpec[] = [
  { name: "screenDefault", stiffness: 200, damping: 40, mass: 2.25, note: "Cap ScreenMovementSpring::default — a câmera padrão" },
  { name: "cursorMellow", stiffness: 470, damping: 70, mass: 3.0, note: "Cap CursorAnimationStyle::Mellow (o padrão deles)" },
  { name: "cursorSmooth", stiffness: 80, damping: 28, mass: 2.5, note: "Cap Smooth — o mais lento, criticamente amortecido" },
  { name: "cursorSlow", stiffness: 200, damping: 40, mass: 2.25, note: "Cap Slow" },
  { name: "cursorFast", stiffness: 380, damping: 30, mass: 1.0, note: "Cap Fast — o único com overshoot visível" },
];

/** ζ = c / (2·√(k·m)) */
const dampingRatio = (s: SpringSpec): number => s.damping / (2 * Math.sqrt(s.stiffness * s.mass));

/** Overshoot = e^(−πζ/√(1−ζ²)), 0 when overdamped. */
const overshoot = (z: number): number => (z >= 1 ? 0 : Math.exp((-Math.PI * z) / Math.sqrt(1 - z * z)));

const lines: string[] = [
  "// GERADO POR scripts/bake-springs.ts — NÃO EDITE À MÃO.",
  "// Constantes do Cap (MIT), simuladas pelo Motion em tempo de build.",
  "// Rode `npm run bake:springs` para regenerar.",
  "",
  "export interface BakedSpring {",
  "  /** Pronto para `transition: transform ${css}`. */",
  "  css: string;",
  "  durationMs: number;",
  "  easing: string;",
  "  /** ζ — coeficiente de amortecimento. Estilo da casa: 0.93–0.99. */",
  "  zeta: number;",
  "  /** 4/(ζ·ω₀): quando o olho lê como parado. Bem menor que `durationMs`, que",
  "   *  é a simulação até o limiar de repouso do Motion. Use este para o ritmo. */",
  "  perceivedMs: number;",
  "  /** Fração de overshoot. 0 = sem repique. */",
  "  overshoot: number;",
  "}",
  "",
  "export const SPRINGS = {",
];

for (const s of SPECS) {
  const z = dampingRatio(s);
  const os = overshoot(z);
  // `keyframes` é obrigatório quando se passa constantes físicas: sem ele o
  // gerador não tem o que simular e estoura lendo `keyframes[0]`.
  const css = spring({
    keyframes: [0, 1],
    stiffness: s.stiffness,
    damping: s.damping,
    mass: s.mass,
  }).toString();
  const durationMs = Number.parseFloat(/^([\d.]+)ms/.exec(css)?.[1] ?? "0");
  const easing = css.replace(/^[\d.]+ms\s*/, "");

  const omega0 = Math.sqrt(s.stiffness / s.mass);
  const perceivedMs = Math.round((4 / (z * omega0)) * 1000);

  lines.push(
    `  /** ${s.note} — stiffness ${s.stiffness}, damping ${s.damping}, mass ${s.mass}. */`,
    `  ${s.name}: {`,
    `    css: ${JSON.stringify(css)},`,
    `    durationMs: ${durationMs},`,
    `    easing: ${JSON.stringify(easing)},`,
    `    zeta: ${z.toFixed(3)},`,
    `    perceivedMs: ${perceivedMs},`,
    `    overshoot: ${os.toFixed(4)},`,
    `  },`,
  );

  console.error(
    `  ${s.name.padEnd(14)} ζ=${z.toFixed(3)}  overshoot=${(os * 100).toFixed(2).padStart(5)}%  ` +
      `simulação ${String(durationMs).padStart(4)}ms  percebido ${String(perceivedMs).padStart(4)}ms  ` +
      `${(easing.match(/,/g)?.length ?? 0) + 1} pontos`,
  );
}

lines.push("} as const satisfies Record<string, BakedSpring>;", "");

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, lines.join("\n"), "utf8");
console.error(`[bake-springs] → src/generated/springs.ts`);
