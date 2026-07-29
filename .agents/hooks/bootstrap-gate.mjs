#!/usr/bin/env node
/**
 * Stop hook — bootstrap completion gate.
 *
 * Blocks turn termination while the skills-system bootstrap has unfinished
 * phases, so "complete the mission" is a deterministic guarantee instead of a
 * hope. Exit 0 = allow stop. Exit 2 = block and force the agent to continue.
 *
 * Every branch here is fail-SAFE: anything unexpected allows the stop. A Stop
 * hook that blocks on its own bugs is worse than no Stop hook, because it makes
 * the session impossible to end.
 *
 *   - `stop_hook_active` true  → allow (Claude Code sets this when the stop was
 *     already triggered by a hook; ignoring it is how you build an infinite loop)
 *   - state file missing / unparseable → allow
 *   - all phases done+gated    → allow (the hook becomes inert once the
 *     bootstrap finished, which is why it is safe to leave installed)
 *   - blocked more than MAX_BLOCKS times → allow, with a report. A genuinely
 *     stuck gate must surface to the human, not spin.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const STATE = resolve(process.cwd(), ".agents/skills/.bootstrap-state.json");
const MAX_BLOCKS = 3;

const allow = () => process.exit(0);

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  allow();
}

let payload = {};
try {
  payload = JSON.parse(input || "{}");
} catch {
  allow();
}

// The one flag that must never be ignored.
if (payload.stop_hook_active === true) allow();

let state;
try {
  state = JSON.parse(readFileSync(STATE, "utf8"));
} catch {
  allow(); // no bootstrap in progress
}

const phases = Array.isArray(state?.phases) ? state.phases : [];
if (phases.length === 0) allow();

const pending = phases.filter((p) => !(p.done === true && p.gate_passed === true));
if (pending.length === 0) allow();

const blocks = Number(state.stop_blocks ?? 0) + 1;
try {
  writeFileSync(STATE, JSON.stringify({ ...state, stop_blocks: blocks }, null, 2) + "\n", "utf8");
} catch {
  /* state is advisory; never fail the hook on a write error */
}

if (blocks > MAX_BLOCKS) {
  console.error(
    `[bootstrap-gate] ${pending.length} phase(s) still open after ${MAX_BLOCKS} blocks — ` +
      `allowing stop so a human can look. Open: ${pending.map((p) => `${p.id}:${p.name}`).join(", ")}`,
  );
  allow();
}

console.error(
  `[bootstrap-gate] Bootstrap incomplete — continue.\n` +
    pending
      .map((p) => `  phase ${p.id} (${p.name}): done=${p.done === true} gate_passed=${p.gate_passed === true}` +
        (p.artifact ? ` artifact=${p.artifact}` : ""))
      .join("\n") +
    `\nRun each phase's gate, write its artifact, then set done+gate_passed in ${STATE}.`,
);
process.exit(2);
