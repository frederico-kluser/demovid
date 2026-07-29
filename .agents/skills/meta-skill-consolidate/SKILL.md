---
name: meta-skill-consolidate
description: Periodic garbage collection for the skill library — deduplicates overlapping passages, resolves contradictions, detects knowledge gone stale because the code it cites moved, enforces the token budget, and retires content that no longer earns its place. Use whenever a skill's claims fail verification, whenever two skills seem to say the same thing, whenever routing feels ambiguous or a must_trigger query ties, whenever the catalog has grown past roughly a dozen skills, and on a periodic schedule even with no visible symptom. Deletion here is irreversible in effect even when git can undo it, so every removal needs a second opinion and the user's confirmation.
metadata:
  type: meta
  verification_signal: node .agents/scripts/skill-verify.mjs --all
---

# Skill consolidation

## When to use

On a schedule, or when the library shows any of: duplicated passages, contradictions, failing claim
assertions, a skill over budget, or routing that has become ambiguous.

## Why this exists

A memory store that only grows gets worse. Selective addition combined with selective deletion
outperforms naive accumulation — which means removal is part of the mechanism, not an occasional
tidy-up. But removal is also where this system can do the most damage, so it is the one operation
that never runs unattended.

## Passes

### 1. Staleness by provenance

Every knowledge item cites `` `path/file:line@hash` ``. Run:

```bash
node .agents/scripts/skill-verify.mjs --all
```

The linter fails a citation whose file is gone or whose line is past the end of the file, and the
claim assertions fail when the cited behaviour has been refactored away.

A red claim does **not** mean "delete the passage". It means "revalidate": read the code as it is now,
then either re-cite it, rewrite the rule to match, or retire it. A rule can survive a refactor with
its provenance moved; a rule can also be silently obsolete while its file still exists.

### 2. Deduplication

Two passages teaching the same thing is not merely wasted context — it is a future contradiction,
because only one of them will get updated.

Prefer keeping the copy in the skill whose **verification signal can actually validate it**. A camera
claim living in the conventions skill is gated by `npm run build`, which cannot reach it; the same
claim in `working-with-the-camera-stage` is gated by `npm run test:e2e`, which can.

### 3. Conflict resolution

Where two skills disagree, one is stale. Resolve by reading the code, not by preferring the
better-written passage. Replace the loser; never leave both with a note about when each applies,
unless the scope condition is real and can be stated precisely.

### 4. Budget

`node .agents/scripts/skill-lint.mjs` reports lines and tokens per skill and the median. Over the cap,
move detail to `references/*.md` rather than compressing — dropping a rule's scope condition to fit a
budget converts a correct rule into a wrong one.

### 5. Routing health

`skill-verify.mjs` scores each skill's `must_trigger` / `must_not_trigger` queries and reports ties.
A tie is a real defect: two descriptions competing for the same query is how a catalog begins
misrouting, and it is invisible from the inside.

Fix by making descriptions carry the words a user actually types, and by narrowing whichever skill
was claiming territory that is not its subject.

### 6. Retirement

Content that no longer earns its place: a rule about code that no longer exists; a gotcha that a
tool now catches (move it to "the typechecker owns this" and delete the prose); a skill whose subject
has been absorbed.

## Deletion protocol — this is the dangerous part

Git makes a deletion technically reversible. It does not make it *noticed* — nobody diffs a skill
library looking for knowledge that quietly stopped being there. So:

1. **Second opinion.** Ask a fresh-context subagent to argue for keeping the passage, given only the
   passage and the code it cites. Reviewing your own removal is the same self-assessment problem the
   evolution pipeline exists to avoid.
2. **Confirm with the user** before removing a skill or a substantial passage. Deduplicating two
   sentences does not need a conversation; retiring a skill does.
3. **Separate commit**, with the reasoning in the message — the message is where a future reader
   learns why the knowledge is absent.
4. **Re-verify after.** `skill-verify.mjs --all` must be green; a removal that breaks another skill's
   claim means the two were coupled and the coupling was undocumented.

## Procedure

1. `node .agents/scripts/skill-verify.mjs --all` and `node .agents/scripts/skill-lint.mjs`.
2. Work the passes above in order; staleness first, because it changes what the other passes see.
3. Regenerate the catalog: `node .agents/scripts/build-catalog.mjs`.
4. Emit a diff for review. Nothing here auto-merges.
