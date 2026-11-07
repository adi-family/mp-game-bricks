// Pure brick-breaker rules — no DOM, no canvas, no randomness baked in (every random choice
// takes an injectable `rng`), so this file is exactly what `test/*.test.ts` exercises and exactly
// what `game.ts` renders: one rulebook, not two copies of it that could drift apart.
//
// A dot-prefixed module name is deliberate: `frontend/index.ts`'s own `moduleIds()` lists every
// `modules/*.ts` that does NOT start with `.` and auto-mounts each one as a panel — this file has
// no `default` export shaped like a panel, so it must stay off that list. `game.ts` reaches it at
// runtime as a same-origin relative import, `./.logic.js`, which the frontend server resolves
// back to this file; nothing here is special-cased, the leading dot is the whole mechanism.
//
// Units are abstract board pixels on a fixed-size virtual board (WIDTH x HEIGHT); the renderer
// scales that board onto whatever canvas size the panel actually has.

export const WIDTH = 320;
export const HEIGHT = 480;

export const BALL_RADIUS = 5;
export const BASE_BALL_SPEED = 220; // board units / second
export const MAX_BALL_SPEED = 420;
export const MAX_BOUNCE_ANGLE = (62 * Math.PI) / 180;

export const PADDLE_HEIGHT = 10;
export const PADDLE_Y = HEIGHT - 28; // top edge of the paddle
export const BASE_PADDLE_WIDTH = 56;
export const WIDE_PADDLE_WIDTH = 86;

export const BRICK_COLS = 9;
export const BRICK_GAP = 4;
export const BRICK_TOP = 40;
export const BRICK_HEIGHT = 16;
export const BRICK_WIDTH = (WIDTH - BRICK_GAP * (BRICK_COLS + 1)) / BRICK_COLS;

export const LIVES_START = 3;
export const MAX_BALLS = 6;

export const POWERUP_DROP_CHANCE = 0.18;
export const POWERUP_SIZE = 14;
export const POWERUP_FALL_SPEED = 90;
export const POWERUP_WIDE_SECONDS = 10;
export const POWERUP_SLOW_SECONDS = 8;
export const SLOW_FACTOR = 0.6;

// The largest distance a ball may travel in one physics substep, so a fast ball can never cross
// an entire brick (or the paddle) between checks and tunnel through it unseen.
export const MAX_SUBSTEP_DISTANCE = Math.min(BALL_RADIUS, BRICK_HEIGHT, PADDLE_HEIGHT) * 0.9;

export type PowerUpType = "wide" | "multiball" | "slow";
export const POWERUP_TYPES: PowerUpType[] = ["wide", "multiball", "slow"];

export interface Vec2 {
  x: number;
  y: number;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Paddle {
  x: number; // centre
  width: number;
}

export interface Brick {
  col: number;
  row: number;
  x: number; // top-left
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
}

export interface PowerUp {
  x: number;
  y: number;
  type: PowerUpType;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GameState {
  balls: Ball[];
  paddle: Paddle;
  bricks: Brick[];
  powerUps: PowerUp[];
  score: number;
  lives: number;
  level: number; // 0-based
  wideTimer: number; // seconds remaining, 0 = inactive
  slowTimer: number; // seconds remaining, 0 = inactive
}

export type GameEvent =
  | { type: "brickHit"; brick: Brick; destroyed: boolean }
  | { type: "powerUpSpawned"; powerUp: PowerUp }
  | { type: "powerUpCollected"; powerUpType: PowerUpType }
  | { type: "ballLost" }
  | { type: "lifeLost" }
  | { type: "levelCleared" }
  | { type: "gameOver" };

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// Levels — a handful of hand-designed boards, then procedural ones forever.
// ---------------------------------------------------------------------------

/** One entry per brick, 0 = no brick, N = that brick's hit points. Rows top to bottom. */
type Layout = number[][];

const LEVEL_1: Layout = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 1, 1, 1, 1, 1, 0, 0],
];

const LEVEL_2: Layout = [
  [2, 2, 2, 2, 2, 2, 2, 2, 2],
  [0, 1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 1, 0, 0, 0, 1, 0, 0],
];

const LEVEL_3: Layout = [
  [3, 0, 3, 0, 3, 0, 3, 0, 3],
  [2, 2, 2, 2, 2, 2, 2, 2, 2],
  [1, 1, 0, 1, 1, 1, 0, 1, 1],
  [2, 2, 2, 2, 2, 2, 2, 2, 2],
  [0, 1, 0, 0, 1, 0, 0, 1, 0],
];

export const DESIGNED_LEVELS: Layout[] = [LEVEL_1, LEVEL_2, LEVEL_3];

function layoutToBricks(layout: Layout): Brick[] {
  const bricks: Brick[] = [];
  for (let row = 0; row < layout.length; row++) {
    const cols = layout[row];
    for (let col = 0; col < cols.length; col++) {
      const hp = cols[col];
      if (hp <= 0) continue;
      bricks.push({
        col,
        row,
        hp,
        maxHp: hp,
        x: BRICK_GAP + col * (BRICK_WIDTH + BRICK_GAP),
        y: BRICK_TOP + row * (BRICK_HEIGHT + BRICK_GAP),
        w: BRICK_WIDTH,
        h: BRICK_HEIGHT,
      });
    }
  }
  return bricks;
}

/**
 * The bricks for level `levelIndex` (0-based, overall — not just among procedural ones). The
 * first `DESIGNED_LEVELS.length` levels are the hand-designed boards above, in order; every level
 * after that is generated, strictly harder as `levelIndex` grows: more rows (capped) and higher
 * average hit points (capped), via an injected `rng` so the whole thing is reproducible in a test.
 */
export function generateLevel(levelIndex: number, rng: () => number = Math.random): Brick[] {
  if (levelIndex < DESIGNED_LEVELS.length) return layoutToBricks(DESIGNED_LEVELS[levelIndex]);

  const proceduralIndex = levelIndex - DESIGNED_LEVELS.length;
  const rows = Math.min(8, 4 + Math.floor(proceduralIndex / 2));
  const maxHp = Math.min(4, 1 + Math.floor(proceduralIndex / 3));
  const density = Math.min(0.9, 0.6 + proceduralIndex * 0.03);

  const layout: Layout = [];
  for (let row = 0; row < rows; row++) {
    const line: number[] = [];
    for (let col = 0; col < BRICK_COLS; col++) {
      line.push(rng() < density ? 1 + Math.floor(rng() * maxHp) : 0);
    }
    layout.push(line);
  }

  // A layout that rolled entirely empty would leave nothing to clear — force one brick so every
  // generated level is always, in fact, completable.
  if (layout.every((line) => line.every((v) => v === 0))) {
    layout[0][Math.floor(BRICK_COLS / 2)] = 1;
  }

  return layoutToBricks(layout);
}

/** Nominal ball speed for a level: faster each level, capped so it never becomes unreactable. */
export function ballSpeedForLevel(level: number): number {
  return Math.min(MAX_BALL_SPEED, BASE_BALL_SPEED * (1 + level * 0.06));
}

// ---------------------------------------------------------------------------
// Ball spawn and paddle bounce
// ---------------------------------------------------------------------------

/** A ball launched from the paddle's current position, mostly upward with a slight random tilt. */
export function spawnBall(
  paddle: Paddle,
  speed: number = BASE_BALL_SPEED,
  rng: () => number = Math.random,
): Ball {
  const theta = (rng() * 2 - 1) * 0.25; // small tilt either side of straight up
  return {
    x: paddle.x,
    y: PADDLE_Y - BALL_RADIUS - 1,
    vx: speed * Math.sin(theta),
    vy: -Math.abs(speed * Math.cos(theta)),
  };
}

/**
 * The new velocity after bouncing off the paddle: direction depends on *where* the ball hit it
 * (dead centre bounces straight up, the edges bounce out at up to `MAX_BOUNCE_ANGLE`), speed is
 * always preserved — this is an elastic bounce, not an energy source or sink.
 */
export function paddleBounceVelocity(
  ball: Ball,
  paddle: Paddle,
  speed: number,
): { vx: number; vy: number } {
  const half = paddle.width / 2;
  const offset = clamp((ball.x - paddle.x) / half, -1, 1);
  const theta = offset * MAX_BOUNCE_ANGLE;
  return { vx: speed * Math.sin(theta), vy: -Math.abs(speed * Math.cos(theta)) };
}

export function speedOf(ball: Ball): number {
  return Math.hypot(ball.vx, ball.vy);
}

export function paddleRect(paddle: Paddle): Rect {
  return { x: paddle.x - paddle.width / 2, y: PADDLE_Y, w: paddle.width, h: PADDLE_HEIGHT };
}

// ---------------------------------------------------------------------------
// Collision primitives
// ---------------------------------------------------------------------------

/** Circle (the ball) vs. axis-aligned rect, both given in the same board coordinates. */
export function circleRectOverlap(ball: Ball, rect: Rect): boolean {
  const closestX = clamp(ball.x, rect.x, rect.x + rect.w);
  const closestY = clamp(ball.y, rect.y, rect.y + rect.h);
  const dx = ball.x - closestX;
  const dy = ball.y - closestY;
  return dx * dx + dy * dy <= BALL_RADIUS * BALL_RADIUS;
}

/**
 * Reflect the ball off whichever side of `rect` it is penetrating least — the standard way to
 * resolve a circle/AABB collision without a special case for corners — and push it back outside
 * that side so the very next check doesn't see the same overlap again.
 */
export function reflectOffRect(ball: Ball, rect: Rect): Ball {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = ball.x - cx;
  const dy = ball.y - cy;
  const overlapX = rect.w / 2 + BALL_RADIUS - Math.abs(dx);
  const overlapY = rect.h / 2 + BALL_RADIUS - Math.abs(dy);

  let { x, y, vx, vy } = ball;
  if (overlapX < overlapY) {
    vx = dx < 0 ? -Math.abs(vx) : Math.abs(vx);
    x = dx < 0 ? rect.x - BALL_RADIUS : rect.x + rect.w + BALL_RADIUS;
  } else {
    vy = dy < 0 ? -Math.abs(vy) : Math.abs(vy);
    y = dy < 0 ? rect.y - BALL_RADIUS : rect.y + rect.h + BALL_RADIUS;
  }
  return { x, y, vx, vy };
}

/** Bounce off the left/right walls and the ceiling; the floor is handled by the caller (a life). */
export function reflectWalls(ball: Ball): Ball {
  let { x, y, vx, vy } = ball;
  if (x - BALL_RADIUS < 0) {
    x = BALL_RADIUS;
    vx = Math.abs(vx);
  } else if (x + BALL_RADIUS > WIDTH) {
    x = WIDTH - BALL_RADIUS;
    vx = -Math.abs(vx);
  }
  if (y - BALL_RADIUS < 0) {
    y = BALL_RADIUS;
    vy = Math.abs(vy);
  }
  return { x, y, vx, vy };
}

/** How many substeps `dt` must be split into so this ball can never move more than
 *  `MAX_SUBSTEP_DISTANCE` in one — the frame-rate-independent anti-tunnelling guarantee. */
export function substepCount(ball: Ball, dt: number, speedMultiplier: number): number {
  const distance = speedOf(ball) * speedMultiplier * dt;
  if (distance <= 0) return 1;
  return Math.max(1, Math.ceil(distance / MAX_SUBSTEP_DISTANCE));
}

// ---------------------------------------------------------------------------
// One ball, one substep
// ---------------------------------------------------------------------------

interface SubstepResult {
  ball: Ball | null; // null once it falls past the floor
  bricks: Brick[];
  events: GameEvent[];
  scoreGained: number;
  powerUpSpawn: PowerUp | null;
  paddleHit: boolean;
}

function moveSubstep(
  ball: Ball,
  subDt: number,
  speedMultiplier: number,
  paddle: Paddle,
  bricks: Brick[],
  rng: () => number,
): SubstepResult {
  let moved: Ball = {
    ...ball,
    x: ball.x + ball.vx * speedMultiplier * subDt,
    y: ball.y + ball.vy * speedMultiplier * subDt,
  };
  moved = reflectWalls(moved);

  if (moved.y - BALL_RADIUS > HEIGHT) {
    return { ball: null, bricks, events: [], scoreGained: 0, powerUpSpawn: null, paddleHit: false };
  }

  const events: GameEvent[] = [];
  let scoreGained = 0;
  let powerUpSpawn: PowerUp | null = null;
  let paddleHit = false;

  if (moved.vy > 0 && circleRectOverlap(moved, paddleRect(paddle))) {
    const speed = speedOf(ball);
    const { vx, vy } = paddleBounceVelocity(moved, paddle, speed);
    moved = { x: moved.x, y: PADDLE_Y - BALL_RADIUS, vx, vy };
    paddleHit = true;
  }

  let nextBricks = bricks;
  const hitIndex = bricks.findIndex((b) => circleRectOverlap(moved, b));
  if (hitIndex !== -1) {
    const brick = bricks[hitIndex];
    moved = reflectOffRect(moved, brick);
    const hp = brick.hp - 1;
    const destroyed = hp <= 0;
    scoreGained = brick.maxHp * 10;
    nextBricks = destroyed
      ? bricks.slice(0, hitIndex).concat(bricks.slice(hitIndex + 1))
      : bricks
          .slice(0, hitIndex)
          .concat([{ ...brick, hp }], bricks.slice(hitIndex + 1));
    events.push({ type: "brickHit", brick: { ...brick, hp }, destroyed });
    if (destroyed && rng() < POWERUP_DROP_CHANCE) {
      const type = POWERUP_TYPES[Math.floor(rng() * POWERUP_TYPES.length)];
      powerUpSpawn = { x: brick.x + brick.w / 2, y: brick.y + brick.h / 2, type };
      events.push({ type: "powerUpSpawned", powerUp: powerUpSpawn });
    }
  }

  return { ball: moved, bricks: nextBricks, events, scoreGained, powerUpSpawn, paddleHit };
}

// ---------------------------------------------------------------------------
// Falling power-ups
// ---------------------------------------------------------------------------

export function powerUpRect(powerUp: PowerUp): Rect {
  return {
    x: powerUp.x - POWERUP_SIZE / 2,
    y: powerUp.y - POWERUP_SIZE / 2,
    w: POWERUP_SIZE,
    h: POWERUP_SIZE,
  };
}

function rectOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ---------------------------------------------------------------------------
// The whole-frame step
// ---------------------------------------------------------------------------

/** A fresh board for `level` (0-based), keeping `score` and `lives` carried over from before. */
export function createLevelState(
  level: number,
  score: number,
  lives: number,
  rng: () => number = Math.random,
): GameState {
  const paddle: Paddle = { x: WIDTH / 2, width: BASE_PADDLE_WIDTH };
  const speed = ballSpeedForLevel(level);
  return {
    balls: [spawnBall(paddle, speed, rng)],
    paddle,
    bricks: generateLevel(level, rng),
    powerUps: [],
    score,
    lives,
    level,
    wideTimer: 0,
    slowTimer: 0,
  };
}

export function newGame(rng: () => number = Math.random): GameState {
  return createLevelState(0, 0, LIVES_START, rng);
}

/**
 * Advance the whole simulation by `dtSeconds` of real time, steering the paddle toward
 * `paddleTargetX`. Internally sub-steps each ball independently so a fast ball can never cross a
 * whole brick (or the paddle) between checks — the frame-rate-independent, no-tunnelling
 * guarantee this whole module exists to keep. Returns the new state and every event that
 * occurred, in order, for the renderer to react to (score pop, sound, particle, banner).
 */
export function stepGame(
  state: GameState,
  dtSeconds: number,
  paddleTargetX: number,
  rng: () => number = Math.random,
): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];

  const wideTimer = Math.max(0, state.wideTimer - dtSeconds);
  const slowTimer = Math.max(0, state.slowTimer - dtSeconds);
  const width = wideTimer > 0 ? WIDE_PADDLE_WIDTH : BASE_PADDLE_WIDTH;
  const half = width / 2;
  const paddle: Paddle = { x: clamp(paddleTargetX, half, WIDTH - half), width };

  const speedMultiplier = slowTimer > 0 ? SLOW_FACTOR : 1;

  let bricks = state.bricks;
  let score = state.score;
  const survivingBalls: Ball[] = [];
  const extraBalls: Ball[] = [];
  let lostBalls = 0;

  for (const ball of state.balls) {
    let current: Ball = ball;
    const steps = substepCount(ball, dtSeconds, speedMultiplier);
    const subDt = dtSeconds / steps;
    let lost = false;

    for (let i = 0; i < steps; i++) {
      const result = moveSubstep(current, subDt, speedMultiplier, paddle, bricks, rng);
      bricks = result.bricks;
      score += result.scoreGained;
      events.push(...result.events);
      if (result.ball === null) {
        lost = true;
        break;
      }
      current = result.ball;
    }

    if (lost) {
      lostBalls += 1;
    } else {
      survivingBalls.push(current);
    }
  }

  // Power-ups fall regardless of which ball triggered them; catching one applies its effect and
  // (for multiball) mints new balls off whichever ball is currently in play.
  let effectiveWideTimer = wideTimer;
  let effectiveSlowTimer = slowTimer;
  const pRect = paddleRect(paddle);
  const survivingPowerUps: PowerUp[] = [];
  for (const powerUp of state.powerUps) {
    const fallen: PowerUp = { ...powerUp, y: powerUp.y + POWERUP_FALL_SPEED * dtSeconds };
    if (fallen.y - POWERUP_SIZE / 2 > HEIGHT) continue; // missed, no penalty
    if (rectOverlap(powerUpRect(fallen), pRect)) {
      events.push({ type: "powerUpCollected", powerUpType: fallen.type });
      if (fallen.type === "wide") effectiveWideTimer = POWERUP_WIDE_SECONDS;
      else if (fallen.type === "slow") effectiveSlowTimer = POWERUP_SLOW_SECONDS;
      else if (fallen.type === "multiball") {
        const source = survivingBalls[0] ?? spawnBall(paddle, ballSpeedForLevel(state.level), rng);
        const speed = speedOf(source);
        for (const sign of [-1, 1]) {
          if (survivingBalls.length + extraBalls.length >= MAX_BALLS) break;
          const theta = Math.atan2(source.vx, -source.vy) + sign * 0.35;
          extraBalls.push({
            x: source.x,
            y: source.y,
            vx: speed * Math.sin(theta),
            vy: -Math.abs(speed * Math.cos(theta)),
          });
        }
      }
      continue;
    }
    survivingPowerUps.push(fallen);
  }

  let balls = survivingBalls.concat(extraBalls);
  let lives = state.lives;

  if (balls.length === 0 && state.balls.length > 0) {
    lives -= 1;
    events.push({ type: "ballLost" }, { type: "lifeLost" });
    if (lives > 0) {
      balls = [spawnBall(paddle, ballSpeedForLevel(state.level), rng)];
    } else {
      events.push({ type: "gameOver" });
    }
  } else if (lostBalls > 0) {
    events.push({ type: "ballLost" });
  }

  if (lives > 0 && bricks.length === 0) {
    events.push({ type: "levelCleared" });
  }

  return {
    state: {
      balls,
      paddle,
      bricks,
      powerUps: survivingPowerUps,
      score,
      lives,
      level: state.level,
      wideTimer: effectiveWideTimer,
      slowTimer: effectiveSlowTimer,
    },
    events,
  };
}
