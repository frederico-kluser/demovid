---
name: working-with-the-camera-stage
description: Carries the measured constraints of demovid's in-page camera and overlay — why the transform goes on an injected fixed stage and never on document.body, why the overlay lives in the top layer AND a shadow root, and which CSS properties are banned outright. Use whenever you touch overlay/src/**, change zoom or panning, move or restyle the balloon, cursor or spotlight, debug blurry magnified text, a header that scrolls away, a balloon in the wrong place, or an overlay that scaled with the app. Every rule here was paid for by a measurement; assume none of it is intuitive.
metadata:
  type: task
  verification_signal: npm run test:e2e
---

# The camera stage and overlay

## When to use

Any edit under `overlay/src/**`, any camera or zoom behaviour, any visual-layer bug. These
constraints contradict what the surrounding open-source projects do, so intuition is an unreliable
guide here.

## Injected knowledge

### The stage is a `position:fixed` element, never `document.body`

Transforming `document.body` is what the OSS prior art does and it is broken. Under a transformed
`body`, `position:fixed` behaves like `absolute` — measured on a page with a 4000px `<main>`
(`overlay/src/stage.ts:7-13@a394a34`):

| Fixed pattern | Untransformed | With `scale(1)` on `body` |
|---|---|---|
| `top:0;left:0;right:0` header | y=0 | y=0 ✓ |
| `bottom:0` footer | y=669 | **y=4004** |
| `height:100%` sidebar | h=733 | **h=4068** |
| `top:50%` centred | y=319 | **y=1986** |

And scrolling 800px sends the header to **y=-800**. The cause: `body` is viewport-**width** but
content-**height**, so only half of "coincident with the viewport" holds.

### The mount order is load-bearing

Implemented at `overlay/src/stage.ts:78-113@a394a34`. Doing these in another order produces layout
shifts that get blamed on the target app:

1. `scrollbar-gutter: stable` **first**. Swapping the scroller off the document reclaims the
   scrollbar's 15px and shifts every rect; reserving it up front keeps the layout fingerprint stable.
2. `Element.moveBefore`, not `insertBefore`. It is atomic and preserves iframe loading state,
   animations, `:focus`, fullscreen and open dialog/popover state. Chrome 133+; falls back to
   `appendChild` rather than throwing.
3. `documentElement.overflow: hidden` **last** — only now is the stage the scroller.

### Two banned properties, each for a measured reason

**`will-change: transform` on the stage** pins the raster scale, so magnified text is blurry
*permanently*, not merely while moving (`overlay/src/stage.ts:87-88@a394a34`). The ban is stage-only:
the cursor uses it legitimately (`overlay/src/cursor.ts:62@a394a34`) because it never carries text.

**A visible scrollbar on the stage.** `scrollbar-width: none` is structural, not cosmetic
(`overlay/src/stage.ts:90-98@a394a34`). The moment *any* transform is set — even `scale(1)` — a
`position:fixed; left:0; right:0` header switches containing block from the viewport to the stage's
**padding box**, and a visible scrollbar makes that box 15px narrower: the header silently went
1353 → 1338px. With the scrollbar hidden, padding box = border box = viewport.

### `transform-origin` is `0 0` and never moves

Set once at `overlay/src/stage.ts:86@a394a34`. With a fixed origin every camera state is a pure
affine matrix, so any two states chain smoothly. Moving the origin per target is exactly why the OSS
prior art cannot chain a zoom from one element to another.

`camFor` (`overlay/src/stage.ts:41-53@a394a34`) centres a rect at zoom `k`; its clamp prevents the
camera ever revealing anything outside the stage. It needs an **un-transformed** rect, which is why
`localRect` inverts the current camera first.

### Two isolations, and neither substitutes for the other

- **Top layer** (`popover=manual`) isolates from the *stage's transform*. Guaranteed by CSS Position
  L4 §3, quoted at `overlay/src/index.ts:8-11@a394a34`. It does nothing about CSS inheritance.
- **Shadow root** isolates from the *app's CSS*, both directions. It does not escape a transformed
  ancestor.

Use `popover`, never `dialog.showModal()` — `showModal` makes the rest of the document inert and the
app becomes unclickable (`overlay/src/index.ts:14-15@a394a34`).

Top-layer order is by activation with no z-index control, so an app popover opened after ours lands
above it. `repromote()` (`overlay/src/index.ts:130-138@a394a34`) hides and re-shows on a capturing
`toggle` listener.

### Assert against a captured baseline, not a viewport metric

`assertOverlayUnscaled` (`overlay/src/stage.ts:135-175@a394a34`) compares a tuple captured at
identity. Neither `innerWidth` nor `clientWidth` works: both read 1368 while a `width:100%` fixed
child measures 1353, because the reserved gutter is not in either number. The requirement was never
"the overlay equals N pixels" — it is "the overlay did not change when the camera moved", so that is
what is measured.

### Spotlight and cursor specifics

- The spotlight is an SVG path with `fill-rule: evenodd` (`overlay/src/spotlight.ts:1-17@a394a34`).
  Not `box-shadow`, because that cuts only one rectangle and its `d` cannot be animated — the
  animatable `d` is what makes moving between targets a single transition instead of a blink.
  Chromium only interpolates when the command sequence matches, which `cutoutPath` guarantees.
- The pulse stops after N cycles (`overlay/src/spotlight.ts:125-139@a394a34`). WCAG 2.2.2 requires a
  control for motion past five seconds and a recorded video has none, so the motion must stop itself.
- The cursor counter-scales by `1/sqrt(k)`, not `1/k` (`overlay/src/cursor.ts:89-101@a394a34`): a
  cursor held at exactly constant size detaches visually from the content it points at. Balloons are
  pure chrome and stay at 1.0; the cursor is halfway between chrome and content.
- Visual and behavioural are separate concerns. Trusted events come from Playwright's `page.mouse`;
  this layer only draws where the real click is about to land (`overlay/src/cursor.ts:8-11@a394a34`).

### `mount()` must report what happened

It returns measured state, never a hardcoded `true` (`overlay/src/index.ts:151-157@a394a34`). An
earlier version returned `{stage:true, overlay:true}` unconditionally and a flaky run failed three
steps later with "cannot read scrollTo of null" — a mount that cannot fail visibly is one you debug
from the wrong end.

## Procedure

1. Change `overlay/src/**`.
2. `npm run build:overlay` — the injected bundle is generated; editing the source alone changes nothing.
3. `npm run test:e2e` — the layout assertions only exist in a real engine.
4. If the change touches the driver contract, also `npm run build` (see `following-typescript-conventions`).

## References

- `.agents/bootstrap/project-analysis.md` §5 — the subsystem map.
- `test/stage.e2e.mjs` — read it to see which behaviours are already pinned.

## <evolution>

On task completion, run the memory pipeline in `meta-skill-evolution`. This skill's claims are gated
by `npm run test:e2e`; a camera claim that no browser test can reach does not belong here.
