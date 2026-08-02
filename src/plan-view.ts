/**
 * The plan the operator approves, in one shape and two renderings.
 *
 * It exists as its own module because the plan is now shown in two places — the
 * terminal and Plannotator's browser UI — and the thing being approved has to be
 * the same in both. Two independent renderers reading the storyboard directly is
 * how the approved plan and the recorded one drift apart.
 *
 * The load-bearing content is the WAITS. A storyboard shows what the demo does;
 * it does not show that after every `click`, `type`, `goto` and `scroll` the
 * recorder holds the frame until the app stops being busy. That wait is the
 * difference between a video of a result and a video of a spinner, and it is
 * decided by selectors merged from two sources the operator never sees. Putting
 * them in the plan is what makes them reviewable before the take instead of
 * discoverable after it.
 */
import { SETTLE_DEFAULT_MS, SETTLING_ACTIONS, type RecordReport } from "./record.js";
import type { CapturePlan } from "./resolution.js";
import type { Step, Storyboard } from "./storyboard.js";

/** Where a loading selector came from. The operator fixes each one differently. */
export type LoaderSource = "embutido" | "crawl" | "config";

export const LOADER_SOURCE_LABEL: Record<LoaderSource, string> = {
  embutido: "embutido no demovid",
  crawl: "encontrado na varredura do app",
  config: "escrito no .demovid.json",
};

export interface LoaderView {
  selector: string;
  /** Every source that claims it. A selector both sources found is the strong case. */
  sources: LoaderSource[];
}

export interface StepView {
  index: number;
  action: string;
  target?: string | undefined;
  value?: string | undefined;
  say?: string | undefined;
  caption?: string | undefined;
  /** `expect`: what has to be on screen before the demo moves on. */
  expect?: string | undefined;
  /** True when this action gets the automatic settle. */
  waits: boolean;
  /** The ceiling that settle will actually use, in ms. */
  waitMs: number;
  /** Rehearsal outcome, when the step was rehearsed. */
  ok?: boolean | undefined;
  detail?: string | undefined;
}

export interface PlanView {
  title: string;
  url: string;
  preset: string;
  steps: StepView[];
  loaders: LoaderView[];
  /** Selectors whose appearance means an operation finished, from `readiness`. */
  settledSelectors: string[];
  /** Operations the agent flagged as slow, and how long they were given. */
  slowActions: { what: string; timeoutMs: number }[];
  capture?: CaptureView | undefined;
  rehearsal?: { total: number; broken: number } | undefined;
}

export interface CaptureView {
  label: string;
  monitor: string;
  target: { w: number; h: number };
  window: { w: number; h: number };
  usable: { w: number; h: number };
  scaleNeeded: boolean;
}

export interface BuildPlanViewInput {
  storyboard: Storyboard;
  report?: RecordReport | undefined;
  /** Built-in patterns; `LOADING_SELECTORS` from `record.ts`. */
  builtin: readonly string[];
  /** What the crawl saw on screen: `Inventory.loaders`. */
  fromCrawl: readonly string[];
  /** What the agent read in the source: `readiness.loadingSelectors`. */
  fromConfig: readonly string[];
  settledSelectors?: readonly string[] | undefined;
  slowActions?: readonly { what: string; timeoutMs: number }[] | undefined;
  capture?: CapturePlan | undefined;
}

/**
 * Merge the three loader sources, keeping every provenance.
 *
 * A merge rather than a choice, for the reason `scriptflow` already merges two of
 * them: the crawl only sees what was on screen when it looked, the agent only
 * sees what is written in the source, and the built-ins only cover what every
 * frontend agrees on. None is a superset. Recording which source found a
 * selector is what lets the operator act on a wrong one — a bad built-in is a
 * demovid bug, a bad `.demovid.json` entry is one line to edit.
 */
function mergeLoaders(input: BuildPlanViewInput): LoaderView[] {
  const byselector = new Map<string, Set<LoaderSource>>();
  const add = (selectors: readonly string[], source: LoaderSource): void => {
    for (const sel of selectors) {
      const set = byselector.get(sel) ?? new Set<LoaderSource>();
      set.add(source);
      byselector.set(sel, set);
    }
  };
  add(input.builtin, "embutido");
  add(input.fromCrawl, "crawl");
  add(input.fromConfig, "config");

  // Project-specific first: those are the ones worth an operator's attention, and
  // the eight generic patterns are the same in every plan they will ever read.
  const rank = (v: LoaderView): number =>
    v.sources.includes("config") ? 0 : v.sources.includes("crawl") ? 1 : 2;
  return [...byselector.entries()]
    .map(([selector, sources]) => ({ selector, sources: [...sources] }))
    .sort((a, b) => rank(a) - rank(b) || a.selector.localeCompare(b.selector));
}

function stepView(step: Step, index: number, report?: RecordReport): StepView {
  const r = report?.steps.find((s) => s.index === index);
  return {
    index,
    action: step.action,
    target: step.target,
    value: step.value,
    say: step.say,
    caption: step.caption,
    expect: step.expect,
    waits: SETTLING_ACTIONS.has(step.action),
    waitMs: step.timeoutMs ?? SETTLE_DEFAULT_MS,
    ok: r?.ok,
    detail: r?.detail,
  };
}

export function buildPlanView(input: BuildPlanViewInput): PlanView {
  const { storyboard: sb, report } = input;
  const steps = sb.steps.map((s, i) => stepView(s, i, report));
  return {
    title: sb.title,
    url: sb.url,
    preset: sb.preset,
    steps,
    loaders: mergeLoaders(input),
    settledSelectors: [...(input.settledSelectors ?? [])],
    slowActions: [...(input.slowActions ?? [])],
    capture: input.capture ? captureView(input.capture) : undefined,
    rehearsal: report
      ? { total: report.steps.length, broken: report.steps.filter((s) => !s.ok).length }
      : undefined,
  };
}

function captureView(plan: CapturePlan): CaptureView {
  return {
    label: plan.label,
    monitor: plan.monitor,
    target: { w: plan.target.w, h: plan.target.h },
    window: { w: plan.window.w, h: plan.window.h },
    usable: { w: plan.usable.w, h: plan.usable.h },
    scaleNeeded: plan.scaleNeeded,
  };
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;

/** One line describing what a step waits for, or null when it waits for nothing. */
export function waitLine(step: StepView, loaderCount: number): string | null {
  const parts: string[] = [];
  if (step.waits && loaderCount > 0) {
    parts.push(`espera o app parar de carregar (até ${secs(step.waitMs)})`);
  } else if (step.waits) {
    parts.push(`espera a rede sossegar (até ${secs(step.waitMs)})`);
  }
  if (step.expect) parts.push(`e \`${step.expect}\` aparecer`);
  return parts.length > 0 ? parts.join(" ") : null;
}

// ── terminal ────────────────────────────────────────────────────────────────

/**
 * The plan on stderr.
 *
 * stderr, not stdout, for the reason `src/prompt.ts` gives: stdout carries the
 * path of the finished video and nothing else.
 */
export function printPlan(view: PlanView): void {
  const out = (s = ""): void => console.warn(s);
  out();
  out(`  ${view.title}`);
  out();

  if (view.capture) {
    const c = view.capture;
    out(
      `  captura: ${c.label} em ${c.monitor} — janela ${c.window.w}x${c.window.h}` +
        (c.scaleNeeded ? `, ampliada para ${c.target.w}x${c.target.h} no final` : ""),
    );
  }

  if (view.loaders.length > 0) {
    out(`  carregamento: ${view.loaders.length} indicador(es) — cada ação espera eles sumirem`);
    for (const l of view.loaders) {
      out(`      ${l.selector}   (${l.sources.map((s) => LOADER_SOURCE_LABEL[s]).join(", ")})`);
    }
  } else {
    out("  carregamento: nenhum indicador conhecido — as ações só esperam a rede sossegar");
  }
  for (const s of view.slowActions) {
    out(`  lento: ${s.what} — até ${secs(s.timeoutMs)}`);
  }
  out();

  for (const step of view.steps) {
    const mark = step.ok === undefined ? "·" : step.ok ? "✓" : "✗";
    out(
      `  ${mark} ${String(step.index).padStart(2)}. ${step.action.padEnd(7)} ` +
        `${(step.target ?? "").slice(0, 42).padEnd(42)}`,
    );
    if (step.say) out(`        "${step.say.slice(0, 96)}"`);
    const wait = waitLine(step, view.loaders.length);
    if (wait) out(`        ⏳ ${wait}`);
    if (step.ok === false && step.detail) out(`        ↳ ${step.detail}`);
  }

  out();
  if (view.rehearsal) {
    out(
      view.rehearsal.broken === 0
        ? `  ensaio: todos os ${view.rehearsal.total} passos funcionaram.`
        : `  ensaio: ${view.rehearsal.broken} de ${view.rehearsal.total} passos falharam — ` +
          "dá para pedir correção abaixo.",
    );
  }
}

// ── markdown, for Plannotator ───────────────────────────────────────────────

/**
 * The same plan as a markdown document.
 *
 * Written for annotation rather than for reading: each step is its own heading so
 * a comment lands on one step instead of on the whole list, and the waits are
 * inline with the step they belong to for the same reason. A table of steps reads
 * better and annotates worse.
 */
export function planMarkdown(view: PlanView): string {
  const md: string[] = [];
  const p = (s = ""): number => md.push(s);

  p(`# ${view.title}`);
  p();
  p(`Aprove para gravar, ou anote o que mudar. O que estiver anotado volta para o modelo reescrever o roteiro.`);
  p();
  p(`- **App:** ${view.url}`);
  p(`- **Preset:** ${view.preset}`);
  if (view.capture) {
    const c = view.capture;
    p(
      `- **Captura:** ${c.label} em ${c.monitor} — janela ${c.window.w}x${c.window.h} ` +
        `(área útil ${c.usable.w}x${c.usable.h})` +
        (c.scaleNeeded ? `, ampliada para ${c.target.w}x${c.target.h} no final` : ""),
    );
  }
  if (view.rehearsal) {
    p(
      `- **Ensaio:** ` +
        (view.rehearsal.broken === 0
          ? `os ${view.rehearsal.total} passos funcionaram`
          : `${view.rehearsal.broken} de ${view.rehearsal.total} passos falharam`),
    );
  }
  p();

  p("## Condições de carregamento");
  p();
  if (view.loaders.length > 0) {
    p(
      "Depois de cada `click`, `type`, `goto` e `scroll`, a gravação espera **todos** estes " +
        "sumirem da tela antes de segurar o quadro. É o que separa um vídeo do resultado de um " +
        "vídeo do spinner. Um seletor que fica sempre visível faz todo passo queimar o tempo " +
        "limite — se algum aqui estiver errado, anote.",
    );
    p();
    p("| Seletor | De onde veio |");
    p("| --- | --- |");
    for (const l of view.loaders) {
      p(`| \`${l.selector}\` | ${l.sources.map((s) => LOADER_SOURCE_LABEL[s]).join(", ")} |`);
    }
  } else {
    p(
      "Nenhum indicador de carregamento conhecido. As ações só esperam a rede sossegar, " +
        "então um app que demora para renderizar depois da resposta pode aparecer no meio do " +
        "carregamento.",
    );
  }
  p();

  if (view.settledSelectors.length > 0) {
    p("**Sinais de que terminou** (o agente leu no código-fonte):");
    p();
    for (const s of view.settledSelectors) p(`- \`${s}\``);
    p();
  }

  if (view.slowActions.length > 0) {
    p("**Operações lentas declaradas:**");
    p();
    for (const s of view.slowActions) p(`- ${s.what} — até ${secs(s.timeoutMs)}`);
    p();
  }

  p("## Passos");
  p();
  for (const step of view.steps) {
    const mark = step.ok === undefined ? "" : step.ok ? " ✓" : " ✗";
    const what = step.target ? ` \`${step.target}\`` : step.value ? ` \`${step.value}\`` : "";
    p(`### ${step.index}. \`${step.action}\`${what}${mark}`);
    p();
    if (step.say) p(`> ${step.say}`);
    if (step.caption) p(`> **legenda:** ${step.caption}`);
    if (step.say || step.caption) p();
    if (step.action === "type" && step.value && step.target) p(`- digita: \`${step.value}\``);
    const wait = waitLine(step, view.loaders.length);
    if (wait) p(`- ⏳ ${wait}`);
    if (step.ok === false && step.detail) p(`- **falhou no ensaio:** ${step.detail}`);
    p();
  }

  return md.join("\n");
}
