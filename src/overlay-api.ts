/**
 * The contract between the driver (Node) and the overlay (injected into the
 * page). Both sides import this file:
 *
 *  - `src/record.ts` types every `page.evaluate(() => window.__demovid!...)`.
 *  - `overlay/src/index.ts` declares `satisfies OverlayApi`, so removing or
 *    renaming a method breaks the build instead of failing at runtime inside a
 *    browser where the stack trace is useless.
 *
 * It lives under `src/` rather than `overlay/src/` for a reason that cost a
 * green typecheck and a red build: `tsconfig.json` includes both trees, but
 * `tsconfig.build.json` only includes `src`. A global declared in the overlay
 * tree is therefore invisible to the build, and the divergence only shows up in
 * `npm run build`, never in `npm run typecheck`.
 */

export interface Camera {
  tx: number;
  ty: number;
  k: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MountResult {
  stage: boolean;
  overlay: boolean;
  adopted: number;
  why?: string;
}

export interface ClipRef {
  src: string;
  durationMs: number;
  text: string;
}

export type ClipOutcome = "ended" | "timeout" | "error";

/** Physical constants of a spring, as `overlay/src/anim.ts` rebuilds it. */
export interface SpringConstants {
  stiffness: number;
  damping: number;
  mass: number;
}

export interface OverlayApi {
  mount(style?: unknown): MountResult;
  repromote(): void;
  fingerprint(): string;
  getCamera(): Camera;
  setCamera(c: Camera): void;
  /**
   * Animate the camera, resolving once it has settled. The driver must NOT
   * write `stage.style.transition` itself — that left a transition string
   * parked on the element forever and made the end of every take
   * non-deterministic.
   */
  cameraTo(c: Camera, spring: SpringConstants, hintMs?: number): Promise<void>;
  /** Live animations on the stage. Must be 0 once a move has settled. */
  stageAnimationCount(): number;
  assertUnscaled(): { ok: boolean; detail: string };
  cameraFor(selector: string, k: number): Camera | null;
  rectOf(selector: string): Box | null;

  spotlightOn(selector: string): boolean;
  spotlightOff(): void;

  say(text: string, selector?: string): void;
  hush(): void;

  showCursor(): void;
  hideCursor(): void;
  cursorTo(x: number, y: number, targetW?: number): Promise<void>;
  cursorPlace(x: number, y: number): void;
  cursorClick(): Promise<void>;
  cursorZoom(k: number): void;

  preloadClip(clip: ClipRef): Promise<void>;
  playClip(clip: ClipRef, index: number): Promise<ClipOutcome>;
  releaseClip(src: string): void;
  sequencerEvents(): readonly unknown[];

  readonly shadow: ShadowRoot | null;
}

declare global {
  interface Window {
    __demovid?: OverlayApi;
  }
}
