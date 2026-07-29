---
name: authoring-storyboards-and-presets
description: Explains why demovid validates a storyboard with a hand-written JSON Schema AND a zod schema, which JSON Schema keywords are forbidden under strict mode, and how the preset and locale layers compose. Use whenever you add or change a storyboard action, edit src/storyboard.ts or anything under src/presets/, add a preset or locale, tune pacing or dwell time, or debug a hard 400 from the OpenAI Structured Outputs API. Also use before adding any field to a preset, because unread preset fields already exist in this repo and adding another teaches future readers that they work.
metadata:
  type: task
  verification_signal: npm test
---

# Storyboards and presets

## When to use

Any change to the storyboard schema, the action vocabulary, a preset, or a locale overlay.

## Injected knowledge

### Two schemas, and they are not redundant

`src/storyboard.ts:1-15@a394a34` states the split:

- **JSON Schema with `strict: true` guarantees the SHAPE** coming out of the model. A malformed
  object is impossible.
- **Zod guarantees the MEANING after parsing** — that a `click` has a selector, that a `wait` has
  something to wait for, that durations are sane.

Neither replaces the other. Deleting the zod pass because "the schema already validates" removes
every cross-field rule; deleting the JSON Schema removes the guarantee that parsing succeeds at all.

### The keyword blacklist is a hard 400, not a warning

Deliberately absent from the JSON Schema: `pattern`, `minLength`, `maxLength`, `minItems`,
`maxItems`. OpenAI's supported-keyword list still excludes them under `strict`, and a rejected schema
is a **hard 400 that kills the feature** (`src/storyboard.ts:12-15@a394a34`). Those constraints live
in the zod pass instead.

`strict` also forces every property into `required`, with `["string","null"]` unions standing in for
optionals (`src/storyboard.ts:111-137@a394a34`). A new optional field is expressed that way, never by
omitting it from `required`.

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
