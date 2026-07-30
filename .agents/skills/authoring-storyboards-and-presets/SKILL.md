---
name: authoring-storyboards-and-presets
description: Explains why demovid ships a hand-written JSON Schema AND a zod schema when only zod still enforces anything, which JSON Schema keywords stay banned and why the ban outlived the API that punished it, and how the preset and locale layers compose. Use whenever you add or change a storyboard action, edit src/storyboard.ts or anything under src/presets/, add a preset or locale, tune pacing or dwell time, or debug a storyboard that came back the wrong shape. Also use before adding any field to a preset, because unread preset fields already exist in this repo and adding another teaches future readers that they work.
metadata:
  type: task
  verification_signal: npm test
---

# Storyboards and presets

## When to use

Any change to the storyboard schema, the action vocabulary, a preset, or a locale overlay.

## Injected knowledge

### Two schemas, and only one of them still validates anything

`src/storyboard.ts:1-15@a394a34` describes a split that the 2026-07-30 migration off OpenAI's
Responses API changed underneath. Read the split as it is **now**:

- **The JSON Schema is a PROMPT.** DeepSeek offers only `response_format: {type:"json_object"}`, so
  `callStructured` inlines the hand-written schema into the system prompt as instructions
  (`src/openai/responses.ts`). `json_object` guarantees the response parses as JSON. It guarantees
  nothing at all about the shape.
- **Zod guarantees everything else** — that a `click` has a selector, that a `wait` has something to
  wait for, that durations are sane, and now also that the object has the fields it claims to.

They are no longer complementary: `parseStoryboard` is the only gate. Deleting the zod pass because
"the schema already validates" does not degrade validation, it **removes** it. A malformed object is
no longer impossible, so the repair loop in `src/openai/script.ts` sees shape errors that used to be
unreachable — and it must, because nothing upstream will catch them.

### Ask for the maximum reasoning; let the API be the one to say no

The policy is "always the most DeepSeek will give us", and only the API knows what that is. So
`callStructured` walks two ladders for two different failures:

- **Effort**, highest first: `max` → `high` → no reasoning parameters at all. A value the API refuses
  comes back as a 400 naming `reasoning_effort` or `thinking`, which costs a rung and a line in the
  log, never the run.
- **Tokens**, smallest first, and only once an effort is settled: 32k → 64k on
  `finish_reason: "length"`. A reasoning model can spend the whole ceiling thinking and return a body
  that is JSON cut mid-string; before this it reached zod and was reported as "o modelo não produziu
  um roteiro válido", which blames the model for running out of room.

**None of this is verified against the live API.** The reference machine's `DEEPSEEK_API_KEY` answers
401 to `GET /v1/models`, so whether `max` exists — or whether `thinking: {type:"enabled"}` is a
DeepSeek parameter at all rather than one borrowed from another provider — is unknown. The ladder is
what makes the ignorance survivable, not a substitute for checking. With a working key, probe first
and prune the ladder to the rungs that are real.

One hard requirement that is easy to reword away: the system prompt must contain the literal word
**json**, because `response_format: {type:"json_object"}` rejects a request whose prompt never says
it. "Matching this schema" does not contain it. Pinned by a test in `test/scriptflow.test.ts`.

### The keyword blacklist is now vestigial — keep it anyway

Deliberately absent from the JSON Schema: `pattern`, `minLength`, `maxLength`, `minItems`,
`maxItems`. Under OpenAI `strict` these were a **hard 400 that killed the feature**
(`src/storyboard.ts:12-15@a394a34`). Under DeepSeek no server validates the schema at all, so nothing
400s and the ban costs nothing to violate.

Keep it regardless, for two reasons that outlive the provider: those constraints belong in the zod
pass where they are actually enforced, and the schema travels as prompt text now, so every keyword
that cannot be enforced is a rule the model is told to follow and then silently graded against
nothing. If the provider ever moves back to server-side `strict`, a schema that kept the ban still
works and one that did not is a hard 400 on the first call.

The `["string","null"]` unions standing in for optionals (`src/storyboard.ts:111-137@a394a34`) are
likewise no longer *forced* by `strict`, but `stripNulls` and the `.nullish()` zod fields are built
around them — see `authoring-commercial-edits`. Express a new optional field that way.

### `required` order is load-bearing

`action` and `target` come before `say` (`src/storyboard.ts:92-95@a394a34`) so the model must commit
to *what it is doing* before writing *what to say about it*. Reversed, it writes agreeable prose and
then invents a selector to match it. Keep new fields in that dependency order.

### What zod catches that the schema cannot

Cross-field conditionals (`src/storyboard.ts:48-66@a394a34`): `click`/`type`/`hover`/`focus` need
`target`; `goto` and `type` need `value`; `wait` needs `target` **or** `value` — a `wait` with
neither is how a storyboard hangs forever. Plus the numeric ranges the schema omits: `zoom` 1–4,
`holdMs` 0–30000, at least one step.

### The action vocabulary is small on purpose

`ACTIONS` (`src/storyboard.ts:23@a394a34`) stays small because every verb has to be three things at
once: **narratable**, **aimable** by the cursor, and **recoverable** when it fails. A verb that
cannot be all three does not belong, however convenient it looks in YAML.

Adding one means: extend the enum, add a `superRefine` rule for its required fields, add a case in
`runStep` (`src/record.ts:334@a394a34`), and add a test.

### Presets: two orthogonal axes

The **preset** is look and pace; the **camera rung** is safety (`src/presets/types.ts:1-13@a394a34`).
They are separate so a user who wants a more cautious camera is not forced into a different visual
style. Dim opacity, dwell time and cursor travel all move together along the one "how much help does
the viewer need" axis.

**Presets never carry `scenes`.** Only the user's storyboard does. Mixing content into a layered
config is the classic array-merge footgun — the layers cannot agree on whether to concatenate or
replace.

### Locale is a separate layer, not another preset

`applyLocale` is pure and non-mutating (`src/presets/index.ts:22-43@a394a34`). Five presets × N
locales would otherwise be 5N presets. The pt-BR overlay scales `cps` by 0.88 (Netflix's adult limit
is 17 CPS in pt-BR against 20 in English), dwell by 1.15 (Portuguese is more syllable-dense) and
balloon width by 1.1, then appends an accent instruction.

It also sets `requireHumanListen: true` (`src/presets/locale/pt-BR.ts:26@a394a34`) — pt-BR↔pt-PT
drift is reported and nothing measured proves `instructions` locks the accent. That flag is an honest
record of an unverified claim, not a formality.

### `dwellFor` has three inputs, and `cps` is the one people forget

`min(cap, max(audioMs, dwellMin + words·perWord, chars/cps·1000))`
(`src/presets/index.ts:45-63@a394a34`). Audio is the primary driver. The floors exist for narration
too short for the eye to track the change; the cap for a script that wrote a paragraph where a
sentence fit; and **`cps` is a second floor** because text the viewer must *read* has a budget
independent of how fast the voice says it.

### Before adding a preset field

`preset.camera.minHoldMs`, `preset.cursor.travelFactor` and `preset.cursor.ring` are declared and set
but never read (see `.agents/bootstrap/project-analysis.md` §8). Adding a fourth unread field makes
the type a worse description of behaviour than it already is. Either wire it into `src/record.ts` in
the same change, or do not add it.

## Procedure

1. Change the schema, an action, or a preset.
2. `npm test` — `test/storyboard.test.ts` covers the refinements, `applyLocale` immutability and
   `dwellFor`'s floors.
3. If you touched the JSON Schema, verify the enum lists match reality: only `boardroom` and
   `helpdesk` exist (`src/presets/index.ts:13@a394a34`).

## References

- `examples/demo.yaml` — the shape a user actually writes.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Gated by `npm test`; a schema
claim with no test is not persisted here.
