# Hooks

Three hooks, wired in `.claude/settings.json` (the first two) and `.claude/settings.local.json` (the
third). All are **block-only**: they read a tool call on stdin, decide, and exit. None of them writes,
moves or deletes anything. Exit `0` allows, exit `2` blocks with a message.

They are committed because they are the deterministic half of this repository's conventions — a rule
that only exists as prose is advisory, and a rule in a hook is a guarantee. Being in a public repo,
they are kept short enough to audit at a glance.

## `security-guardrail.mjs` — PreToolUse on Read/Write/Edit/Bash

Blocks two classes of action:

1. **Reading credential files** (`.env`, `secrets/**`, `~/.secrets`, ssh keys, `.npmrc`), directly or
   through a shell. Once a key is read it is in the transcript, and a transcript travels further than
   the file did. This project reads secrets from `process.env` only.
2. **Unrecoverable commands** — `rm -rf` of root or home *itself*, force-push without
   `--force-with-lease`, history rewrites, hard reset onto a remote ref, writes to a device, fork bombs.

Scope is deliberately narrow. `rm -rf node_modules`, `rm -rf /tmp/x` and `git push --force-with-lease`
are ordinary work and stay allowed. A guardrail that blocks ordinary work gets disabled, and a
disabled guardrail protects nothing.

## `skill-write-gate.mjs` — PreToolUse on Write/Edit

Blocks edits to any `**/skills/**/SKILL.md` unless `.agents/skills/.validation-token.json` holds a
fresh token for that specific skill, minted by `skill-verify.mjs`.

The point is that a skill is *memory*. A wrong entry is retrieved on the next similar task and
followed, so it does not stay a single mistake. Requiring the pipeline to have run makes "verify
before you persist" a mechanism instead of an intention.

**What it guarantees:** the pipeline ran for this skill, within the token's 30-minute life.
**What it does not:** that the prose being written is true — nothing mechanical can check that. Hence
promote-or-discard: verify again after the write and revert if it goes red.

`--repair` mints a token when a skill is *already failing*, recording the known failures. Without it
the system deadlocks: a red skill needs an edit to go green, and the token to edit requires green.
The invariant is "you ran the pipeline and know the current state", not "the skill was perfect".

## `bootstrap-gate.mjs` — Stop hook, local only

Blocks turn termination while `.agents/skills/.bootstrap-state.json` still has open phases. Wired in
`settings.local.json`, which is gitignored, because a termination-blocker has no business running for
someone who clones this repository.

Every branch is fail-safe — unreadable input, missing state, or `stop_hook_active` all allow the stop
— and it self-releases after three blocks so a genuinely stuck gate surfaces to a human instead of
spinning.

## Disabling

Delete the relevant entry from `.claude/settings.json`. Nothing else depends on the hooks being
present; the scripts they call are runnable by hand.
