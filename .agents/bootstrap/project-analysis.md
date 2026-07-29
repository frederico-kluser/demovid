# Phase 1 — Project analysis

Baseline commit: `ed6ec7b`. Method: repository-doc discovery first, then three isolated-context
subagents mapping tooling, the overlay subsystem, and the audio/recording/storyboard subsystem.
Every claim below carries `path:line` provenance so it can be revalidated later.

## 1. Normative documents found

| Document | Lines | Status |
|---|---|---|
| `AGENTS.md` | 39 | **The normative source.** Already written as rule + why + scope. |
| `CLAUDE.md` | 7 | Imports `@AGENTS.md`; no duplicated content. |
| `README.md` | 145 | Outward-facing; states requirements and the measured findings. |
| `NOTICE` | 46 | Attribution for borrowed techniques/constants. |
| `.agents/skills/gravando-demos/SKILL.md` | 64 | The only existing skill. Portuguese body. |

**Not found** (declared explicitly rather than assumed): `docs/`, `doc/`, ADRs, `docs/decisions`,
RFCs, `CONTRIBUTING.md`, `ARCHITECTURE.md`, `.github/workflows`, any eslint/prettier/biome config,
`.editorconfig`. There is no CI and no linter in this repository.

Key normative excerpts, quoted verbatim:

> "Single source of truth for agents working in demovid. Kept short on purpose (long always-on files
> reduce adherence). Deep, on-demand knowledge lives in the skills" — `AGENTS.md:3-5`

> "lint/format: none configured. The quality gate is `npm run typecheck` + `npm test`." — `AGENTS.md:18`

> "Rules (only what differs from language defaults AND is not tooling-guaranteed)" — `AGENTS.md:20`

That last heading is the project's own statement of the principle this skills system is built on, so
the system inherits it rather than inventing a competing one.

## 2. What tooling already guarantees — do NOT write prose about these

`npm run typecheck` (`package.json:35`) is the enforcement layer. Each option below removes a class of
mistake from the space of things a skill needs to explain:

| Option | Where | Removes the need to say |
|---|---|---|
| `strict` | `tsconfig.json:12` | null/undefined deref, implicit `any` |
| `noUncheckedIndexedAccess` | `tsconfig.json:13` | "always guard index access" |
| `module`/`moduleResolution: NodeNext` | `tsconfig.json:5` | "use `.js` extensions in relative imports" |
| `verbatimModuleSyntax` | `tsconfig.json:16` | "use `import type` for type-only imports" |
| `noImplicitOverride` | `tsconfig.json:14` | "mark overrides" — currently dormant, no class overrides a method |
| `noFallthroughCasesInSwitch` | `tsconfig.json:15` | "don't fall through cases" |
| `forceConsistentCasingInFileNames` | `tsconfig.json:20` | "match path casing" |

**The one gap tooling does not close, and it has already caused an incident.** `tsconfig.json:23`
includes `["src","test","scripts","overlay/src"]` while `tsconfig.build.json:9` includes only
`["src"]`. Anything `src` depends on that physically lives outside `src` — above all a
`declare global` — is in the typecheck program and absent from the build program. Typecheck green,
build red. Recorded in-repo at `src/overlay-api.ts:10-14`. Consequence for the skills system: the
verification signal for anything touching the overlay contract must be `npm run build`, never
`npm run typecheck` alone.

Second asymmetry: `overlay/src` is bundled by esbuild (`scripts/build-overlay.ts:13`) and never seen
by `tsc -p tsconfig.build.json`, so overlay type errors surface only in `npm run typecheck`.

## 3. Conventions with no tooling behind them — these are the prose candidates

Observed consistently across `src/`, none machine-enforced:

1. **Module header comment states the WHY, often with a measured number.** Every module opens with
   one — `src/exec.ts:1-13`, `src/rec.ts:1-23`, `src/openai/tts.ts:1-23`.
2. **Bilingual by role**: module headers and API contracts in English; user-facing strings and step
   comments in Portuguese — `src/index.ts:15-30` vs `src/record.ts:22`.
3. **Error classes**: `export class XError extends Error`, `public readonly` context fields,
   `super(message)` then `this.name` — `src/exec.ts:42`, `src/rec.ts:59`, `src/openai/tts.ts:63`.
4. **`#private` ECMAScript fields, never the TS `private` modifier** — `src/rec.ts:99`,
   `overlay/src/cursor.ts:46`.
5. **Throw in libraries, exit codes at the boundary.** One `main().catch` narrows the four domain
   errors — `src/index.ts:186-200`.
6. **Diagnostics to stderr with a `[demovid]` prefix; `stdout` reserved for real output** —
   `src/index.ts:151` vs `:152`. This is what keeps `--out -` pipeable.
7. **`process.env` read by bracket with an explicit fallback, never a secrets file** —
   `src/doctor.ts:99`, `src/openai/tts.ts:186`.
8. **`as const` + `keyof typeof` for closed vocabularies with type-guard predicates** —
   `src/presets/index.ts:13-20`, `src/storyboard.ts:23`.

## 4. The no-shell rule — one deliberate, documented exception

`run()` in `src/exec.ts:68` is the sole `execFile` wrapper. Call sites: `src/doctor.ts:78,88,115,143`,
`src/browser.ts:47,53,84`, `src/openai/tts.ts:130,161,169,173,255`, `test/record.e2e.ts:57,143,160`.

The only bypass is `spawn("rec", …)` at `src/rec.ts:238`, because that child must be *signalled*
rather than awaited. No `execSync`, no `shell: true`, no `sh -c` anywhere; PATH lookup is done in
Node at `src/doctor.ts:35-47`, and the comment there records the second reason it must be:
`command` is a shell builtin and cannot be exec'd directly.

## 5. Subsystem map and knowledge density

| Area | Files | Why it needs a skill |
|---|---|---|
| **Camera / overlay** | `overlay/src/{stage,index,spotlight,cursor,balloon}.ts` | Densest measured knowledge. Every constraint is counter-intuitive and was paid for. |
| **Recording** | `src/rec.ts`, `src/browser.ts` | Process/signal semantics that Node's own API misreports. |
| **Narration** | `src/openai/tts.ts`, `scripts/bake-springs.ts` | Three measurements that contradict common advice. |
| **Storyboard / presets** | `src/storyboard.ts`, `src/presets/**` | Two-schema rationale and the orthogonal-axes design. |
| **Orchestration** | `src/record.ts` | Order of operations is load-bearing. |
| **Environment** | `src/doctor.ts` | The honest-signal design (`--deep`). |
| **Testing** | `test/**`, `package.json:41` | Two distinct harness styles; `npm run verify` is the only full chain. |

## 6. Test topology — this is what the gates will stand on

- `test/storyboard.test.ts` — real `node:test` + `node:assert/strict`, pure functions, Portuguese test
  names. Run by `npm test` (`package.json:36`), which globs `test/*.test.ts` and therefore excludes
  both e2e files by filename.
- `test/stage.e2e.mjs` and `test/record.e2e.ts` — hand-rolled `check()` harness, real Brave, one of
  them records ~8 s of real video. Run only via `npm run test:e2e` / `npm run test:record`.
- `npm run verify` (`package.json:41`) chains typecheck → bake:springs → build → test → test:e2e →
  test:record. It is the only chain that catches the §2 typecheck/build divergence.

## 7. Defects surfaced by this analysis

The point of an external reviewer is finding what the author cannot see in their own work. Two real
ones, both fixed in this phase's commit:

**(a) `AGENTS.md:27` was stale — a persisted rule that had become false.**
It said "Assert the overlay against `clientWidth`, not `innerWidth`", but `overlay/src/stage.ts:141-146`
explicitly rejects *both* and compares against a baseline captured at identity. The measured reason is
in that comment: `innerWidth` reads 1368 including the scrollbar gutter, and `clientWidth` also reads
1368 while a `width:100%` fixed child measures 1353.

This is the exact failure mode the skills system exists to prevent: a rule that is lean, well-scoped,
cited — and wrong. It would have been retrieved on the next overlay task and followed.

**(b) `test/record.e2e.ts:34` — the e2e harness dropped async assertions, and the consequence is
worse than it first appears.**
`check()` was typed `(name: string, fn: () => void)` but is passed an `async` callback at `:53`. A
rejected promise from that callback never reaches the try/catch. `tsc` cannot see it, because
`() => void` accepts a promise-returning function.

My first description of the consequence was **wrong**, and measuring corrected it. The failure is not
swallowed into a green report — since Node 15 an unhandled rejection raises an uncaught exception and
**terminates the process**. Measured, old harness versus new, same failing async assertion:

```
old  → exit 1, no output at all — the `finally` never ran
new  → exit 0, cleanup ran, failures counted = 1
```

So the real damage is that the process dies *before* its `finally`, leaving an orphaned browser and
potentially a `gpu-screen-recorder` still capturing the desktop — the exact orphan failure mode
`Recording.dispose()` (`src/rec.ts:201-226`) was written to prevent, reintroduced through a different
door.

Both e2e harnesses are fixed: `check` now accepts `() => void | Promise<void>`, awaits it, and every
call site awaits `check`. This matters beyond itself — `npm run test:record` is a declared
verification signal for this system, and a harness that dies instead of reporting makes every gate
built on it untrustworthy.

## 8. Dead configuration — candidates for consolidation, not for documentation

Declared and set but never read: `preset.camera.minHoldMs`, `preset.cursor.travelFactor`,
`preset.cursor.ring` (`src/presets/types.ts`). Declared but never produced: `CameraRung` `"R2"`
(`src/presets/types.ts:19` vs `src/record.ts:65`). Referenced in a comment but non-existent: presets
`launchpad`, `changelog`, `cinema` (`src/presets/types.ts:8` vs `src/presets/index.ts:13`).

These are **not** written into skills. Documenting an unused field teaches a future agent that it
works. They are recorded here for a human to either wire up or delete.

## 9. Candidate knowledge areas for Phase 2

Router; TypeScript/CLI conventions; architecture overview; camera+overlay; recording+process
ownership; narration+audio; storyboard+presets; testing; plus the two meta-skills. Granularity is
argued in `skill-map.md`.
