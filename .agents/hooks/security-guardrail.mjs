#!/usr/bin/env node
/**
 * PreToolUse security guardrail.
 *
 * Block-only: it never edits, moves or deletes anything. It refuses two classes
 * of action that no task in this repository needs and that are unrecoverable
 * when they are wrong.
 *
 * Exit 0 = allow, exit 2 = block. Hooks fire for subagent tool calls too, so
 * these apply recursively.
 *
 * Scope is deliberately narrow. A guardrail that blocks ordinary work gets
 * disabled, and a disabled guardrail protects nothing.
 */
import { readFileSync } from "node:fs";

const allow = () => process.exit(0);
const block = (msg) => {
  console.error(msg);
  process.exit(2);
};

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  allow();
}

const tool = payload.tool_name ?? "";
const input = payload.tool_input ?? {};

// ── 1. Secrets stay out of the context window ─────────────────────────────
// Once a key is read it is in the transcript, and a transcript travels further
// than the file did. This repo reads credentials from process.env only.
const SECRET_PATHS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)secrets\//,
  /(^|\/)\.secrets$/,
  /(^|\/)id_(rsa|ed25519)$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.aws\/credentials$/,
];

if (["Read", "Write", "Edit", "MultiEdit"].includes(tool)) {
  const p = String(input.file_path ?? "");
  if (SECRET_PATHS.some((re) => re.test(p))) {
    block(
      `[security-guardrail] Blocked: ${p} holds credentials.\n` +
        `This project reads secrets from process.env; the shell wrapper loads them. ` +
        `Reading the file would put the key in the transcript.`,
    );
  }
}

if (tool === "Bash") {
  const cmd = String(input.command ?? "");

  // Same rule, reached through a shell.
  if (/\b(cat|less|more|head|tail|bat|xxd|strings)\b[^|;&]*(\.env\b|\/secrets\/|\.secrets\b|id_rsa|id_ed25519)/.test(cmd)) {
    block(`[security-guardrail] Blocked: that command would print a credentials file into the transcript.`);
  }

  // ── 2. Unrecoverable operations ─────────────────────────────────────────
  // Not "dangerous-looking" — genuinely unrecoverable, or destructive to work
  // that is not ours. Everything else is left alone on purpose.
  const DESTRUCTIVE = [
    // Matches the target being root/home ITSELF (optionally with a trailing
    // slash or glob), and deliberately not a path underneath it — `rm -rf
    // /tmp/x` and `rm -rf node_modules` are ordinary and must stay allowed.
    { re: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\s+(\/|~|\$HOME)\/?\*?(\s|$)/, why: "recursive force-delete of root or the home directory itself" },
    { re: /\bgit\s+push\b[^\n]*--force(?!-with-lease)/, why: "force-push without --force-with-lease overwrites work you cannot see" },
    { re: /\bgit\s+(filter-branch|filter-repo)\b/, why: "history rewrite" },
    { re: /\bgit\s+reset\s+--hard\b[^\n]*\borigin\//, why: "hard reset onto a remote ref discards local commits irrecoverably" },
    { re: /\bmkfs\b|\bdd\s+[^\n]*of=\/dev\//, why: "writes directly to a device" },
    { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, why: "fork bomb" },
  ];

  for (const d of DESTRUCTIVE) {
    if (d.re.test(cmd)) {
      block(
        `[security-guardrail] Blocked: ${d.why}.\n` +
          `If this is genuinely intended, run it yourself so the decision is yours — ` +
          `an agent should not be the one to take an unrecoverable action.`,
      );
    }
  }
}

allow();
