---
name: configuring-target-projects
description: Carries how demovid detects which frontend framework a target app was built with and how to boot its dev server — workspace-aware detection, the port ranking, the race between a guessed port and the URL a dev server announces, and the pi coding agent that discovers whatever the manifests leave unstated. Use whenever you touch scan.ts, devserver.ts, discover.ts or config.ts under src/project/, change framework or port detection, add a build tool, or debug a dev server demovid waits on forever, a port detected as free while the app is already serving, a workspaces monorepo whose framework came back desconhecido, an agent call that hangs after it already answered, or a .demovid.json that refuses to refresh. Every rule here replaced one that looked correct and shipped anyway.
metadata:
  type: task
  verification_signal: npm test
---

# Configuring someone else's project

## When to use

Anything under `src/project/`. Also any symptom that ends in "demovid could not start the app" — the
cause is almost never in the module that reports the timeout.

## Injected knowledge

### The root manifest is not the project

`scanProject` (`src/project/scan.ts:287@b2ac58e`) matches frameworks against the root `package.json`
**and** every workspace member, root first. Measured on GitCraque: the root depends only on `ws`
while React and Vite live in `web/package.json`, so root-only matching reported `desconhecido` and
defaulted the port to 3000 while Vite served on 5273. demovid started the operator's dev server,
waited 90 s on the wrong port, then killed it.

Root-first ordering is load-bearing in the other direction too: a monorepo whose app **is** the root
must not be reassigned to a member that merely also depends on `vite` — a component package,
typically.

Workspace globs come from `package.json` `workspaces` (both the array and the `{packages:[]}` shape)
or from `pnpm-workspace.yaml`, which keeps the list out of the manifest entirely. Only the last
segment globs, and `*` and `**` are treated alike (`src/project/scan.ts:159@b2ac58e`): every real
workspace list means "each child of this directory", and a glob engine here would be a dependency
bought for a case nobody writes.

### Three port sources, and only one of them is a guess

`script → config → default table`, recorded in `portSource` (`src/project/scan.ts:362@b2ac58e`). The
script wins because it is what actually runs; the build config wins next because the tool reads it;
the table is a guess, and `confident` exists to refuse to vouch for it.

`portFromConfigSource` (`src/project/scan.ts:215@b2ac58e`) scopes its match to the `server` /
`devServer` block. A bare `/\bport\s*:/`
also matches `preview: { port: 4173 }` and a proxy target, and picking one of those is **worse than
the default it replaces** — demovid would then wait on a port nothing ever listens on. Returning null
lets the default act, and the default can still be rescued by the announcement below. Regex rather
than parsing, because these files are TypeScript that imports plugins: reading the value honestly
would mean executing them.

### Probe both loopback families

`portInUse` connects to `127.0.0.1` **and** `::1`, in parallel, OR-ed
(`src/project/devserver.ts:43@b2ac58e`). Measured: Vite 7 bound `[::1]:5273` and nothing on IPv4, so
an IPv4-only probe reported the port free while the app answered 200 — and demovid started a second
dev server against a port already in use. Plenty of servers bind IPv4 only, so neither family can be
the one you ask.

The parallel `Promise.all` is not a micro-optimisation: sequential probes would turn the 400 ms
ceiling into 800 ms on every tick of a poll loop.

### The announcement races the guess — it is not a fallback

"Believe the URL the server prints" was a comment for a long time and not behaviour: the announced
URL was captured into a variable read only *after* `waitForPort(scan.port)` had already succeeded. In
the one case it was written for — a guessed port nobody listens on — the timeout expired first, so the
announcement was never consulted at all.

It also cannot simply win. A `dev` script that starts an API and a frontend announces whichever
printed first, and an **orphan from an earlier run** answers instantly on a port that is not the app.
Measured: an orphaned API held 5271, so the new API moved to 5272 and announced within 300 ms while
Vite, on the trusted 5273, was still booting — ranking the two only when both were up settled on the
API and would have recorded a 404 page.

So a guess from evidence gets `graceMs` alone before announcements count
(`src/project/devserver.ts:130@b2ac58e`), clamped to half the budget so a short timeout still looks
at one. That is what still rescues a Vite which moved to 5274 because 5273 was taken.

### Ctrl+C must not orphan the dev server

`finally` does not run on a signal. `scriptFlow` installs SIGINT/SIGTERM handlers for the lifetime of
a server it started and removes them in the `finally` (`src/scriptflow.ts:204@b2ac58e`). Without them
a killed run leaves `npm run dev` holding the port, and the next run adopts a server nobody owns —
which is how a stale build ends up in someone's video.

### The agent answers only what no file states

Deterministic first, `pi` second. `scan.ts` is free and instant; the agent (`deepseek-v4-pro`,
thinking `xhigh` — pi's ladder has no `max`) is asked only when `confident` is false or nothing is
cached, and it is authoritative **only** for what nothing measured: whether the app needs a login, and
what is worth demonstrating. When the scan was confident, its measured infrastructure overrides the
agent's reading of the same thing.

pi speaks NDJSON. The answer is the **last** `message_end` event's `content[]` entry of type `text`
(`src/project/discover.ts:154@b2ac58e`) — not the last line, which is `agent_end`; not the whole
stream parsed as one value; and not `content[0]`, which is the thinking block. A real tool-using run
emits six `message_end` events and only the last carries the answer.

`.demovid.json` is invalidated by **manifest content** (`src/project/config.ts:72@b2ac58e`), never by
a TTL: a TTL either expires a
still-correct answer or serves a stale one. Lockfiles are excluded on purpose — `npm install` rewrites
one on a version bump that changes nothing about how the app starts. The file is hand-editable by
design, so it is parsed as hostile input on every read, and a broken one degrades to a fresh discovery
rather than crashing a run the operator cannot otherwise start.

### `prepare` runs before the dev server, and that ordering is the whole feature

Some apps have nothing to show until something exists: a git browser needs a repository, a dashboard
needs rows, an editor needs files. `prepare.commands` in `.demovid.json` is the agent's answer to
that — `{bin, args, cwd}` triples it writes when it recognises the app displays data it must create.

The ordering is not a preference. The commands run **before `ensureDevServer`**, because the consumer
is `crawlApp`: run them after the crawl and the inventory is of the empty app, the storyboard is
written against elements that do not exist, and every step fails in rehearsal. Shipped the other way
round once and the feature was inert for the exact example that motivated it. `src/project/discover.ts`
promises the agent this ordering in the prompt, so moving the block breaks a contract the model was
told about.

Two properties that are easy to drop when editing this:

- **`cwd` is confined to the project.** It is agent-written, and `resolve(dir, "../..")` escapes to
  anywhere on disk. A command whose `cwd` resolves outside the project root is skipped and named,
  not run. `run()` already covers the argument side — array args, never a shell — but that says
  nothing about *where*.
- **A failure is a warning, not the end of the run.** The app may demo fine without the seed, and
  taking down a whole session over a preparation step is the worse trade. It is the same degrade-
  instead-of-throw posture the post-MP4 stages take.

`--no-prepare` skips the block entirely, for when the data is already there and the commands are not
as idempotent as the prompt asked them to be.

### The agent is spawned, and awaited on `exit`

The general rule lives in `following-typescript-conventions`. The short version: `execFile` resolves
when stdio **closes**, and pi's `bash` tool can leave a dev server running that inherits the stdout
pipe — so the call hangs after the answer is already in hand. `runAgent`
(`src/project/discover.ts:60@b2ac58e`) resolves on the `exit` event instead. Measured at 44 s versus a
blown 9-minute ceiling, same prompt.

pi runs with **write access** to a stranger's repository, which is the widest grant in this codebase.
It is not silent: the git working tree is diffed around the call and anything touched is named.
demovid cannot undo those edits — they are the agent's, not the journalled annotations `annotate.ts`
owns — so naming them is what lets the operator run `git diff` and decide.

## Procedure

1. Reproduce against a real project before changing detection. The fixtures in
   `test/project-config.test.ts` are shaped after GitCraque for exactly that reason.
2. Prefer making the deterministic layer smarter over widening the agent's remit. The agent costs
   money and a minute; reading a config file costs neither.
3. When adding a build tool, add it to `SIGNATURES` **and** `CONFIG_FILES`. A framework demovid can
   name but whose port it cannot find is still a project it cannot start.

## References

- `AGENTS.md` — the always-on statements of these rules.
- `understanding-demovid-architecture` — who owns what across `src/project/`.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. Gated by `npm test`. A claim
about detection must come from a project that actually failed, not from a framework's documentation.
