#!/usr/bin/env node
/**
 * Deterministic linter for SKILL.md files.
 *
 * Exists because prose about conventions is advisory and a check is a
 * guarantee. Everything this script can decide mechanically is therefore NOT
 * written as guidance inside the skills themselves.
 *
 *   node .agents/scripts/skill-lint.mjs [skill-name]   # all skills if omitted
 *
 * Exit 0 = clean. Exit 1 = at least one error. Warnings never fail the run;
 * they are budget nudges, not correctness claims.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(process.cwd());
const SKILLS = join(ROOT, ".agents/skills");

/** Body budget. Above this a skill stops being loadable context and becomes a document. */
const MAX_BODY_LINES = 500;
const MAX_BODY_TOKENS = 5000;
const TARGET_MEDIAN_TOKENS = 1400;
const MAX_NAME = 64;
const MAX_DESC = 1024;

/**
 * `name` must be a gerund for knowledge/task skills — it reads as an activity,
 * which is what the model is matching against. The router and the meta-skills
 * keep conventional names because they are addressed by identity, not activity;
 * exempting them explicitly beats silently weakening the rule for everyone.
 */
const GERUND_EXEMPT = new Set(["project-router", "meta-skill-evolution", "meta-skill-consolidate"]);

const estimateTokens = (s) => Math.ceil(s.length / 4);

export function lintSkill(name) {
  const dir = join(SKILLS, name);
  const file = join(dir, "SKILL.md");
  const errors = [];
  const warnings = [];

  if (!existsSync(file)) return { name, errors: [`${file} does not exist`], warnings };

  const raw = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) return { name, errors: ["missing or malformed YAML frontmatter (--- … ---)"], warnings };

  const [, fmRaw, body] = m;
  let fm;
  try {
    fm = parseYaml(fmRaw);
  } catch (e) {
    return { name, errors: [`frontmatter is not valid YAML: ${e.message}`], warnings };
  }

  // ── frontmatter shape ────────────────────────────────────────────────────
  const allowed = new Set(["name", "description", "metadata"]);
  for (const k of Object.keys(fm ?? {})) {
    if (!allowed.has(k)) errors.push(`frontmatter key "${k}" is not portable — only name, description, metadata`);
  }

  if (fm?.name !== name) errors.push(`frontmatter name "${fm?.name}" does not match directory "${name}"`);
  if (typeof fm?.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name)) {
    errors.push(`name must be lowercase letters/digits/hyphens: "${fm?.name}"`);
  }
  if ((fm?.name?.length ?? 0) > MAX_NAME) errors.push(`name is ${fm.name.length} chars, max ${MAX_NAME}`);

  const type = fm?.metadata?.type;
  if (!["knowledge", "task", "router", "meta"].includes(type)) {
    errors.push(`metadata.type must be knowledge|task|router|meta, got "${type}"`);
  }
  if ((type === "knowledge" || type === "task") && !GERUND_EXEMPT.has(name)) {
    if (!/^[a-z]+ing-/.test(fm?.name ?? "")) {
      errors.push(`name must start with a gerund (verb+-ing), e.g. "recording-demos": "${fm?.name}"`);
    }
  }
  if (type !== "router" && !fm?.metadata?.verification_signal) {
    errors.push("metadata.verification_signal is required — an update with no external signal cannot be validated");
  }

  // ── description: the only signal at selection time ───────────────────────
  const desc = fm?.description ?? "";
  if (typeof desc !== "string" || desc.length === 0) errors.push("description is required");
  if (desc.length > MAX_DESC) errors.push(`description is ${desc.length} chars, max ${MAX_DESC}`);
  if (/^(I |You |We )/.test(desc)) errors.push("description must be third person (no I/You/We opener)");
  if (!/\buse (it )?(when|whenever|for|any time|every time)\b/i.test(desc)) {
    errors.push('description must state WHEN to use it (a "Use when/whenever…" clause) — under-triggering is the common failure');
  }

  // ── body budget ──────────────────────────────────────────────────────────
  const lines = body.split("\n").length;
  const tokens = estimateTokens(body);
  if (lines > MAX_BODY_LINES) errors.push(`body is ${lines} lines, max ${MAX_BODY_LINES} — move detail to references/`);
  if (tokens > MAX_BODY_TOKENS) errors.push(`body is ~${tokens} tokens, max ${MAX_BODY_TOKENS}`);
  if (tokens > TARGET_MEDIAN_TOKENS * 2) warnings.push(`body is ~${tokens} tokens; median target is ~${TARGET_MEDIAN_TOKENS}`);

  // ── clean state in file, history in git ──────────────────────────────────
  if (/^#+\s*(changelog|history|revision)/im.test(body)) {
    errors.push("no changelog/history sections — git already provides history, diff, blame and rollback");
  }
  if (/\b20\d{2}-\d{2}-\d{2}\b/.test(body)) {
    warnings.push("contains an ISO date; dates go stale in-file — prefer provenance hashes");
  }

  // ── unexplained shouting ─────────────────────────────────────────────────
  for (const kw of ["MUST", "ALWAYS", "NEVER"]) {
    const re = new RegExp(`(^|[^\`\\w])${kw}([^\`\\w]|$)`, "g");
    const hits = [...body.matchAll(re)];
    for (const h of hits) {
      const idx = h.index ?? 0;
      const around = body.slice(Math.max(0, idx - 200), idx + 200);
      // A shout is fine when the sentence explains itself. "Why:", "because",
      // "so that" nearby is the evidence that it does.
      if (!/(because|why|so that|otherwise|reason)/i.test(around)) {
        warnings.push(`"${kw}" without a nearby rationale — explain the why instead of shouting`);
        break;
      }
    }
  }

  // ── task skills carry the evolution contract ─────────────────────────────
  if (type === "task" && !/<evolution>/.test(body)) {
    errors.push("task skills must end with an <evolution> section (the memory pipeline entry point)");
  }

  // ── provenance: cited, and the citation must resolve ─────────────────────
  const cites = [...body.matchAll(/`([\w./-]+\.[a-z]+):(\d+)(?:-\d+)?(?:@([0-9a-f]{7,40}))?`/g)];
  if ((type === "knowledge" || type === "task") && cites.length === 0) {
    errors.push("no provenance citations (`path/file:line@hash`) — a claim you cannot trace cannot be revalidated");
  }
  for (const [, path, lineStr] of cites) {
    const abs = join(ROOT, path);
    if (!existsSync(abs)) {
      errors.push(`provenance points at a file that does not exist: ${path}`);
      continue;
    }
    if (!statSync(abs).isFile()) continue;
    const total = readFileSync(abs, "utf8").split("\n").length;
    if (Number(lineStr) > total) {
      errors.push(`provenance ${path}:${lineStr} is past end of file (${total} lines) — the code moved`);
    }
  }

  return { name, errors, warnings, stats: { lines, tokens, cites: cites.length, type } };
}

export const listSkills = () =>
  existsSync(SKILLS)
    ? readdirSync(SKILLS, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(SKILLS, d.name, "SKILL.md")))
        .map((d) => d.name)
        .sort()
    : [];

export const skillHash = (name) =>
  createHash("sha256").update(readFileSync(join(SKILLS, name, "SKILL.md"))).digest("hex").slice(0, 16);

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[2];
  const names = only ? [only] : listSkills();
  if (names.length === 0) {
    console.error("no skills found under .agents/skills/");
    process.exit(1);
  }

  let failed = 0;
  const tokenList = [];
  for (const n of names) {
    const r = lintSkill(n);
    if (r.stats) tokenList.push(r.stats.tokens);
    const mark = r.errors.length ? "✗" : "✓";
    const stat = r.stats ? `${String(r.stats.lines).padStart(3)}L ~${String(r.stats.tokens).padStart(4)}tok ${r.stats.cites} cites` : "";
    console.log(`  ${mark} ${n.padEnd(38)} ${stat}`);
    for (const e of r.errors) console.log(`      ERROR ${e}`);
    for (const w of r.warnings) console.log(`      warn  ${w}`);
    if (r.errors.length) failed++;
  }

  if (tokenList.length) {
    const sorted = [...tokenList].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`\n  ${names.length} skill(s), median ~${median} tokens (target ~${TARGET_MEDIAN_TOKENS})`);
  }
  console.log(failed ? `\n[skill-lint] ${failed} skill(s) with errors` : "\n[skill-lint] clean");
  process.exit(failed ? 1 : 0);
}
