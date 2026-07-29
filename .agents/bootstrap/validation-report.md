# Phase 5 — Validation report

Reproduce with `node .agents/scripts/validate-system.mjs`. The suite is executable rather than prose
because a report asserting a system works, without running it, is exactly the artefact this system
exists to distrust. **22 checks, all green.** Every mutating test restores what it touched, and one
check verifies that it did.

## Results

| Group | Checks | What it demonstrates |
|---|---|---|
| A. Routing | 3 | 11 skills, 36 must-trigger and 22 must-not-trigger queries resolve correctly; catalog in sync |
| B. Write gate | 5 | no token blocks; wrong-skill token blocks; expired token blocks; correct fresh token allows; ordinary files unaffected |
| C. Rejecting a wrong learning | 2 | an over-generalised claim goes red; no token is minted for a red skill |
| D. Staleness | 2 | a simulated refactor turns its skill red; the mutation tests leave the tree identical |
| E. Router lifecycle | 4 | Portuguese questions present; `TASK_PLAN.md` gitignored, created and deleted without trace; bootstrap artifacts intact |
| F. Security guardrail | 3 | 5 unrecoverable commands blocked, 4 ordinary ones allowed, credential read blocked |
| G. Stop gate | 3 | honours `stop_hook_active`; fail-safe on corrupt state; blocks while a phase is open |

Project health unchanged: `npm run verify` green (typecheck, bake, build, 13 unit tests, both browser
e2e suites, a real 6.6 s recording with audio at −17 dB).

## The accept case — a learning that should be written

The `--repair` deadlock, discovered while building this. A red skill needs an edit to go green, but
the token required to edit it required green. That is important (non-obvious, changes how future
tasks work), externally verified (the deadlock was hit, not theorised), non-conflicting, and it
passed gating. It was written into `meta-skill-evolution` and `skill-verify.mjs` through the
pipeline.

## The reject case — a learning that must not be written

Deliberately constructed to *read* as correct: "the overlay never uses `will-change: transform`". The
stage genuinely bans it, so the generalisation sounds like the same rule. It is false —
`overlay/src/cursor.ts:62` uses it legitimately, because the cursor carries no text and so cannot go
blurry.

Encoded as a claim, verification goes red and no token is minted. This is the central demonstration:
the write was blocked by a **check**, not by taste, and the rule that would have been persisted was
lean, well-scoped and plausible.

## The regression case

`src/rec.ts` is mutated so `kill("SIGUSR2")` becomes `SIGTERM`. `recording-with-rec` goes red on the
claim about the pause signal, and the file is restored. A skill that keeps teaching a behaviour the
code no longer has is precisely what the staleness detector must catch.

## What using the system on itself found

Four defects, none of which would have surfaced from reading the design.

**1. `file-lacks` fails on its own documentation.** `file-lacks "child.killed"`, `"showModal"` and
`"minLength"` all failed because the token appears in the comment explaining *why not to use it*. A
negative assertion has to target the usage form, or prefer a positive assertion that says the same
thing.

**2. Two descriptions competing for one query.** "regenerate the baked spring easings" tied, because
the description said "spring baking" while a user types "spring easings" — no shared token. Fixed by
putting the words a user actually types into the description. Description collision is how a catalog
starts misrouting as it grows, and it is invisible from the inside.

**3. The gate deadlocked on repair.** Resolved with `--repair`, which mints a token only when
verification is currently *failing* and records the known failures in it. The invariant is "you ran
the pipeline and know the current state", not "the skill was already perfect".

**4. The staleness detector had a hole, and this is the serious one.** The first version of the
regression test **passed when it should have failed**. `file-contains "SIGUSR2"` stayed green through
the simulated refactor, because the token survived in the comment documenting the signal.

So a claim about *behaviour* was being satisfied by *prose about that behaviour*. A skill could keep
teaching something the code had stopped doing, with the gate green the whole time — the exact failure
the claim system exists to prevent, passing straight through it.

Closed by adding `code-contains` / `code-lacks`, which strip comments (a small state machine, because
a regex either misses nested block comments or eats the `//` in `https://`). 35 behaviour assertions
were migrated. Proven both ways: red with the code mutated, green with it restored.

## Known limits — stated because overclaiming a gate is worse than having none

**The routing scorer is not the model's selector.** It scores trigger-word overlap. It catches
description collisions, which is the real failure mode as a catalog grows; it does not catch a skill
that is semantically wrong for a query but shares no vocabulary with a competitor.

**The write gate proves the pipeline ran, not that the prose is true.** Nothing mechanical can check
prose. That is why the pipeline is promote-or-discard: verify again after the write and revert if it
goes red. `skill-verify.mjs` says this in its own header so the limit travels with the tool.

**`code-*` still matches inside string literals.** Deliberate — `kill("SIGUSR2")` must match. The
consequence is that a needle appearing in a documentation string would pass. In this codebase
documentation lives in comments, so the hole is narrow, but it is a hole.

**`--repair` is a necessary hole.** It permits writing to a red skill. Mitigated by recording the
known failures in the token and requiring green afterwards; a repair write that does not go green
must be reverted.

**The router's behaviour is not tested, only its content.** The suite checks that Portuguese
questions exist in the skill and that `TASK_PLAN.md` is gitignored, created and deleted. Whether the
model actually asks many questions before acting is behavioural and outside a deterministic check.

**Signal commands are not run by default.** `skill-verify --all` runs lint, claims and routing;
`--signal` additionally runs the declared command. That is opt-in because `npm run verify` takes
minutes and needs a display and a free capture slot. In CI, `--signal` should be on.

## Gaps and proposed fixes

| Gap | Proposal |
|---|---|
| No CI runs any of this | A workflow running `skill-verify --all` + `validate-system` on PRs touching `.agents/**` would catch drift a human will not notice |
| Dead preset fields still undocumented-and-unwired | `.agents/bootstrap/project-analysis.md` §8 lists them; either wire or delete — a type that lies about behaviour is worse than a missing one |
| Skill count will grow | `meta-skill-consolidate` exists but has never run. The first real consolidation pass is the honest test of it |
| `test:record` needs a display | On a headless machine the recording skill has no reachable signal. It should say so rather than fall back to a weaker one |
