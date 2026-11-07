# Bricks

A brick-breaker, as one dashboard — a canvas-rendered paddle-and-ball game with hand-designed
levels, procedurally generated ones after that, multi-hit bricks, falling power-ups, lives, a
best score kept in localStorage, and frame-rate-independent physics with no tunnelling, even at
high ball speed.

This bundle carries one element:

| kind | name | what it is |
|---|---|---|
| dashboard | `game-bricks` | the game itself — frontend only, a one-route backend stub for the dashboard contract |

Install it:

```sh
adi-mono marketplace install <marketplace>/game-bricks
```

It arrives archived, same as every dashboard — start it from the Dashboards page, or:

```sh
adi-mono marketplace start <marketplace>/game-bricks/dashboards/game-bricks
```

Then open it by its hostname. No secret, no project, nothing else to configure.

## Why no backend logic

The whole rulebook — physics, collision, scoring, level progression — runs client-side; there is
nothing for a server to compute or to keep private. The backend half of this dashboard exists
only because the dashboard contract (`guides/dashboards.md`) needs one: it is the template's own
unmodified `backend/index.ts`, answering `/api/health` so the page's status dot has something to
poll, and nothing more. No route file was added.

## How it's built

`frontend/modules/.logic.ts` is the whole rulebook — pure functions over a plain coordinate
system (a fixed `WIDTH x HEIGHT` virtual board), no DOM, no canvas, no randomness that isn't
passed in as an argument. The dot in its name keeps it off the shell's auto-mounted panel list
(`guides/dashboards.md`'s module discovery lists every `modules/*.ts` that doesn't start with
`.`); `frontend/modules/game.ts` (the actual panel) reaches it at runtime as a same-origin
`./.logic.js` import, which the frontend server resolves straight back to this file.

The rules:

- **Paddle bounce angle depends on hit position.** Dead centre sends the ball straight up; the
  further toward an edge it lands, the more the ball is deflected toward that side, up to
  `MAX_BOUNCE_ANGLE` (62°) — speed is always preserved, so this redirects, never accelerates.
- **Collision is circle-vs-rectangle**, resolved by reflecting whichever axis (x or y) the ball
  penetrates *least* — the standard way to handle a corner hit without a special case for it.
- **No tunnelling, at any speed, on any frame.** Each ball's movement for a frame is split into
  enough substeps that no single substep can move it further than `MAX_SUBSTEP_DISTANCE` (90% of
  the smallest of the ball's radius, a brick's height, and the paddle's height) — so a ball fast
  enough to cross an entire brick in one naive frame-sized step is still caught mid-flight. This
  is frame-rate independent: a dropped frame (a big `dt`) just gets more substeps, not a skipped
  check.
- **Multi-hit bricks** take more than one hit to destroy, graded darker-to-brighter by remaining
  hit points so the damage is visible.
- **Levels**: the first three are hand-designed (`DESIGNED_LEVELS`); every level after that is
  procedurally generated, strictly harder as the level number grows — more rows (capped at 8),
  higher average hit points (capped at 4), and a higher fill density — via an injected `rng` so a
  given level is always reproducible in a test. A roll that would leave a layout entirely empty
  is forced to carry at least one brick, so every generated level is completable. Ball speed also
  increases per level (capped), the other half of the difficulty curve.
- **Power-ups** fall from a fraction of destroyed bricks (18%) and are caught by touching the
  paddle: **wide** (bigger paddle, 10s), **slow** (ball speed ×0.6, 8s), **multiball** (splits the
  current ball into extras, angled apart, capped at 6 balls total so it can't run away).
- **Lives**: starts at 3; losing every ball in play costs one and respawns a fresh ball, until
  lives reach 0 (game over). Clearing every brick on the board advances to the next level,
  carrying score and remaining lives forward.

`frontend/modules/game.ts` renders this onto a `<canvas>`, scaled to the panel's actual width
(the simulation itself always runs in the same fixed virtual board, so physics never depends on
how big the panel is drawn). Input: arrow keys / `a`/`d` to steer, mouse drag or touch to steer
directly to a position, `space` to pause. The animation loop uses real elapsed time each frame
(clamped against a multi-second gap, e.g. a backgrounded tab) and lets `stepGame`'s own
substepping absorb ordinary frame-rate variance — so play speed is the same at 30fps or 144fps.
Best score is `localStorage["adi.gamebricks.best"]`, scoped to the browser, not the backend —
there is nothing server-side to lose it with.

## Checking it works

```sh
bun test test/collision.test.ts test/levels.test.ts test/game-step.test.ts
```

37 checks with no DOM, no server: paddle bounce angle and speed conservation, wall/brick
reflection, the anti-tunnelling substep bound under a dropped-frame-sized `dt`, hand-designed
levels coming back brick-for-brick, procedural-level determinism and difficulty monotonicity, and
whole-frame scenarios through `stepGame` — brick destruction and scoring, multi-hit survival,
level-clear, lives lost and game over, and every power-up's effect.

A second, optional check covers what the logic tests structurally can't: whether the
paused/game-over overlay is actually invisible when it should be. `.gbricks__overlay` sets
`display: flex` (to centre its card), and an author stylesheet rule always outranks the UA's own
`[hidden] { display: none }` at equal specificity — so a missing `.gbricks__overlay[hidden]`
override renders the overlay (and its buttons) permanently, over the board, regardless of the
`hidden` attribute — this exact bug shipped in game-2048 v1.0.0. Neither `bun:test`'s DOM nor
happy-dom compute CSS cascade, so this needs a real browser:

```sh
bun add -d playwright && bunx playwright install chromium   # one-time, not needed to play the game
bun test test/overlay-visibility.test.ts
```

It skips (with a warning, not a failure) if Playwright isn't installed — the dashboard itself has
no dependency on it.

## Licence

MIT.
