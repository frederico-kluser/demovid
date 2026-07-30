/**
 * The `remotion` mode, end to end: edit script → EDL → project → Studio.
 *
 * A façade, like `src/rec.ts`. `record()` is the conductor and knows *when* this
 * happens (after the timeline exists, because the EDL is built from it); it should
 * not also know that the model is asked for transitions before phrases, or that
 * `npm install` runs before the port is probed.
 *
 * **Everything after the MP4 degrades instead of throwing.** By the time this runs
 * the take is finished and on disk: the recorder ran, the narration was paid for,
 * the timeline was written. Losing all of that because the edit-script call got a
 * 429, or because `npm` is not installed, would be the worst possible trade. So each
 * stage falls back — no model means hard cuts and no text, no `npm` means the
 * project is still generated and the two commands are printed — and the failure
 * becomes a warning on a report that still names a video.
 */
import { basename, dirname, extname, join } from "node:path";
import { writeCommercial, type Commercial } from "../openai/commercial.js";
import type { Clip } from "../openai/tts.js";
import type { Timeline } from "../timeline.js";
import { buildEdl, edlDurationInFrames, staticCameraSteps } from "./edl.js";
import { scaffoldRemotion } from "./scaffold.js";
import { installDeps, openStudio } from "./studio.js";

export * from "./edl.js";

/** `~/Videos/demo.mp4` → `~/Videos/demo.remotion`. */
export function projectDirFor(output: string): string {
  const base = basename(output, extname(output));
  return join(dirname(output), `${base}.remotion`);
}

/** A directory name is not necessarily a legal npm package name. */
function packageName(output: string): string {
  const base = basename(output, extname(output))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return base ? `${base}-comercial` : "demovid-comercial";
}

export interface BuildRemotionOptions {
  /** The finished video. Names the project directory and is copied into it. */
  output: string;
  timeline: Timeline;
  clips: Clip[];
  title: string;
  open: boolean;
  log: (line: string) => void;
  warn: (line: string) => void;
}

/** Ask the model for the edit. Returns `undefined` rather than failing the run. */
async function editScript(
  opts: BuildRemotionOptions,
): Promise<Commercial | undefined> {
  const tl = opts.timeline;
  const cameraStatic = staticCameraSteps(tl);
  const usable = tl.steps.filter((s) => s.ok);

  if (usable.length === 0) {
    opts.warn("nenhum passo utilizável — a montagem sai sem gancho e sem frases");
    return undefined;
  }

  try {
    return await writeCommercial({
      title: opts.title,
      scenes: usable.map((s) => ({
        index: s.index,
        action: s.action,
        target: s.target,
        durationMs: Math.max(0, s.endMs - s.startMs),
        narration: tl.narration
          .filter((n) => n.stepIndex === s.index)
          .sort((a, b) => a.sentenceIndex - b.sentenceIndex)
          .map((n) => n.text)
          .join(" "),
        cameraStatic: cameraStatic.has(s.index),
      })),
      log: opts.log,
    });
  } catch (err) {
    opts.warn(
      `não consegui escrever a montagem (${(err as Error).message}) — o projeto sai com ` +
        `cortes secos e sem texto, e você pode editar src/edl.json à mão`,
    );
    return undefined;
  }
}

export async function buildRemotionProject(
  opts: BuildRemotionOptions,
): Promise<{ dir: string; edl: string; url?: string }> {
  const commercial = await editScript(opts);

  const edl = buildEdl({
    timeline: opts.timeline,
    videoSrc: basename(opts.output),
    ...(commercial ? { commercial } : {}),
  });

  const dir = projectDirFor(opts.output);
  const scaffolded = await scaffoldRemotion({
    dir,
    edl,
    videoPath: opts.output,
    clips: opts.clips,
    name: packageName(opts.output),
    onLog: opts.log,
  });

  const secs = (edlDurationInFrames(edl) / edl.fps).toFixed(1);
  const cuts = edl.scenes.filter((s) => s.transitionIn).length;
  opts.log(
    `montagem: ${edl.scenes.length} cena(s), ${cuts} transição(ões), ` +
      `${edl.scenes.filter((s) => s.impact).length} frase(s) de impacto — ${secs}s`,
  );

  if (!opts.open) {
    opts.log(`para ver: cd ${dir} && npm install && npm run studio`);
    return { dir, edl: scaffolded.edlPath };
  }

  try {
    if (!scaffolded.installed) await installDeps(dir, opts.log);
    const studio = await openStudio({ dir, log: opts.log, open: true });
    return { dir, edl: scaffolded.edlPath, url: studio.url };
  } catch (err) {
    opts.warn(
      `o projeto está pronto em ${dir}, mas não consegui abrir o Studio ` +
        `(${(err as Error).message}). Rode: cd ${dir} && npm install && npm run studio`,
    );
    return { dir, edl: scaffolded.edlPath };
  }
}
