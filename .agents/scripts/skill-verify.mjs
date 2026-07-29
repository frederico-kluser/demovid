#!/usr/bin/env node
/**
 * The external validation signal for a skill — the thing that authorises a write.
 *
 *   node .agents/scripts/skill-verify.mjs <skill> [--intent "one line"]
 *   node .agents/scripts/skill-verify.mjs --all
 *
 * Runs four deterministic checks and, only if all pass, mints a short-lived
 * token that the PreToolUse write-gate requires:
 *
 *   1. lint          — form (see skill-lint.mjs)
 *   2. claims        — the skill's factual assertions still hold against the repo
 *   3. routing       — must_trigger/must_not_trigger queries still resolve here
 *   4. signal        — the skill's declared verification_signal command is green
 *
 * WHAT THIS DOES NOT PROVE, stated plainly so the guarantee is not overclaimed:
 * the token attests that the pipeline RAN and the repo agreed with the skill at
 * that moment. It cannot attest that prose you are about to write is true. That
 * is why the pipeline is promote-or-discard: verify again after the write, and
 * revert if it goes red. The gate's job is to make it impossible to edit a skill
 * without having run the pipeline at all.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { lintSkill, listSkills, skillHash } from "./skill-lint.mjs";

const ROOT = resolve(process.cwd());
const SKILLS = join(ROOT, ".agents/skills");
const TOKEN = join(SKILLS, ".validation-token.json");
/** Long enough to write a considered edit, short enough that it cannot be banked. */
const TTL_MS = 30 * 60 * 1000;

const readSkill = (name) => {
  const raw = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  return { fm: m ? parseYaml(m[1]) : {}, body: m ? m[2] : raw, raw };
};

const readEval = (name) => {
  const f = join(SKILLS, name, "eval.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};

/**
 * Claim checks — the staleness detector.
 *
 * Each asserts something the skill states about the repo. When someone
 * refactors the cited code away, the claim goes red and the knowledge is
 * flagged before it can be retrieved and followed. This is the concrete
 * defence against a skill quietly describing a codebase that no longer exists.
 */
function checkClaims(name, spec) {
  const out = [];
  for (const c of spec?.claims ?? []) {
    let ok = false;
    let detail = "";
    try {
      switch (c.assert) {
        case "file-exists":
          ok = existsSync(join(ROOT, c.path));
          detail = c.path;
          break;
        case "file-contains": {
          const p = join(ROOT, c.path);
          ok = existsSync(p) && readFileSync(p, "utf8").includes(c.needle);
          detail = `${c.path} contains ${JSON.stringify(c.needle)}`;
          break;
        }
        case "file-lacks": {
          const p = join(ROOT, c.path);
          ok = existsSync(p) && !readFileSync(p, "utf8").includes(c.needle);
          detail = `${c.path} lacks ${JSON.stringify(c.needle)}`;
          break;
        }
        case "npm-script": {
          const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
          ok = Boolean(pkg.scripts?.[c.name]);
          detail = `npm script "${c.name}"`;
          break;
        }
        default:
          detail = `unknown assert "${c.assert}"`;
      }
    } catch (e) {
      detail = `${c.assert}: ${e.message}`;
    }
    out.push({ ok, detail, why: c.why });
  }
  return out;
}

/**
 * Routing regression check.
 *
 * Scores each skill's description against a query by trigger-word overlap and
 * asserts the expected skill wins. It is not the model's actual selector — but
 * the failure mode it catches IS the real one: two descriptions competing for
 * the same trigger, which is how a catalog silently starts misrouting as it grows.
 */
const STOP = new Set(("a an the and or of to in for on with when whenever use uses used it its this that " +
  "is are be by from at as any every even if do does not you your").split(" "));

const words = (s) => s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g)?.filter((w) => !STOP.has(w)) ?? [];

export function routeScore(query, desc, name) {
  const q = new Set(words(query));
  const d = words(`${name.replace(/-/g, " ")} ${desc}`);
  let hits = 0;
  for (const w of new Set(d)) if (q.has(w)) hits++;
  return hits;
}

export function bestSkillFor(query, skills) {
  let best = null;
  let bestScore = -1;
  let tie = false;
  for (const { name, description } of skills) {
    const s = routeScore(query, description, name);
    if (s > bestScore) {
      best = name;
      bestScore = s;
      tie = false;
    } else if (s === bestScore && s > 0) tie = true;
  }
  return { best, score: bestScore, tie };
}

function checkRouting(name, spec, allSkills) {
  const out = [];
  for (const q of spec?.routing?.must_trigger ?? []) {
    const { best, score, tie } = bestSkillFor(q, allSkills);
    out.push({
      ok: best === name && score > 0 && !tie,
      detail: `must trigger → "${q}" resolved to ${best ?? "nothing"}${tie ? " (TIE)" : ""}`,
    });
  }
  for (const q of spec?.routing?.must_not_trigger ?? []) {
    const { best } = bestSkillFor(q, allSkills);
    out.push({ ok: best !== name, detail: `must NOT trigger → "${q}" resolved to ${best ?? "nothing"}` });
  }
  return out;
}

/** Run the skill's declared verification_signal, when it is a repo command. */
function checkSignal(signal) {
  if (!signal) return { ok: false, detail: "no verification_signal declared" };
  const m = /^(npm run [\w:-]+|npm test|node [\w./-]+(?: [\w./-]+)*)$/.exec(signal.trim());
  if (!m) return { ok: true, detail: `signal "${signal}" is not a runnable command — treated as documentation`, soft: true };
  try {
    execFileSync("sh", ["-c", signal], { cwd: ROOT, stdio: "pipe", timeout: 10 * 60_000 });
    return { ok: true, detail: `\`${signal}\` green` };
  } catch (e) {
    const tail = String(e.stdout ?? "").split("\n").slice(-6).join("\n");
    return { ok: false, detail: `\`${signal}\` FAILED\n${tail}` };
  }
}

function verify(name, allSkills, { runSignal }) {
  const { fm } = readSkill(name);
  const spec = readEval(name);
  const results = [];

  const lint = lintSkill(name);
  results.push({ group: "lint", ok: lint.errors.length === 0, items: lint.errors.map((e) => ({ ok: false, detail: e })) });

  if (!spec) {
    results.push({ group: "eval", ok: false, items: [{ ok: false, detail: "no eval.json — a skill with no eval cannot be gated" }] });
  } else {
    const claims = checkClaims(name, spec);
    results.push({ group: "claims", ok: claims.every((c) => c.ok), items: claims });
    const routing = checkRouting(name, spec, allSkills);
    results.push({ group: "routing", ok: routing.every((r) => r.ok), items: routing });
  }

  if (runSignal) {
    const sig = checkSignal(fm?.metadata?.verification_signal);
    results.push({ group: "signal", ok: sig.ok, items: [sig] });
  }

  return { name, results, ok: results.every((r) => r.ok) };
}

// ── cli ────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const runSignal = argv.includes("--signal");
  const intentIdx = argv.indexOf("--intent");
  const intent = intentIdx >= 0 ? argv[intentIdx + 1] : undefined;
  const only = argv.find((a) => !a.startsWith("--") && a !== intent);

  const names = listSkills();
  const allSkills = names.map((n) => {
    const { fm } = readSkill(n);
    return { name: n, description: fm?.description ?? "" };
  });

  const targets = all ? names : only ? [only] : [];
  if (targets.length === 0) {
    console.error("usage: skill-verify.mjs <skill> [--intent \"…\"] [--signal]  |  --all");
    process.exit(1);
  }

  let failed = 0;
  for (const n of targets) {
    const r = verify(n, allSkills, { runSignal });
    console.log(`\n${r.ok ? "✓" : "✗"} ${n}`);
    for (const g of r.results) {
      if (g.items.length === 0) continue;
      for (const i of g.items) {
        if (!i.ok || process.env.VERBOSE) {
          console.log(`    ${i.ok ? "·" : "✗"} [${g.group}] ${i.detail}${i.why ? `  (${i.why})` : ""}`);
        }
      }
    }
    if (!r.ok) failed++;
  }

  if (failed) {
    console.log(`\n[skill-verify] ${failed}/${targets.length} failed — no token minted.`);
    process.exit(1);
  }

  if (!all) {
    const name = targets[0];
    writeFileSync(
      TOKEN,
      JSON.stringify(
        {
          skill: name,
          hash_at_verify: skillHash(name),
          intent: intent ?? null,
          signal: readSkill(name).fm?.metadata?.verification_signal ?? null,
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + TTL_MS).toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`\n[skill-verify] green — token minted for "${name}" (valid ${TTL_MS / 60000} min).`);
  } else {
    console.log(`\n[skill-verify] all ${targets.length} skill(s) green.`);
  }
}
