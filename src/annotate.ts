/**
 * Makes elements addressable that were not.
 *
 * Two paths, and the order matters:
 *
 * **Runtime (the one that actually runs).** `data-demovid-id` is written into
 * the live DOM through an init script, re-applied by a `MutationObserver` so it
 * survives a React or Vue re-render. Nothing on disk is touched, so it works in
 * a dirty working tree and cannot lose anyone's work.
 *
 * **Disk (built because it was asked for, expected never to fire).** Honest
 * assessment: `page.locator()` already accepts `text=`, `role=`, `xpath=`, and
 * `inventory.ts` only publishes selectors it has verified resolve to exactly one
 * element. What is left over is an element with no text, no role, no attribute
 * and no stable position — which a *viewer* could not identify either, so it is
 * a poor thing to point a demo at. There is also a lasting cost: a storyboard
 * that only works because demovid patched the source is not reproducible from a
 * clean clone.
 *
 * When it does run, the rules are absolute:
 *  - **Insert-only.** A whitespace-prefixed attribute goes into an opening tag.
 *    Never re-print an AST: that rewrites the whole file and makes the revert
 *    unverifiable.
 *  - **Write-ahead journal, fsynced before the edit.** A crash mid-run must be
 *    recoverable, so the record of what changed cannot be in memory.
 *  - **Revert only our own bytes.** Never `git checkout`, never `git stash`.
 *    The operator's unrelated uncommitted work is not ours to touch.
 */
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { BrowserContext } from "playwright-core";

export const ANNOTATION_ATTR = "data-demovid-id";

export interface AnnotationTarget {
  /** The id to write. */
  id: string;
  /** How to find the element: an xpath, or text content. */
  xpath?: string;
  text?: string;
}

/**
 * Install runtime annotation on the context.
 *
 * On the CONTEXT and not the page, for the same reason the overlay is: an init
 * script added to a page only applies to that page's later navigations.
 */
export async function installRuntimeAnnotation(
  ctx: BrowserContext,
  targets: AnnotationTarget[],
): Promise<void> {
  if (targets.length === 0) return;

  await ctx.addInitScript(
    ({ attr, list }: { attr: string; list: AnnotationTarget[] }) => {
      const apply = (): void => {
        for (const t of list) {
          try {
            let el: Element | null = null;
            if (t.xpath) {
              el = document.evaluate(t.xpath, document, null, 9, null)
                .singleNodeValue as Element | null;
            } else if (t.text) {
              el =
                Array.from(document.querySelectorAll("button, a, [role=button], label, h1, h2, h3"))
                  .find((n) => (n.textContent ?? "").trim() === t.text) ?? null;
            }
            if (el && el.getAttribute(attr) !== t.id) el.setAttribute(attr, t.id);
          } catch {
            /* seletor inválido — o passo seguinte reporta */
          }
        }
      };

      const start = (): void => {
        apply();
        let scheduled = false;
        let applying = false;
        const observer = new MutationObserver(() => {
          // Setting the attribute fires the observer that set it. Without this
          // flag the callback re-enters forever and pins a core at 100%.
          if (applying || scheduled) return;
          scheduled = true;
          requestAnimationFrame(() => {
            scheduled = false;
            applying = true;
            apply();
            applying = false;
          });
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      };

      // After load, never before: annotating during hydration makes React log
      // attribute mismatches and can make it discard the node.
      if (document.readyState === "complete") start();
      else window.addEventListener("load", start, { once: true });
    },
    { attr: ANNOTATION_ATTR, list: targets },
  );
}

// ── the disk path ──────────────────────────────────────────────────────────

export interface JournalEntry {
  file: string;
  /** Byte offset the text was inserted at. */
  offset: number;
  inserted: string;
  sha256Before: string;
  sha256After: string;
}

export interface Journal {
  version: 1;
  createdAt: string;
  entries: JournalEntry[];
}

export const journalPathFor = (projectDir: string): string =>
  join(projectDir, ".demovid", "edits.json");

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Write and fsync, so a crash cannot leave the journal behind the files. */
async function writeDurable(path: string, contents: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJournal(projectDir: string): Promise<Journal | null> {
  try {
    return JSON.parse(await readFile(journalPathFor(projectDir), "utf8")) as Journal;
  } catch {
    return null;
  }
}

/**
 * Insert ` data-demovid-id="<id>"` into an opening tag and journal it.
 *
 * The journal entry is durable BEFORE the file changes, so the failure mode is
 * a journal describing an edit that never happened — which the revert detects
 * and shrugs off — rather than an edit nobody recorded.
 */
export async function annotateOnDisk(
  projectDir: string,
  file: string,
  tagOffset: number,
  id: string,
): Promise<JournalEntry> {
  const original = await readFile(file, "utf8");
  const inserted = ` ${ANNOTATION_ATTR}="${id}"`;
  const patched = original.slice(0, tagOffset) + inserted + original.slice(tagOffset);

  const entry: JournalEntry = {
    file,
    offset: tagOffset,
    inserted,
    sha256Before: sha(original),
    sha256After: sha(patched),
  };

  const journal = (await readJournal(projectDir)) ?? {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    entries: [],
  };
  journal.entries.push(entry);

  const jpath = journalPathFor(projectDir);
  await writeFile(join(dirname(jpath), ".keep"), "", "utf8").catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(jpath), { recursive: true });
  });
  await writeDurable(jpath, JSON.stringify(journal, null, 2));
  await writeFile(file, patched, "utf8");

  return entry;
}

export interface RestoreResult {
  reverted: number;
  alreadyGone: number;
  conflicts: string[];
}

/**
 * Undo exactly demovid's own insertions, and nothing else.
 *
 * Reverted newest-first per file so earlier offsets stay valid. When the hash
 * does not match, the file changed underneath us — HMR rewrote it, or the
 * operator edited it — so the exact inserted substring is searched for instead:
 * one occurrence is removed, none means it is already gone, and more than one is
 * refused rather than guessed at.
 */
export async function restore(projectDir: string): Promise<RestoreResult> {
  const journal = await readJournal(projectDir);
  if (!journal) return { reverted: 0, alreadyGone: 0, conflicts: [] };

  const result: RestoreResult = { reverted: 0, alreadyGone: 0, conflicts: [] };
  const byFile = new Map<string, JournalEntry[]>();
  for (const e of journal.entries) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }

  for (const [file, entries] of byFile) {
    const original = await readFile(file, "utf8").catch(() => null);
    if (original === null) {
      result.alreadyGone += entries.length;
      continue;
    }
    let content: string = original;

    for (const entry of [...entries].sort((a, b) => b.offset - a.offset)) {
      const atOffset = content.slice(entry.offset, entry.offset + entry.inserted.length);
      if (sha(content) === entry.sha256After && atOffset === entry.inserted) {
        const undone =
          content.slice(0, entry.offset) + content.slice(entry.offset + entry.inserted.length);
        if (sha(undone) !== entry.sha256Before) {
          result.conflicts.push(`${file}: a reversão não reproduziu o conteúdo original`);
          continue;
        }
        content = undone;
        result.reverted++;
        continue;
      }

      const occurrences = content.split(entry.inserted).length - 1;
      if (occurrences === 0) {
        result.alreadyGone++;
      } else if (occurrences === 1) {
        content = content.replace(entry.inserted, "");
        result.reverted++;
      } else {
        result.conflicts.push(
          `${file}: ${occurrences} ocorrências de ${entry.inserted.trim()} — remova à mão`,
        );
      }
    }

    await writeFile(file, content, "utf8");
  }

  if (result.conflicts.length === 0) await rm(journalPathFor(projectDir), { force: true });
  return result;
}
