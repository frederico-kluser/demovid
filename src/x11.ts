/**
 * What the X server will actually let us put on screen.
 *
 * This exists because the capture is of a real OS window, so the deliverable's
 * resolution is bounded by physical pixels — a fact that is invisible until you
 * ask for a 1080x1920 portrait video and discover no monitor is that tall.
 *
 * Two numbers matter and neither is the monitor size:
 *
 *  - `_NET_WORKAREA` subtracts panels and docks. Measured on the reference
 *    machine: monitors are 1600px tall but the work area is 1568, because of a
 *    32px top panel. A window placed at the monitor's origin would have its
 *    title bar under that panel.
 *  - `_NET_FRAME_EXTENTS` is the decoration the window manager adds around the
 *    content — 37px of title bar here. It is read from an existing window
 *    because it cannot be known for a window that has not been mapped yet.
 *
 * Everything is read through `run()`, never a shell.
 */
import { run } from "./exec.js";

export interface Monitor {
  name: string;
  primary: boolean;
  w: number;
  h: number;
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameExtents {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** `_NET_FRAME_EXTENTS` when nothing could be measured. */
export const NO_FRAME: FrameExtents = { left: 0, right: 0, top: 0, bottom: 0 };

/**
 * Parse `xrandr --listmonitors`:
 *
 *     Monitors: 3
 *      0: +*eDP-1 2560/345x1600/215+1920+0  eDP-1
 *
 * The `*` marks the primary output; the `/NNN` parts are physical millimetres
 * and are not useful here.
 */
export function parseMonitors(stdout: string): Monitor[] {
  const monitors: Monitor[] = [];
  const re = /^\s*\d+:\s+\+(\*)?(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/gm;
  for (const m of stdout.matchAll(re)) {
    const [, star, name, w, h, x, y] = m;
    if (!name || !w || !h || !x || !y) continue;
    monitors.push({
      name,
      primary: star === "*",
      w: Number(w),
      h: Number(h),
      x: Number(x),
      y: Number(y),
    });
  }
  return monitors;
}

export async function listMonitors(): Promise<Monitor[]> {
  const { stdout } = await run("xrandr", ["--listmonitors"]);
  return parseMonitors(stdout);
}

/**
 * Parse `xprop -root _NET_WORKAREA`, which lists one rect per virtual desktop:
 *
 *     _NET_WORKAREA(CARDINAL) = 0, 32, 6400, 1568, 0, 32, 6400, 1568
 *
 * Only the first is used — demovid records on the current desktop, and a
 * per-desktop strut difference would be a distinction without a consequence.
 */
export function parseWorkArea(stdout: string): Rect | null {
  const nums = stdout
    .slice(stdout.indexOf("=") + 1)
    .split(",")
    .map((s) => Number(s.trim()));
  const [x, y, w, h] = nums;
  if (x === undefined || y === undefined || !w || !h) return null;
  if ([x, y, w, h].some(Number.isNaN)) return null;
  return { x, y, w, h };
}

export async function workArea(): Promise<Rect | null> {
  try {
    const { stdout } = await run("xprop", ["-root", "_NET_WORKAREA"]);
    return parseWorkArea(stdout);
  } catch {
    return null;
  }
}

export function parseFrameExtents(stdout: string): FrameExtents | null {
  const nums = stdout
    .slice(stdout.indexOf("=") + 1)
    .split(",")
    .map((s) => Number(s.trim()));
  const [left, right, top, bottom] = nums;
  if ([left, right, top, bottom].some((n) => n === undefined || Number.isNaN(n))) return null;
  return { left: left!, right: right!, top: top!, bottom: bottom! };
}

/**
 * Decoration size, sampled from a window that already exists.
 *
 * A specific window id can be given once ours is mapped; without one, any
 * currently focused window is a good enough proxy, because the window manager
 * decorates them uniformly.
 */
export async function frameExtents(windowId?: string): Promise<FrameExtents> {
  try {
    const id = windowId ?? (await run("xdotool", ["getactivewindow"])).stdout.trim();
    if (!id) return NO_FRAME;
    const { stdout } = await run("xprop", ["-id", id, "_NET_FRAME_EXTENTS"]);
    return parseFrameExtents(stdout) ?? NO_FRAME;
  } catch {
    return NO_FRAME;
  }
}

/** Absolute geometry of a mapped window, as the compositor sees it. */
export async function windowGeometry(windowId: string): Promise<Rect | null> {
  try {
    const { stdout } = await run("xdotool", ["getwindowgeometry", "--shell", windowId]);
    const read = (key: string): number => {
      const m = new RegExp(`^${key}=(-?\\d+)$`, "m").exec(stdout);
      return m?.[1] === undefined ? NaN : Number(m[1]);
    };
    const w = read("WIDTH");
    const h = read("HEIGHT");
    const x = read("X");
    const y = read("Y");
    if ([w, h, x, y].some(Number.isNaN)) return null;
    return { x, y, w, h };
  } catch {
    return null;
  }
}

/** Intersection of two rects; zero-sized when they do not overlap. */
export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

/**
 * The box a window's *content* may occupy on a given monitor: the monitor,
 * clipped to the work area, minus the decoration the WM will add.
 */
export function usableContentBox(monitor: Monitor, area: Rect | null, frame: FrameExtents): Rect {
  const monRect: Rect = { x: monitor.x, y: monitor.y, w: monitor.w, h: monitor.h };
  const clipped = area ? intersect(monRect, area) : monRect;
  return {
    x: clipped.x + frame.left,
    y: clipped.y + frame.top,
    w: Math.max(0, clipped.w - frame.left - frame.right),
    h: Math.max(0, clipped.h - frame.top - frame.bottom),
  };
}

/**
 * Move a mapped window's top-left corner, in absolute desktop coordinates.
 *
 * Best-effort, like `parkPointer`: a machine without xdotool keeps whatever the
 * window manager decided, which is the situation demovid was already in.
 *
 * `--sync` matters. Without it xdotool returns as soon as the request is queued,
 * and the geometry read immediately afterwards is the OLD one — which reads as
 * "the move did not work" and invites a retry loop that fights the compositor.
 *
 * And `--sync` is exactly why the timeout is not optional: it blocks until the
 * window manager confirms the move, so a WM that simply declines it (a maximised
 * or tiled window) never returns. Three seconds, then the recording goes on with
 * whatever position it has — being slightly off-screen is a bad take, but hanging
 * before the recorder ever starts is no take at all.
 */
export async function moveWindow(windowId: string, x: number, y: number): Promise<void> {
  await run("xdotool", ["windowmove", "--sync", windowId, String(x), String(y)], {
    timeoutMs: 3_000,
  }).catch(() => {});
}

/**
 * Slide `win` until it sits inside `box`, without resizing it.
 *
 * Clamped low-edge-last on purpose: when the window is genuinely bigger than the
 * box there is no position that satisfies both edges, and the choice of which one
 * to sacrifice is not arbitrary. Keeping the top-left visible loses the bottom of
 * a window whose title bar and content start are still on screen; keeping the
 * bottom-right visible loses the part every UI puts its primary controls in. So
 * the origin wins, and the overflow goes off the bottom-right where the recorder
 * will crop it anyway.
 */
export function clampIntoBox(win: Rect, box: Rect): { x: number; y: number } {
  const x = Math.max(box.x, Math.min(win.x, box.x + box.w - win.w));
  const y = Math.max(box.y, Math.min(win.y, box.y + box.h - win.h));
  return { x, y };
}

/**
 * Move the real pointer out of the recorded window.
 *
 * Not cosmetic. Playwright's `page.mouse` dispatches CDP events and never moves
 * the X11 pointer, so the physical pointer stays wherever the operator left it
 * — and if that is over the browser's tab strip, Chromium renders a hover card
 * with the page title, the memory usage and a mute button, right in the middle
 * of the take. Hiding the cursor in the encoder does not stop the hover.
 *
 * Best-effort: a machine with no xdotool simply keeps its pointer.
 */
export async function parkPointer(win: Rect): Promise<void> {
  // Just past the window's bottom-right corner, clamped into the desktop.
  const x = Math.max(0, win.x + win.w + 40);
  const y = Math.max(0, win.y + win.h - 1);
  await run("xdotool", ["mousemove", String(x), String(y)]).catch(() => {});
}

/** The monitor a plan should target: the named one, else primary, else first. */
export function pickMonitor(monitors: Monitor[], name?: string): Monitor | null {
  if (monitors.length === 0) return null;
  if (name) return monitors.find((m) => m.name === name) ?? null;
  return monitors.find((m) => m.primary) ?? monitors[0] ?? null;
}

/**
 * Shrink `w x h` until it fits inside `box`, then place it at the box's origin.
 *
 * Not the same job as `clampIntoBox`, which slides a window that is already the
 * right size. This one answers the question that comes first: how big may the
 * window be at all. Measured on the reference machine — the primary monitor is
 * 2560x1600 but the usable content box is 2560x1531, because a 32px panel and a
 * 37px title bar come out of it — so a window asked for at the *monitor's*
 * origin opens with its title bar underneath the panel.
 *
 * Uniform, so a window that is asked for at an aspect ratio keeps it: shrinking
 * only the offending axis would silently change the shape of the thing being
 * recorded.
 *
 * Not forced to an even size. The recorder's own backends already reject odd
 * dimensions and crop for it (`src/recorder/backend-ffmpeg.ts`), and the callers
 * that need evenness are working from `planCapture`, not from here.
 */
export function fitIntoBox(w: number, h: number, box: Rect): Rect {
  const fit = Math.min(1, box.w / w, box.h / h);
  return {
    w: Math.max(2, Math.floor(w * fit)),
    h: Math.max(2, Math.floor(h * fit)),
    x: box.x,
    y: box.y,
  };
}

/**
 * Where to open a browser window that is NOT the video: the crawl's probe, and
 * `record()`'s fallback when no capture plan was built.
 *
 * `planCapture` does this properly for the take, against the resolution the
 * operator asked for. Everything else used to get the primary monitor's raw
 * origin and a hardcoded size, which is two separate ways to end up off-screen:
 * the origin ignores `_NET_WORKAREA` and `_NET_FRAME_EXTENTS`, and the size was
 * never compared to the monitor at all — 1440x900 does not fit a 1366x768 laptop
 * and nothing downstream was looking.
 *
 * Best-effort by construction. A machine with no X11 information keeps the
 * requested size at (0,0), which is the situation demovid was already in.
 */
/**
 * The usable content box, measured against a window that ALREADY EXISTS.
 *
 * `frameExtents()` with no argument samples whatever window happened to be
 * focused, because before launch there is nothing else to sample. Measured: that
 * answer is not stable — the same machine reported `0,0,37,0` with a terminal
 * focused and `0,0,0,0` moments later, which moves the box by the height of a
 * title bar and is exactly the size of error that leaves a window's top edge
 * off-screen.
 *
 * Once our window is mapped the guess is unnecessary: ask it. Same shape as
 * `chromeHeightPx` — a number that is only knowable after launch is measured
 * after launch, never reserved in advance from a constant.
 *
 * Returns null when X11 says nothing useful, so the caller keeps the planned box
 * rather than a box built from missing data.
 */
export async function usableBoxFor(windowId: string, monitorName?: string): Promise<Rect | null> {
  const monitors = await listMonitors().catch(() => []);
  const monitor = pickMonitor(monitors, monitorName) ?? pickMonitor(monitors);
  if (!monitor) return null;
  const [area, frame] = await Promise.all([workArea(), frameExtents(windowId)]);
  return usableContentBox(monitor, area, frame);
}

export async function fitWindowOnScreen(
  w: number,
  h: number,
  monitorName?: string,
): Promise<Rect & { usable: Rect }> {
  const monitors = await listMonitors().catch(() => []);
  const monitor = pickMonitor(monitors, monitorName) ?? pickMonitor(monitors);
  if (!monitor) {
    const usable = { x: 0, y: 0, w, h };
    return { x: 0, y: 0, w, h, usable };
  }
  const [area, frame] = await Promise.all([workArea(), frameExtents()]);
  const usable = usableContentBox(monitor, area, frame);
  return { ...fitIntoBox(w, h, usable), usable };
}
