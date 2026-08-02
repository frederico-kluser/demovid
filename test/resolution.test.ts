/**
 * Unit tests for the capture planner and the X11 parsers.
 *
 * All pure, and worth pinning precisely because the arithmetic is invisible in
 * the product: a wrong fit calculation does not throw, it silently ships a
 * letterboxed or stretched video.
 *
 * The fixtures are verbatim output from the reference machine — three monitors,
 * a 32px top panel, a 37px title bar.
 *
 *   node --import tsx --test test/resolution.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitViewport } from "../src/record.js";
import {
  deviceToPreset,
  parseResolutionSpec,
  planCapture,
  RESOLUTIONS,
} from "../src/resolution.js";
import {
  clampIntoBox,
  fitIntoBox,
  intersect,
  parseFrameExtents,
  parseMonitors,
  parseWorkArea,
  usableContentBox,
  pickMonitor,
  type FrameExtents,
} from "../src/x11.js";

const XRANDR = `Monitors: 3
 0: +*eDP-1 2560/345x1600/215+1920+0  eDP-1
 1: +DP-1-0 1920/310x1200/174+0+400  DP-1-0
 2: +DP-1-2 1920/310x1200/174+4480+400  DP-1-2
`;

const WORKAREA = "_NET_WORKAREA(CARDINAL) = 0, 32, 6400, 1568, 0, 32, 6400, 1568";
const FRAME = "_NET_FRAME_EXTENTS(CARDINAL) = 0, 0, 37, 0";

const monitors = parseMonitors(XRANDR);
const area = parseWorkArea(WORKAREA);
const frame: FrameExtents = parseFrameExtents(FRAME) ?? { left: 0, right: 0, top: 0, bottom: 0 };

test("parseMonitors reads geometry and the primary marker", () => {
  assert.equal(monitors.length, 3);
  const primary = monitors.find((m) => m.primary);
  assert.equal(primary?.name, "eDP-1");
  assert.deepEqual(
    { w: primary?.w, h: primary?.h, x: primary?.x, y: primary?.y },
    { w: 2560, h: 1600, x: 1920, y: 0 },
  );
  // The `/345` and `/215` are physical millimetres and must not leak into the
  // pixel numbers — the obvious regex gets this wrong.
  assert.equal(monitors[1]?.w, 1920);
  assert.equal(monitors[1]?.y, 400);
});

test("parseWorkArea takes the first desktop's rect", () => {
  assert.deepEqual(area, { x: 0, y: 32, w: 6400, h: 1568 });
});

test("parseFrameExtents reads the decoration, title bar included", () => {
  assert.deepEqual(frame, { left: 0, right: 0, top: 37, bottom: 0 });
});

test("intersect returns an empty rect for disjoint boxes, not a negative one", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 500, y: 500, w: 100, h: 100 };
  assert.deepEqual(intersect(a, b), { x: 500, y: 500, w: 0, h: 0 });
});

test("usableContentBox subtracts the panel AND the title bar", () => {
  const primary = pickMonitor(monitors);
  assert.ok(primary);
  const box = usableContentBox(primary, area, frame);
  // 1600 tall monitor − 32px panel = 1568 work area − 37px title bar = 1531.
  assert.equal(box.h, 1531);
  assert.equal(box.w, 2560);
  assert.equal(box.x, 1920, "a janela vai na origem do monitor primário, não em 0");
  assert.equal(box.y, 32 + 37);
});

test("a landscape format that fits is captured natively, with no post-processing", () => {
  const plan = planCapture(RESOLUTIONS["1080p"]!, { monitors, area, frame });
  assert.equal(plan.scaleNeeded, false, "1920x1080 cabe — não pode haver passo de escala");
  assert.deepEqual({ w: plan.window.w, h: plan.window.h }, { w: 1920, h: 1080 });
  assert.equal(plan.deviceScaleFactor, 1);
  assert.equal(plan.mobile, false);
  assert.equal(plan.warnings.length, 0);
});

test("1440p still fits on this screen, so it also stays single-pass", () => {
  const plan = planCapture(RESOLUTIONS["1440p"]!, { monitors, area, frame });
  assert.equal(plan.scaleNeeded, false);
  assert.deepEqual({ w: plan.window.w, h: plan.window.h }, { w: 2560, h: 1440 });
});

test("a phone format opens a NORMAL window and emulates the viewport inside it", () => {
  // Measured, and counter-intuitive: Chromium refuses windows narrower than
  // roughly 500 logical px. A 390px-wide window silently becomes ~532px, so
  // the app is never phone-width and cropping the sides cuts content off. The
  // phone-ness has to come from CDP emulation, not from the window.
  const plan = planCapture(RESOLUTIONS["reels"]!, { monitors, area, frame });

  assert.equal(plan.mobile, true);
  assert.equal(plan.cssWidth, 390, "a largura CSS do celular tem que sobreviver ao plano");
  assert.equal(plan.scaleNeeded, true);
  assert.ok(plan.warnings.length > 0, "um recorte silencioso é exatamente o que não pode acontecer");

  // Measured: the emulated viewport's physical footprint is
  // `cssWidth * launch dsf`. The override's own deviceScaleFactor does NOT
  // raster it larger, so the density has to come from the launch flag — a
  // version that left this at 1 cropped half app, half empty grey.
  assert.ok(plan.deviceScaleFactor > 1.2, `dsf ${plan.deviceScaleFactor} deixaria o vídeo mole`);

  // And the whole phone, plus room for the browser's own UI, has to fit.
  const vpW = plan.cssWidth * plan.deviceScaleFactor;
  const vpH = vpW * (1920 / 1080);
  assert.ok(vpH < 1531, `o celular de ${Math.round(vpH)}px não cabe nos 1531px úteis`);
  assert.ok(plan.window.w >= vpW, "a janela tem que ser pelo menos tão larga quanto o viewport");
  assert.ok(plan.window.w <= 2560 && plan.window.h <= 1531, "a janela precisa caber na área útil");

  // The file still comes out at the requested size.
  assert.deepEqual(plan.target, { w: 1080, h: 1920 });
});

test("fitViewport carves the requested aspect out of the content area", () => {
  const target = { w: 1080, h: 1920 };

  // A wide content area: height is the limit, width follows.
  const wide = fitViewport(2560, 1356, target);
  assert.equal(wide.h, 1356);
  assert.ok(Math.abs(wide.w / wide.h - 1080 / 1920) < 0.01, `aspecto errado: ${wide.w}x${wide.h}`);
  assert.ok(wide.w <= 2560);

  // A narrow content area: width is the limit instead.
  const narrow = fitViewport(400, 2000, target);
  assert.equal(narrow.w, 400);
  assert.ok(Math.abs(narrow.w / narrow.h - 1080 / 1920) < 0.01);

  // Always even, or the encoder refuses the crop.
  for (const [w, h] of [[1001, 777], [333, 999], [2559, 1531]] as const) {
    const vp = fitViewport(w, h, target);
    assert.equal(vp.w % 2, 0, `largura ímpar para ${w}x${h}`);
    assert.equal(vp.h % 2, 0, `altura ímpar para ${w}x${h}`);
    assert.ok(vp.w <= w && vp.h <= h, `${vp.w}x${vp.h} não cabe em ${w}x${h}`);
  }
});

test("every planned window has even dimensions, because encoders reject odd", () => {
  // Measured: libx264 fails outright on an odd height and leaves no moov atom.
  for (const name of Object.keys(RESOLUTIONS)) {
    const plan = planCapture(RESOLUTIONS[name]!, { monitors, area, frame });
    assert.equal(plan.window.w % 2, 0, `${name}: largura ímpar ${plan.window.w}`);
    assert.equal(plan.window.h % 2, 0, `${name}: altura ímpar ${plan.window.h}`);
  }
});

test("a named monitor is honoured, and an unknown one degrades loudly", () => {
  const onSecondary = planCapture(RESOLUTIONS["720p"]!, {
    monitors,
    area,
    frame,
    monitorName: "DP-1-0",
  });
  assert.equal(onSecondary.monitor, "DP-1-0");
  assert.equal(onSecondary.window.x, 0);

  const unknown = planCapture(RESOLUTIONS["720p"]!, { monitors, area, frame, monitorName: "HDMI-9" });
  assert.equal(unknown.monitor, "(desconhecido)");
  assert.ok(unknown.warnings.length > 0);
});

test("parseResolutionSpec accepts presets, WxH, and Playwright devices", () => {
  assert.equal(parseResolutionSpec("1080p")?.w, 1920);
  assert.equal(parseResolutionSpec("1080P")?.w, 1920, "o nome do preset não é sensível a caixa");
  assert.deepEqual(
    { w: parseResolutionSpec("800x600")?.w, h: parseResolutionSpec("800x600")?.h },
    { w: 800, h: 600 },
  );

  const iphone = parseResolutionSpec("iPhone 15");
  assert.ok(iphone, "o nome de device do Playwright tem que resolver");
  assert.equal(iphone.mobile, true);
  // 393 CSS px at dsf 3 is the phone's real 1179px-wide screen.
  assert.equal(iphone.cssWidth, 393);
  assert.equal(iphone.w, 1179);

  assert.equal(parseResolutionSpec("gigante"), null);
  assert.equal(parseResolutionSpec("1920x"), null);
});

test("deviceToPreset multiplies the CSS viewport by the device's own density", () => {
  const pixel = deviceToPreset("Pixel 7");
  assert.ok(pixel);
  assert.equal(pixel.cssWidth, 412);
  assert.equal(pixel.w, Math.round(412 * 2.625));
  assert.equal(deviceToPreset("Nokia 3310"), null);
});

test("with no X11 information the request is honoured rather than invented", () => {
  const plan = planCapture(RESOLUTIONS["1080p"]!, { monitors: [], area: null, frame });
  assert.deepEqual({ w: plan.window.w, h: plan.window.h }, { w: 1920, h: 1080 });
  assert.equal(plan.scaleNeeded, false);
  assert.ok(plan.warnings.length > 0, "não verificar se cabe precisa ser dito");
});

// ── fitIntoBox ──────────────────────────────────────────────────────────────
//
// The half `clampIntoBox` cannot do. Sliding a window that is already the right
// size is one problem; deciding how big it may be at all is a different one, and
// every window demovid opens that is NOT the video used to skip it entirely.

test("fitIntoBox places a window that fits at the usable box's origin, unshrunk", () => {
  const box = usableContentBox(monitors[0]!, area, frame);
  assert.deepEqual(box, { x: 1920, y: 69, w: 2560, h: 1531 });

  // The crawl's window. Fits comfortably — the point is WHERE it lands: at the
  // usable origin (1920,69), not the monitor's raw origin (1920,0), which is
  // under the 32px panel and the 37px title bar.
  const win = fitIntoBox(1440, 900, box);
  assert.deepEqual(win, { x: 1920, y: 69, w: 1440, h: 900 });
});

test("fitIntoBox shrinks uniformly when the request is bigger than the screen", () => {
  // A 1366x768 laptop with the same panel and title bar. 1440x900 does not fit,
  // and nothing downstream was ever going to notice.
  const small = usableContentBox(
    { name: "eDP-1", primary: true, x: 0, y: 0, w: 1366, h: 768 },
    { x: 0, y: 32, w: 1366, h: 736 },
    frame,
  );
  assert.deepEqual(small, { x: 0, y: 69, w: 1366, h: 699 });

  const win = fitIntoBox(1440, 900, small);
  assert.ok(win.w <= small.w && win.h <= small.h, "tem que caber");
  // Uniform: the aspect ratio survives, so nothing recorded gets reshaped.
  assert.ok(Math.abs(win.w / win.h - 1440 / 900) < 0.01);
  assert.deepEqual({ x: win.x, y: win.y }, { x: 0, y: 69 });
});

test("fitIntoBox never returns a zero-sized window", () => {
  const win = fitIntoBox(1440, 900, { x: 0, y: 0, w: 0, h: 0 });
  assert.ok(win.w >= 2 && win.h >= 2);
});

test("clampIntoBox sacrifices the bottom-right, never the origin", () => {
  const box = usableContentBox(monitors[0]!, area, frame);
  // Grown past the bottom of the work area by the chrome-fitting loop.
  const grown = { x: 1920, y: 69, w: 2560, h: 1700 };
  const { x, y } = clampIntoBox(grown, box);
  assert.deepEqual({ x, y }, { x: 1920, y: 69 }, "o canto superior-esquerdo é o que se preserva");
});
