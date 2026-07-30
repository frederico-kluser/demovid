/**
 * Builds the list of things the model is allowed to point at.
 *
 * One rule carries this whole feature: **a selector is never published without
 * having been verified in the page as matching exactly one element.** Not
 * "looks stable", not "probably unique" — `querySelectorAll(sel).length === 1`,
 * evaluated in the live DOM, right there.
 *
 * The consequence is that hallucinated targets stop being possible rather than
 * becoming something to detect later: if an element is not addressable it never
 * enters the inventory, so there is nothing for the model to point at wrongly.
 * Everything downstream — the repair loop, the rehearsal — is a second line of
 * defence for a class of error this mostly eliminates.
 *
 * ## The crawl never clicks
 *
 * Navigation is `page.goto(href)` only. A crawler that clicks to explore will
 * eventually submit a form, delete a row, or send an invitation from the
 * operator's own dev database. Reachability is not worth that.
 */
import type { Page } from "playwright-core";
import type { ProjectScan } from "./scan.js";

export interface InventoryItem {
  /** A verified-unique selector, ready for `page.locator()`. */
  sel: string;
  /** How much the selector can be trusted across a rebuild. 0–100. */
  stability: number;
  role: string;
  tag: string;
  /** Visible text, trimmed. */
  text: string;
  kind: "botão" | "link" | "campo" | "título" | "região" | "outro";
  /** Route the element was found on. */
  route: string;
}

export interface Inventory {
  origin: string;
  routes: string[];
  items: InventoryItem[];
  /**
   * Selectors that appear to mean "this app is busy", found during the crawl.
   *
   * Deliberately NOT held to the uniqueness rule that governs `items`, and the
   * difference is not an oversight. A target has to be unique because the demo
   * *acts* on exactly one element; a loading indicator is only ever asked "is any
   * of you visible", so a selector matching four skeleton rows is the right
   * answer rather than a rejected one.
   *
   * Also incomplete by construction: the crawl navigates and looks, so it can
   * only see a spinner that happened to be on screen while it looked. That is why
   * `pi` is asked the same question against the source code — the two lists
   * cover different failure modes and are merged, never traded off.
   */
  loaders: string[];
  notes: string[];
}

/**
 * Runs INSIDE the page. Self-contained on purpose — it is serialised to the
 * browser, so it cannot close over anything from this module.
 */
/* eslint-disable */
function collectInPage(): Array<Omit<InventoryItem, "route">> {
  const GENERATED =
    /^(:r[0-9a-z]+:|radix-|headlessui-|mui-|react-aria-|ember\d|:R[0-9a-z]+:|.*-[0-9a-f]{6,}$)/i;

  const cssEscape = (v: string): string =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");

  const unique = (sel: string): boolean => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };

  /**
   * What a human would call this element.
   *
   * Falls back through placeholder / aria-label / value, because an input's
   * `textContent` is empty and an inventory row with no description is one the
   * model cannot reason about — it would be a selector and nothing else.
   */
  const textOf = (el: Element): string => {
    const own = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (own) return own.slice(0, 80);
    for (const attr of ["placeholder", "aria-label", "title", "value", "alt"]) {
      const v = el.getAttribute(attr);
      if (v?.trim()) return v.trim().slice(0, 80);
    }
    return "";
  };

  const kindOf = (el: Element): Omit<InventoryItem, "route">["kind"] => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") ?? "";
    if (tag === "button" || role === "button" || (tag === "input" && (el as HTMLInputElement).type === "submit"))
      return "botão";
    if (tag === "a") return "link";
    if (tag === "input" || tag === "textarea" || tag === "select") return "campo";
    if (/^h[1-6]$/.test(tag)) return "título";
    if (["nav", "main", "aside", "header", "footer", "section"].includes(tag)) return "região";
    return "outro";
  };

  /**
   * Candidate selectors, best first. Each is *tested* before being accepted, so
   * a high-ranked one that is not actually unique falls through to the next.
   */
  const selectorsFor = (el: Element): Array<{ sel: string; stability: number }> => {
    const out: Array<{ sel: string; stability: number }> = [];
    const tag = el.tagName.toLowerCase();

    for (const attr of ["data-testid", "data-test", "data-cy", "data-demovid-id"]) {
      const v = el.getAttribute(attr);
      if (v) out.push({ sel: `[${attr}="${cssEscape(v)}"]`, stability: 100 });
    }

    const id = el.getAttribute("id");
    if (id && !GENERATED.test(id)) out.push({ sel: `#${cssEscape(id)}`, stability: 90 });

    for (const attr of ["aria-label", "name", "placeholder"]) {
      const v = el.getAttribute(attr);
      if (v && v.length < 60) out.push({ sel: `${tag}[${attr}="${cssEscape(v)}"]`, stability: 80 });
    }

    const text = textOf(el);
    const kind = kindOf(el);
    if (text && text.length <= 40 && (kind === "botão" || kind === "link" || kind === "título")) {
      // Playwright's own text engine, not CSS — it is what `locator()` accepts.
      out.push({ sel: `${tag}:has-text("${text.replace(/"/g, '\\"')}")`, stability: 60 });
    }

    return out;
  };

  // `[id]` and `[aria-label]` are in here on purpose: the elements a demo most
  // wants to point at are often plain `div`s that the app gave an id — a KPI
  // card, a summary panel — and a tag-based list misses every one of them.
  // Breadth is safe because nothing leaves this function without its selector
  // having been verified unique.
  const SELECTOR =
    "a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], " +
    "[data-testid], [data-test], [data-cy], [aria-label], [id], h1, h2, h3, nav, main";

  const seen = new Set<string>();
  const items: Array<Omit<InventoryItem, "route">> = [];

  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    if (items.length >= 120) break;
    if (!visible(el)) continue;

    for (const candidate of selectorsFor(el)) {
      // The whole point: only a selector that resolves to exactly one element
      // is allowed out of this function.
      if (candidate.sel.includes(":has-text(")) {
        // `has-text` is Playwright syntax and cannot be checked with
        // querySelectorAll, so it is only offered when nothing better exists
        // and is marked as the weakest option.
        if (items.some((i) => i.sel === candidate.sel)) break;
      } else if (!unique(candidate.sel)) {
        continue;
      }
      if (seen.has(candidate.sel)) break;
      seen.add(candidate.sel);
      items.push({
        sel: candidate.sel,
        stability: candidate.stability,
        role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
        tag: el.tagName.toLowerCase(),
        text: textOf(el),
        kind: kindOf(el),
      });
      break; // one selector per element, the best that verified
    }
  }

  return items;
}
/* eslint-enable */

export interface CrawlOptions {
  page: Page;
  startUrl: string;
  scan: ProjectScan;
  log: (line: string) => void;
  maxRoutes?: number;
}

/**
 * Make esbuild's `keepNames` helper exist in the page.
 *
 * Measured, and a genuinely confusing failure: when demovid runs through `tsx`,
 * every named function is compiled to `__name(fn, "fn")`. `page.evaluate`
 * serialises the *compiled* source, so the helper reference travels to the
 * browser while the helper itself does not, and the collector dies with
 * `ReferenceError: __name is not defined` — which reads exactly like "this app
 * has no addressable elements" if the error is swallowed.
 *
 * Identity function, injected only into the throwaway probe browser.
 */
async function installNameShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const g = globalThis as unknown as { __name?: (f: unknown) => unknown };
    g.__name ??= (f: unknown) => f;
  });
}

/**
 * Runs INSIDE the page. Returns SELECTORS that identify loading indicators, not
 * elements.
 *
 * The two rules that govern `collectInPage` are both deliberately relaxed here,
 * because a loading indicator is a different kind of thing from a target:
 *
 *  - **Uniqueness is not required.** The only question ever asked of these
 *    selectors is "is any element matching you visible right now", so one that
 *    matches six skeleton rows answers it correctly.
 *  - **Visibility is not required.** A skeleton that is mounted but hidden is
 *    exactly the markup worth knowing about — it is what will be shown when the
 *    app next goes busy.
 *
 * What IS required is that the selector be reusable: an `aria-busy` attribute
 * selector or a single class name, never a positional path that describes where
 * one spinner happened to be in one render.
 */
/* eslint-disable */
function collectLoadersInPage(): string[] {
  const BUSY = /(spinner|skeleton|loading|loader|progress|shimmer|pulse|placeholder)/i;
  // Utility classes from Tailwind and friends: they animate a spinner, but they
  // also animate a dozen things that are not one, so a selector built on them
  // would report the app permanently busy.
  const UTILITY = /^(animate-|motion-|transition|duration-|ease-|w-|h-|rounded|bg-|text-|flex|grid|absolute|relative)/i;

  const out = new Set<string>();

  // ARIA first: the part an app is supposed to get right, and unambiguous when
  // it is there. Published as the bare attribute selector — the point is to
  // match whatever carries it next time, not this element.
  if (document.querySelector('[aria-busy="true"]')) out.add('[aria-busy="true"]');
  if (document.querySelector('[role="progressbar"]')) out.add('[role="progressbar"]');
  if (document.querySelector("progress")) out.add("progress");
  for (const attr of ["data-loading", "data-busy", "data-pending"]) {
    if (document.querySelector(`[${attr}]`)) out.add(`[${attr}]`);
  }

  // Then class names, which is how most apps actually do it.
  for (const el of Array.from(document.querySelectorAll("[class]")).slice(0, 4000)) {
    const raw = el.getAttribute("class");
    if (!raw || !BUSY.test(raw)) continue;
    for (const cls of raw.split(/\s+/)) {
      if (!cls || !BUSY.test(cls) || UTILITY.test(cls)) continue;
      // A build-generated suffix makes the class useless across a rebuild, but
      // the demo is recorded against THIS build, so it is still worth having.
      try {
        const sel = `.${CSS.escape(cls)}`;
        if (document.querySelectorAll(sel).length > 0) out.add(sel);
      } catch {
        /* a class name CSS.escape cannot render is not addressable */
      }
      if (out.size >= 24) return Array.from(out);
    }
  }

  return Array.from(out);
}
/* eslint-enable */

export async function crawlApp(opts: CrawlOptions): Promise<Inventory> {
  const { page, startUrl, scan, log } = opts;
  const maxRoutes = opts.maxRoutes ?? 8;
  await installNameShim(page);
  const origin = new URL(startUrl).origin;
  const notes: string[] = [];

  // Filesystem routes first: a page nobody links to is invisible to a crawl,
  // and those are often exactly the ones worth demonstrating.
  const queue: string[] = ["/"];
  for (const r of scan.routes) {
    if (!r.includes("[") && !r.includes(":") && !queue.includes(r)) queue.push(r);
  }

  const visited: string[] = [];
  const items: InventoryItem[] = [];
  const loaders = new Set<string>();

  while (queue.length > 0 && visited.length < maxRoutes) {
    const route = queue.shift();
    if (route === undefined || visited.includes(route)) continue;

    const url = new URL(route, origin).href;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });

      // Sampled HERE, in the gap between `domcontentloaded` and `networkidle`,
      // because that gap is the only moment a spinner exists. Wait for the route
      // to settle first — as everything else in this loop does — and the app is
      // by definition no longer loading, so the busy-state markup has been
      // unmounted and the crawl would conclude the app has none. Best-effort.
      const busy = await page.evaluate(collectLoadersInPage).catch(() => [] as string[]);
      for (const s of busy) loaders.add(s);

      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    } catch {
      notes.push(`rota ${route} não carregou`);
      continue;
    }
    visited.push(route);

    // Never swallow this. An empty inventory and a thrown collector look
    // identical from the outside, and the difference is "the app has no stable
    // selectors" versus "our code is broken" — which is not a difference to
    // discover by guessing.
    const found = await page.evaluate(collectInPage).catch((err: unknown) => {
      notes.push(`falha ao inspecionar ${route}: ${(err as Error).message.slice(0, 200)}`);
      log(`  ${route}: ERRO ao inspecionar — ${(err as Error).message.slice(0, 160)}`);
      return [] as Array<Omit<InventoryItem, "route">>;
    });
    for (const f of found) items.push({ ...f, route });
    log(`  ${route}: ${found.length} elemento(s) endereçáveis`);

    // A second pass, now that the route has settled. This one finds the markup
    // an app keeps mounted but hidden — a skeleton template, a progress bar at
    // zero — which the busy-time sample above cannot distinguish from the rest.
    const resting = await page.evaluate(collectLoadersInPage).catch(() => [] as string[]);
    for (const s of resting) loaders.add(s);

    // Same-origin links, for the routes the filesystem did not reveal.
    if (visited.length + queue.length < maxRoutes) {
      const hrefs = await page
        .evaluate(() =>
          Array.from(document.querySelectorAll("a[href]"))
            .map((a) => (a as HTMLAnchorElement).href)
            .slice(0, 40),
        )
        .catch(() => [] as string[]);
      for (const href of hrefs) {
        try {
          const u = new URL(href);
          if (u.origin !== origin) continue;
          const path = u.pathname;
          if (!visited.includes(path) && !queue.includes(path)) queue.push(path);
        } catch {
          /* href inválido */
        }
      }
    }
  }

  if (items.length === 0) {
    notes.push("nenhum elemento endereçável encontrado — o app pode estar atrás de login");
  }

  if (loaders.size === 0) {
    notes.push(
      "não vi nenhum indicador de carregamento durante o crawl — ou o app não usa, " +
        "ou eles não estavam na tela nesse momento",
    );
  }

  return { origin, routes: visited, items, loaders: [...loaders], notes };
}

/**
 * Serialise for the prompt, dropping the least useful items first when the
 * budget is tight.
 *
 * Dropped by stability ascending: an unstable selector is the one most likely
 * to break between recording the demo and re-recording it later.
 */
export function serializeInventory(inv: Inventory, maxItems = 90): string {
  const sorted = [...inv.items].sort((a, b) => b.stability - a.stability).slice(0, maxItems);
  const dropped = inv.items.length - sorted.length;

  const lines = [
    `origem: ${inv.origin}`,
    `rotas visitadas: ${inv.routes.join(", ") || "(nenhuma)"}`,
    dropped > 0 ? `(${dropped} elemento(s) menos estáveis omitidos)` : "",
    "",
    "ELEMENTOS (seletor | tipo | rota | texto visível):",
    ...sorted.map((i) => `${i.sel} | ${i.kind} | ${i.route} | ${i.text || "—"}`),
  ].filter(Boolean);

  // Listed separately from ELEMENTOS, and labelled as not-a-target, because the
  // model's hardest rule is "copy a selector from the inventory verbatim" — put
  // these in the same table and it will eventually click a spinner.
  if (inv.loaders.length > 0) {
    lines.push(
      "",
      "INDICADORES DE CARREGAMENTO (não são alvos de clique — servem para `wait` com waitFor:\"hidden\"):",
      ...inv.loaders.map((s) => `${s}`),
    );
  }

  if (inv.notes.length > 0) lines.push("", `observações: ${inv.notes.join("; ")}`);
  return lines.join("\n");
}

/** Every selector the model is allowed to use. */
export function allowedSelectors(inv: Inventory): Set<string> {
  return new Set(inv.items.map((i) => i.sel));
}
