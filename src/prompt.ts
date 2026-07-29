/**
 * Terminal questions, in Portuguese, with no dependency.
 *
 * `node:readline/promises` is enough; a prompt library would be a runtime
 * dependency for `npx demovid` in exchange for colours.
 *
 * Everything writes to **stderr**. stdout is reserved for real output — the
 * path of the finished video — so `demovid ... | xargs mpv` keeps working, and
 * a question printed to stdout would corrupt it.
 *
 * Non-TTY is a first-class case, not an error to stumble into: in CI or behind
 * a pipe there is nobody to answer, so callers check `isInteractive()` and take
 * the flag-driven path instead of blocking forever on a read that never
 * returns.
 */
import { createInterface, type Interface } from "node:readline/promises";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

let rl: Interface | null = null;

function io(): Interface {
  rl ??= createInterface({ input: process.stdin, output: process.stderr });
  return rl;
}

/** Release the terminal. Safe to call more than once. */
export function closePrompt(): void {
  rl?.close();
  rl = null;
}

/** Free-text question. Returns the trimmed answer, possibly empty. */
export async function ask(question: string): Promise<string> {
  const answer = await io().question(`\n${question}\n> `);
  return answer.trim();
}

/**
 * Keep asking until the answer is non-empty.
 *
 * Used for the one input the whole flow depends on — what to demonstrate.
 * Accepting an empty description here would send an empty prompt to the model
 * and burn a slow, expensive call producing a storyboard about nothing.
 */
export async function askRequired(question: string, hint?: string): Promise<string> {
  for (;;) {
    const answer = await ask(question);
    if (answer) return answer;
    process.stderr.write(`[demovid] ${hint ?? "preciso de uma resposta para seguir."}\n`);
  }
}

export type GateAnswer =
  | { kind: "approve" }
  | { kind: "abort" }
  | { kind: "revise"; text: string };

/**
 * The approval gate: Enter approves, `n` aborts, anything else is a revision
 * request in plain Portuguese.
 *
 * Free text as the third option rather than a menu, because the useful answer
 * is almost never "yes" or "no" — it is "shorter, and skip the login part".
 */
export async function gate(question: string): Promise<GateAnswer> {
  const answer = await ask(question);
  if (answer === "") return { kind: "approve" };
  const lower = answer.toLowerCase();
  if (lower === "n" || lower === "não" || lower === "nao" || lower === "cancelar") {
    return { kind: "abort" };
  }
  return { kind: "revise", text: answer };
}
