#!/usr/bin/env node
/**
 * PreToolUse gate on SKILL.md writes.
 *
 * Makes "no skill update without an external signal" a mechanism rather than a
 * request. Blocks Write/Edit on any `**\/skills/**\/SKILL.md` unless a fresh
 * token minted by `skill-verify.mjs` exists for that skill.
 *
 * Exit 0 = allow, exit 2 = block.
 *
 * WHAT IT GUARANTEES: the verification pipeline ran, green, for this skill,
 * within the token's lifetime.
 *
 * WHAT IT DOES NOT: that the prose about to be written is true. Nothing
 * mechanical can check that. The pipeline is therefore promote-or-discard —
 * verify again after the write and revert if it goes red. Stating the limit
 * matters: a gate believed to prove more than it does is worse than no gate,
 * because it converts caution into false confidence.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const TOKEN = resolve(process.cwd(), ".agents/skills/.validation-token.json");

const allow = () => process.exit(0);
const block = (msg) => {
  console.error(msg);
  process.exit(2);
};

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  allow(); // unreadable input is not evidence of a violation
}

const tool = payload.tool_name ?? "";
if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) allow();

const path = payload.tool_input?.file_path ?? "";
const m = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/.exec(path);
if (!m) allow();

const skill = m[1];

if (!existsSync(TOKEN)) {
  block(
    `[skill-write-gate] Blocked: no validation token for "${skill}".\n` +
      `A skill is memory — a wrong entry gets retrieved on similar tasks and followed.\n` +
      `Run the pipeline first:\n\n` +
      `  node .agents/scripts/skill-verify.mjs ${skill} --intent "what you are changing and why"\n\n` +
      `If it is red, that is the answer: discard the write. See meta-skill-evolution.`,
  );
}

let token;
try {
  token = JSON.parse(readFileSync(TOKEN, "utf8"));
} catch {
  block(`[skill-write-gate] Blocked: the validation token is unreadable. Re-run skill-verify.mjs for "${skill}".`);
}

if (token.skill !== skill) {
  block(
    `[skill-write-gate] Blocked: the token is for "${token.skill}", not "${skill}".\n` +
      `Tokens are per skill on purpose — verifying one skill says nothing about another.\n` +
      `  node .agents/scripts/skill-verify.mjs ${skill} --intent "…"`,
  );
}

if (Date.parse(token.expires_at) < Date.now()) {
  block(
    `[skill-write-gate] Blocked: the token for "${skill}" expired at ${token.expires_at}.\n` +
      `Tokens are short-lived so a green run cannot be banked and spent later against different content.\n` +
      `  node .agents/scripts/skill-verify.mjs ${skill} --intent "…"`,
  );
}

console.error(`[skill-write-gate] "${skill}" — token valid${token.intent ? ` (intent: ${token.intent})` : ""}.`);
allow();
