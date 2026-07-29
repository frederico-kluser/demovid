#!/usr/bin/env node
/**
 * End-to-end validation of the skills system.
 *
 * Written as an executable rather than prose because a report asserting that a
 * system works, without running it, is precisely the artefact this system exists
 * to distrust.
 *
 *   node .agents/scripts/validate-system.mjs
 *
 * Every mutating test backs the file up and restores it in a finally, so a
 * failed run cannot leave the repository altered.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listSkills } from "./skill-lint.mjs";

const ROOT = resolve(process.cwd());
const SKILLS = join(ROOT, ".agents/skills");
const TOKEN = join(SKILLS, ".validation-token.json");

let failures = 0;
const results = [];

const check = (name, fn) => {
  let ok = false;
  let detail = "";
  try {
    const r = fn();
    ok = r === true || r?.ok === true;
    detail = typeof r === "object" ? (r.detail ?? "") : "";
  } catch (e) {
    detail = e.message.split("\n")[0];
  }
  if (!ok) failures++;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `\n      ${detail}` : ""}`);
};

/** Run a command; return {code, out}. Never throws. */
const sh = (cmd) => {
  try {
    return { code: 0, out: execFileSync("sh", ["-c", cmd], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
};

/** Feed a hook its stdin payload and return the exit code. */
const hook = (script, payload) => {
  try {
    execFileSync("node", [script], { cwd: ROOT, input: JSON.stringify(payload), stdio: "pipe" });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
};

/** Mutate a file, run fn, always restore. */
const withMutation = (relPath, mutate, fn) => {
  const abs = join(ROOT, relPath);
  const original = readFileSync(abs, "utf8");
  try {
    writeFileSync(abs, mutate(original), "utf8");
    return fn();
  } finally {
    writeFileSync(abs, original, "utf8");
  }
};

console.log("\n── A. Routing evals ───────────────────────────────────────────────────");

const skills = listSkills();
let mustTrigger = 0;
let mustNot = 0;
for (const s of skills) {
  const f = join(SKILLS, s, "eval.json");
  if (!existsSync(f)) continue;
  const spec = JSON.parse(readFileSync(f, "utf8"));
  mustTrigger += spec.routing?.must_trigger?.length ?? 0;
  mustNot += spec.routing?.must_not_trigger?.length ?? 0;
}

check(`every skill has an eval.json (${skills.length} skills)`, () => {
  const missing = skills.filter((s) => !existsSync(join(SKILLS, s, "eval.json")));
  return { ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : `${mustTrigger} must-trigger + ${mustNot} must-not-trigger queries` };
});

check("all skills pass lint + claims + routing", () => {
  const r = sh("node .agents/scripts/skill-verify.mjs --all");
  return { ok: r.code === 0, detail: r.code === 0 ? "" : r.out.split("\n").filter((l) => l.includes("✗")).slice(0, 4).join("\n      ") };
});

check("catalog.md is in sync with the skills", () => {
  const r = sh("node .agents/scripts/build-catalog.mjs --check");
  return { ok: r.code === 0, detail: r.code === 0 ? "" : "stale — regenerate it" };
});

console.log("\n── B. The write gate ──────────────────────────────────────────────────");

rmSync(TOKEN, { force: true });

check("SKILL.md write is BLOCKED with no token", () => {
  const code = hook(".agents/hooks/skill-write-gate.mjs", {
    tool_name: "Edit",
    tool_input: { file_path: ".agents/skills/recording-with-rec/SKILL.md" },
  });
  return { ok: code === 2, detail: code === 2 ? "" : `exit ${code}, expected 2` };
});

check("an ordinary source file is NOT blocked", () => {
  const code = hook(".agents/hooks/skill-write-gate.mjs", { tool_name: "Edit", tool_input: { file_path: "src/rec.ts" } });
  return { ok: code === 0, detail: code === 0 ? "" : `exit ${code}, expected 0` };
});

check("a token for another skill does NOT unlock this one", () => {
  sh('node .agents/scripts/skill-verify.mjs testing-demovid --intent "validation run"');
  const code = hook(".agents/hooks/skill-write-gate.mjs", {
    tool_name: "Edit",
    tool_input: { file_path: ".agents/skills/recording-with-rec/SKILL.md" },
  });
  return { ok: code === 2, detail: code === 2 ? "" : `exit ${code} — tokens must be per skill` };
});

check("an expired token does NOT unlock a write", () => {
  const t = JSON.parse(readFileSync(TOKEN, "utf8"));
  t.expires_at = new Date(Date.now() - 1000).toISOString();
  writeFileSync(TOKEN, JSON.stringify(t, null, 2));
  const code = hook(".agents/hooks/skill-write-gate.mjs", {
    tool_name: "Edit",
    tool_input: { file_path: `.agents/skills/${t.skill}/SKILL.md` },
  });
  return { ok: code === 2, detail: code === 2 ? "" : `exit ${code} — a green run must not be bankable` };
});

check("a fresh token for the right skill DOES unlock the write", () => {
  sh('node .agents/scripts/skill-verify.mjs testing-demovid --intent "validation run"');
  const code = hook(".agents/hooks/skill-write-gate.mjs", {
    tool_name: "Edit",
    tool_input: { file_path: ".agents/skills/testing-demovid/SKILL.md" },
  });
  return { ok: code === 0, detail: code === 0 ? "" : `exit ${code}, expected 0` };
});

console.log("\n── C. Rejecting a wrong learning ──────────────────────────────────────");

// An over-generalisation that READS as correct and is false: the stage bans
// will-change, so "the overlay never uses will-change" sounds like the same
// rule. The cursor legitimately uses it. A claim assertion is what catches this.
check("an over-generalised claim is caught by verification, not by taste", () => {
  const evalPath = ".agents/skills/working-with-the-camera-stage/eval.json";
  return withMutation(
    evalPath,
    (orig) => {
      const spec = JSON.parse(orig);
      spec.claims.push({
        assert: "file-lacks",
        path: "overlay/src/cursor.ts",
        needle: "will-change",
        why: "OVER-GENERALISATION under test: the ban is stage-only; the cursor uses it legitimately",
      });
      return JSON.stringify(spec, null, 2) + "\n";
    },
    () => {
      const r = sh("node .agents/scripts/skill-verify.mjs working-with-the-camera-stage");
      return {
        ok: r.code !== 0 && r.out.includes("cursor.ts"),
        detail: r.code !== 0 ? "verification went red, as it must — the write is discarded" : "NOT caught — the gate would have let a false rule through",
      };
    },
  );
});

check("no token is minted for a red skill", () => {
  const before = existsSync(TOKEN) ? readFileSync(TOKEN, "utf8") : "";
  const evalPath = ".agents/skills/working-with-the-camera-stage/eval.json";
  return withMutation(
    evalPath,
    (orig) => {
      const spec = JSON.parse(orig);
      spec.claims.push({ assert: "file-contains", path: "overlay/src/stage.ts", needle: "THIS_STRING_DOES_NOT_EXIST" });
      return JSON.stringify(spec, null, 2) + "\n";
    },
    () => {
      sh("node .agents/scripts/skill-verify.mjs working-with-the-camera-stage");
      const after = existsSync(TOKEN) ? readFileSync(TOKEN, "utf8") : "";
      return { ok: before === after, detail: before === after ? "token unchanged" : "a token was minted for a failing skill" };
    },
  );
});

console.log("\n── D. Staleness: the code moves, the skill goes red ───────────────────");

// Snapshot BEFORE the mutation tests. Comparing against a clean tree instead
// would fail on any unrelated uncommitted work, which says nothing about
// whether these tests cleaned up after themselves.
const treeBefore = sh("git status --porcelain -- src overlay .agents/skills").out;

check("removing a documented behaviour turns its skill red (code-aware)", () => {
  return withMutation(
    // Follows the code: the recorder moved out of `src/rec.ts` (now a re-export
    // facade) into `src/recorder/` when the external bash wrapper was absorbed.
    "src/recorder/index.ts",
    (orig) => orig.replace('this.#child.kill("SIGUSR2");', 'this.#child.kill("SIGTERM"); // simulated refactor'),
    () => {
      const r = sh("node .agents/scripts/skill-verify.mjs recording-with-rec");
      return {
        ok: r.code !== 0 && r.out.includes("SIGUSR2"),
        detail: r.code !== 0 ? "the skill's claim about SIGUSR2 failed — staleness detected before the advice could be followed" : "NOT detected — the skill would keep teaching a behaviour the code no longer has",
      };
    },
  );
});

check("the mutation tests restored everything they touched", () => {
  const treeAfter = sh("git status --porcelain -- src overlay .agents/skills").out;
  return {
    ok: treeBefore === treeAfter,
    detail: treeBefore === treeAfter ? "working tree identical to before the tests" : "a mutation leaked:\n      " + treeAfter,
  };
});

console.log("\n── E. Router lifecycle ────────────────────────────────────────────────");

check("router asks in Portuguese", () => {
  const body = readFileSync(join(SKILLS, "project-router/SKILL.md"), "utf8");
  const pt = (body.match(/"[^"]*\?"/g) ?? []).filter((q) => /\b(qual|como|o que|prefere|já existe|tem alguma)\b/i.test(q));
  return { ok: pt.length >= 5, detail: `${pt.length} ready-to-use Portuguese questions` };
});

check("TASK_PLAN.md is gitignored, so step 7 never deletes tracked work", () => {
  const r = sh("git check-ignore -q TASK_PLAN.md && echo ignored");
  return { ok: r.out.includes("ignored"), detail: r.out.includes("ignored") ? "" : "TASK_PLAN.md would be committed" };
});

check("TASK_PLAN.md lifecycle: create then delete leaves no trace", () => {
  const p = join(ROOT, "TASK_PLAN.md");
  writeFileSync(p, "# Plano de teste\n\nCritério de aceite: este arquivo não sobrevive à tarefa.\n");
  const created = existsSync(p);
  rmSync(p, { force: true });
  const gone = !existsSync(p);
  const clean = sh("git status --porcelain").out.includes("TASK_PLAN.md") === false;
  return { ok: created && gone && clean, detail: created && gone && clean ? "" : "the plan file survived or was tracked" };
});

check("bootstrap artifacts are tracked and were not deleted", () => {
  const required = [
    ".agents/bootstrap/project-analysis.md",
    ".agents/bootstrap/skill-map.md",
    ".agents/skills/catalog.md",
    ".agents/skills/.bootstrap-state.json",
  ];
  const missing = required.filter((f) => !existsSync(join(ROOT, f)));
  return { ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "" };
});

console.log("\n── F. Security guardrail ──────────────────────────────────────────────");

const MUST_BLOCK = ["rm -rf /", "rm -rf ~/", "cat .env", "git push --force origin main", "git filter-branch --all"];
const MUST_ALLOW = ["rm -rf node_modules", "rm -rf /tmp/x", "npm run verify", "git push --force-with-lease"];

check(`blocks ${MUST_BLOCK.length} unrecoverable commands`, () => {
  const bad = MUST_BLOCK.filter((c) => hook(".agents/hooks/security-guardrail.mjs", { tool_name: "Bash", tool_input: { command: c } }) !== 2);
  return { ok: bad.length === 0, detail: bad.length ? `NOT blocked: ${bad.join(", ")}` : "" };
});

check(`allows ${MUST_ALLOW.length} ordinary commands`, () => {
  const bad = MUST_ALLOW.filter((c) => hook(".agents/hooks/security-guardrail.mjs", { tool_name: "Bash", tool_input: { command: c } }) !== 0);
  return { ok: bad.length === 0, detail: bad.length ? `false positives: ${bad.join(", ")}` : "" };
});

check("blocks reading a credentials file", () => {
  const code = hook(".agents/hooks/security-guardrail.mjs", { tool_name: "Read", tool_input: { file_path: "/home/x/.secrets" } });
  return { ok: code === 2, detail: code === 2 ? "" : `exit ${code}` };
});

console.log("\n── G. Bootstrap Stop gate ─────────────────────────────────────────────");

check("Stop gate honours stop_hook_active (no infinite loop)", () => {
  const code = hook(".agents/hooks/bootstrap-gate.mjs", { stop_hook_active: true });
  return { ok: code === 0, detail: code === 0 ? "" : `exit ${code} — this would loop forever` };
});

check("Stop gate is fail-safe on unreadable state", () => {
  const p = join(ROOT, ".agents/skills/.bootstrap-state.json");
  const orig = readFileSync(p, "utf8");
  try {
    writeFileSync(p, "not json");
    const code = hook(".agents/hooks/bootstrap-gate.mjs", { stop_hook_active: false });
    return { ok: code === 0, detail: code === 0 ? "corrupt state allows the stop, as it must" : `exit ${code} — a broken hook would trap the session` };
  } finally {
    writeFileSync(p, orig);
  }
});

check("Stop gate BLOCKS while a phase is open", () => {
  const p = join(ROOT, ".agents/skills/.bootstrap-state.json");
  const orig = readFileSync(p, "utf8");
  try {
    const s = JSON.parse(orig);
    s.phases[4].done = false;
    s.phases[4].gate_passed = false;
    s.stop_blocks = 0;
    writeFileSync(p, JSON.stringify(s, null, 2));
    const code = hook(".agents/hooks/bootstrap-gate.mjs", { stop_hook_active: false });
    return { ok: code === 2, detail: code === 2 ? "" : `exit ${code}, expected 2` };
  } finally {
    writeFileSync(p, orig);
  }
});

// ── summary ───────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(72)}`);
console.log(failures === 0 ? `[validate-system] ${results.length} checks, all green` : `[validate-system] ${failures}/${results.length} FAILED`);
rmSync(TOKEN, { force: true });
process.exit(failures === 0 ? 0 : 1);
