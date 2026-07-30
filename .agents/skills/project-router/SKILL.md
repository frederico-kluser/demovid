---
name: project-router
description: Routes every implementation task in this repository to the right skills before any work begins, after interrogating the request until it is unambiguous. Use whenever the user asks for any change, fix, feature, refactor, investigation or recording in demovid — even a one-line change, and even when they do not mention skills. This is the only entry point; nothing else dispatches. Skipping it means working without the project knowledge that has already been paid for.
metadata:
  type: router
---

# Project router

**All questions to the user are asked in Brazilian Portuguese.** The person operating this repository
speaks Portuguese; the code and these skills are in English. That split is deliberate — do not
"translate" the questions to match the file.

## Protocol — run before any work

### 1. Ask a lot, in Portuguese

Before anything else, interrogate the request. Most tasks arrive underspecified, and the cost of
guessing is a correct implementation of the wrong thing. Keep asking until ambiguity is gone; do not
proceed on a plausible interpretation.

Cover at least: exact scope, expected input and output, constraints, edge cases, acceptance criteria,
and **what explicitly must not change**.

Ready-to-use openers:

- *"Qual é exatamente o escopo? O que está DENTRO e o que está FORA desta tarefa?"*
- *"Como eu sei que terminei? Qual é o critério de aceite observável?"*
- *"O que NÃO pode mudar? Tem alguma parte que é intocável?"*
- *"Isso deve valer para todos os casos ou só para uma situação específica?"*
- *"Prefere a correção mínima ou a solução estrutural, mesmo que demore mais?"*
- *"Já existe algum caso real onde isso quebrou? Consegue me dar entrada e saída esperada?"*

Use the `AskUserQuestion` tool when the answer is a choice between concrete options — it is faster for
the user than free text, and it forces the alternatives to be stated honestly.

### 2. Write `TASK_PLAN.md`, in Portuguese

A disposable file at the repository root with the agreed plan: objective, steps, acceptance criteria,
and what is out of scope. It is written in Portuguese because it is a contract with the user, not a
note to yourself.

It is **disposable and gitignored**. It exists so the plan is inspectable mid-task, not so it becomes
another document to maintain.

### 3. Classify

Which domains does the task touch, what type is it (bug / feature / refactor / investigation /
recording), and how complex is it.

### 4. Select skills from `catalog.md`

Read `.agents/skills/catalog.md`. On ambiguity prefer the most domain-specific skill. If the task is
about **operating** demovid rather than changing it, that is `running-demo-recordings` and usually
nothing else.

### 5. Assemble the chain

Ordering rules, from `.agents/bootstrap/skill-map.md`:

- `understanding-demovid-architecture` **first** on anything touching more than one module.
- `following-typescript-conventions` on any `.ts` edit, in parallel with the domain skill.
- The domain skills are independent and may load in parallel.
- `testing-demovid` **after** the domain skill, when the change needs a test.
- `meta-skill-evolution` **last, always**.

Two pairs are easy to route to the wrong half, because in each case one skill decides
something and the other consumes it:

- **The edit vs. the renderer.** `authoring-commercial-edits` owns *what* the cut is —
  where a boundary may be trimmed, how long a transition may be, which scene gets a
  phrase. `composing-remotion-videos` owns *what the generated project does with it*.
  A change that crosses the seam loads the deciding skill first, because the renderer's
  constraints are what the decision has to satisfy. A symptom in the Studio that does
  not appear in the rendered MP4 is always the second one.
- **The words vs. the schema.** `scripting-product-demos` owns the prose the model is
  asked to write — narration, captions, the hook, step count, pacing.
  `authoring-storyboards-and-presets` owns the shape it must come back in. They load in
  parallel on a prompt change, because the `required` order in the schema is itself a
  prose-quality mechanism, and editing either alone is how the two drift.

Use isolated-context subagents for genuinely separable, context-heavy investigation, and have them
return short summaries rather than file contents.

### 6. Load the knowledge, then implement

Read the selected skills before writing code, not while debugging. The point of the library is that
the constraints are known in advance; consulting it after a failure is just an expensive way to
rediscover them.

### 7. On completion

1. Run each involved task skill's `<evolution>` step — the pipeline in `meta-skill-evolution`.
2. **Delete `TASK_PLAN.md`.** It is disposable and must not survive the task.

## Rules

- If no skill covers the task, invoke `meta-skill-evolution` to **propose** a new one as a draft for
  human review. Never publish a skill directly.
- Skills with broad side effects — a recording that takes over the screen, a structural change, a
  deploy — are not auto-invoked without confirming with the user first.
- Never skip the evolution step. Never leave `TASK_PLAN.md` behind.
- `TASK_PLAN.md` is the **only** file this protocol deletes. The bootstrap artifacts
  (`.agents/bootstrap/**`, `.agents/skills/catalog.md`, `.agents/skills/.bootstrap-state.json`) are
  permanent — deleting them would discard the analysis the whole library rests on.

## When the protocol is overhead

A one-word typo fix in a comment does not need six questions and a plan file. Ask one question
("*É só isso mesmo, ou tem mais alguma coisa junto?*"), skip the plan, still run the evolution step —
which will correctly decide there is nothing important to persist. Ceremony that adds no signal
trains the user to route around the router.
