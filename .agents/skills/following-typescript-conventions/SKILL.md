---
name: following-typescript-conventions
description: Encodes the TypeScript, CLI and process-spawning conventions of demovid that no linter enforces, plus the one build trap that a green typecheck cannot catch. Use whenever you write or edit any .ts file, add an import, spawn an external binary, read process.env, print output, or define an error class — even for a one-line change, and even if the user does not mention conventions. There is no eslint or prettier in this repo, so these rules have no automated backstop except the ones noted as owned by the typechecker.
metadata:
  type: knowledge
  verification_signal: npm run build
---

# TypeScript conventions in demovid

## When to use

Any edit to a `.ts` file. Loads in parallel with a domain skill — they do not depend on each other.

## Injected knowledge

### What the typechecker already owns — do not think about these

`npm run typecheck` (`package.json:35@a394a34`) makes the following impossible, so they need no
attention and no review comment: null/undefined dereference and implicit `any` (`strict`), unguarded
index access (`noUncheckedIndexedAccess`), a missing `.js` extension on a relative import
(`NodeNext`), a missing `import type` (`verbatimModuleSyntax`), switch fallthrough, path-casing
mismatches (`tsconfig.json:5-20@a394a34`).

If you find yourself about to write a rule about any of those, run the typechecker instead.

### The trap the typechecker cannot see

`tsconfig.json:23@a394a34` includes `["src","test","scripts","overlay/src"]`.
`tsconfig.build.json:9@a394a34` includes only `["src"]`.

So anything `src` depends on that physically lives outside `src` — above all a `declare global` — is
in the typecheck program and absent from the build program. **Green typecheck, red build.** This has
already happened once; the fix is recorded at `src/overlay-api.ts:10-14@a394a34`.

Consequence: when a change touches the driver↔overlay contract, the signal is `npm run build`, never
`npm run typecheck` alone. Shared declarations go in `src/`, never in `overlay/src/`.

The asymmetry runs the other way too: `overlay/src` is bundled by esbuild and never seen by
`tsc -p tsconfig.build.json`, so overlay type errors surface *only* in `npm run typecheck`. Both
commands are needed; neither subsumes the other.

### No shell, ever — with one documented exception

Call external binaries through `run(bin, args[])` in `src/exec.ts:68@a394a34`. Array args, `execFile`,
no shell. The reason is that an untrusted path can never be interpreted as a shell metacharacter, and
the consequence is that pipes and redirects are unavailable — use tool flags instead (`ffmpeg -f null -`).

Two corollaries that have already come up:

- PATH lookup is done in Node by iterating `process.env.PATH` (`src/doctor.ts:35-47@a394a34`).
  `sh -c "command -v"` is wrong twice over: it is a shell, and `command` is a shell builtin that
  cannot be exec'd directly anyway.
- The single deliberate bypass is `spawn("rec", …)` at `src/rec.ts:238@a394a34`, because that child
  must be *signalled* rather than awaited. Any new long-lived, signalled child follows that pattern;
  everything else goes through `run()`.

### Output discipline

Diagnostics go to **stderr** with a `[demovid] ` prefix; `stdout` is reserved for real output
(`src/index.ts:151-152@a394a34`). This is what keeps `--out -` pipeable — a stray `console.log`
corrupts a caller's JSON. `doctor` follows the same rule and returns data rather than throwing
(`src/doctor.ts:19-26@a394a34`).

### Error style

`export class XError extends Error` with `public readonly` context fields, `super(humanMessage)`, then
`this.name = "XError"` (`src/exec.ts:42@a394a34`, `src/rec.ts:59@a394a34`,
`src/openai/tts.ts:63@a394a34`). Libraries throw; the boundary converts. There is exactly one
`main().catch` that narrows the domain errors and sets an exit code (`src/index.ts:186-200@a394a34`) —
do not add a second.

### Smaller conventions, stated once

- `#private` ECMAScript fields, never the TypeScript `private` modifier (`src/rec.ts:99@a394a34`).
- Every module opens with a block comment explaining **why**, usually carrying the measurement that
  forced the design (`src/openai/tts.ts:6-22@a394a34`). A comment restating what the code does is
  noise; a comment recording what was measured is the reason the code is not rewritten wrongly later.
- Bilingual by role: module headers and API contracts in English, user-facing strings in Portuguese
  (`src/index.ts:15@a394a34`). The user of this CLI reads Portuguese; its maintainers read code.
- Closed vocabularies as `as const` + `keyof typeof` with a type-guard predicate
  (`src/presets/index.ts:13-20@a394a34`).
- `process.env` read by bracket access with an explicit fallback, and **never** from a secrets file —
  the shell wrapper loads secrets (`src/doctor.ts:99@a394a34`).

### Build layout

Plain `tsc` for the CLI; esbuild only for the overlay bundle, because `addInitScript` needs a single
IIFE source string and `tsc` cannot produce one (`scripts/build-overlay.ts:5-12@a394a34`). Do not
reach for a bundler anywhere else — nothing else needs one.

## References

- `.agents/bootstrap/project-analysis.md` §2–§4 — the full tooling/prose split with every call site.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Update this file directly only
when a convention actually changed and `npm run build` is green — a style preference with no external
signal is exactly the kind of write this system exists to refuse.
