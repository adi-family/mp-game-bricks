// Scenario tests for the whole-frame orchestrator `stepGame`: brick destruction and score,
// anti-tunnelling under a dropped frame, lives, game over, level-clear, and power-up collection.
// Still no DOM — these drive the state machine directly.

import { describe, expect, test } from "bun:test";
import {
  BASE_PADDLE_WIDTH,
  HEIGHT,
  LIVES_START,
  MAX_BALLS,
  PADDLE_Y,
  POWERUP_WIDE_SECONDS,
  WIDTH,
  WIDE_PADDLE_WIDTH,
  createLevelState,
  stepGame,
  type Brick,
  type GameState,
} from "../frontend/modules/.logic.ts";

function brick(partial: Partial<Brick>): Brick {
  return { col: 0, row: 0, x: 0, y: 0, w: 40, h: 16, hp: 1, maxHp: 1, ...partial };
}

function freshState(overrides: Partial<GameState> = {}): GameState {
  const state = createLevelState(0, 0, LIVES_START, () => 0.5);
  return { ...state, ...overrides };
}

describe("stepGame — brick destruction and anti-tunnelling", () => {
  test("a very fast ball under a dropped (large-dt) frame still registers the brick it crosses", () => {
    const target = brick({ x: 100, y: 200 });
    const state = freshState({
      bricks: [target],
      balls: [{ x: 120, y: 190, vx: 0, vy: 4000 }],
    });

    // A naive single-step integrator would move this ball from y=190 to y=590 in one shot,
    // sailing straight through a brick at y=200..216 and the whole board besides.
    const { state: next, events } = stepGame(state, 1 / 10, WIDTH / 2, () => 1);

    expect(events.some((e) => e.type === "brickHit")).toBe(true);
    expect(next.bricks.length).toBe(0);
    expect(next.score).toBe(state.score + target.maxHp * 10);
  });

  test("a multi-hit brick survives one hit and is destroyed by a second", () => {
    const target = brick({ x: 100, y: 200, hp: 2, maxHp: 2 });
    const state = freshState({ bricks: [target], balls: [{ x: 120, y: 195, vx: 0, vy: 300 }] });

    const first = stepGame(state, 1 / 60, WIDTH / 2, () => 1);
    expect(first.state.bricks.length).toBe(1);
    expect(first.state.bricks[0].hp).toBe(1);
    const hit = first.events.find((e) => e.type === "brickHit");
    expect(hit && "destroyed" in hit && hit.destroyed).toBe(false);

    // Send it back down into the same (now 1-hp) brick for the finishing blow.
    const second = stepGame(
      { ...first.state, balls: [{ x: 120, y: 195, vx: 0, vy: 300 }] },
      1 / 60,
      WIDTH / 2,
      () => 1,
    );
    expect(second.state.bricks.length).toBe(0);
  });

  test("clearing the last brick fires levelCleared, provided lives remain", () => {
    const target = brick({ x: 100, y: 200 });
    const state = freshState({ bricks: [target], balls: [{ x: 120, y: 195, vx: 0, vy: 300 }] });
    const { events } = stepGame(state, 1 / 60, WIDTH / 2, () => 1);
    expect(events.some((e) => e.type === "levelCleared")).toBe(true);
  });
});

describe("stepGame — lives and game over", () => {
  test("a ball falling past the floor costs a life and respawns a new ball, if any lives remain", () => {
    const state = freshState({ lives: 2, balls: [{ x: 160, y: HEIGHT - 2, vx: 0, vy: 400 }] });
    const { state: next, events } = stepGame(state, 1 / 30, WIDTH / 2, () => 1);

    expect(events.some((e) => e.type === "lifeLost")).toBe(true);
    expect(next.lives).toBe(1);
    expect(next.balls.length).toBe(1);
    expect(events.some((e) => e.type === "gameOver")).toBe(false);
  });

  test("losing the last life ends the game with no ball respawned", () => {
    const state = freshState({ lives: 1, balls: [{ x: 160, y: HEIGHT - 2, vx: 0, vy: 400 }] });
    const { state: next, events } = stepGame(state, 1 / 30, WIDTH / 2, () => 1);

    expect(events.some((e) => e.type === "gameOver")).toBe(true);
    expect(next.lives).toBe(0);
    expect(next.balls.length).toBe(0);
  });
});

describe("stepGame — power-ups", () => {
  test("catching a wide power-up arms the wide-paddle timer", () => {
    const state = freshState({
      balls: [],
      powerUps: [{ x: WIDTH / 2, y: PADDLE_Y + 1, type: "wide" }],
    });
    const { state: next, events } = stepGame(state, 1 / 60, WIDTH / 2, () => 1);

    expect(events.some((e) => e.type === "powerUpCollected")).toBe(true);
    expect(next.wideTimer).toBe(POWERUP_WIDE_SECONDS);
    expect(next.powerUps.length).toBe(0);
  });

  test("the widened paddle is actually wider on the following frame", () => {
    let state = freshState({
      balls: [],
      powerUps: [{ x: WIDTH / 2, y: PADDLE_Y + 1, type: "wide" }],
    });
    state = stepGame(state, 1 / 60, WIDTH / 2, () => 1).state;
    expect(state.paddle.width).toBe(BASE_PADDLE_WIDTH); // takes effect from the next frame
    state = stepGame(state, 1 / 60, WIDTH / 2, () => 1).state;
    expect(state.paddle.width).toBe(WIDE_PADDLE_WIDTH);
  });

  test("a missed power-up (reaches the floor uncaught) costs nothing", () => {
    const state = freshState({
      balls: [],
      powerUps: [{ x: WIDTH / 2, y: HEIGHT - 1, type: "slow" }],
    });
    const { state: next } = stepGame(state, 1 / 10, 0, () => 1); // paddle steered away
    expect(next.slowTimer).toBe(0);
    expect(next.powerUps.length).toBe(0);
  });

  test("multiball mints extra balls, capped at MAX_BALLS", () => {
    const state = freshState({
      balls: Array.from({ length: MAX_BALLS }, () => ({ x: 160, y: 300, vx: 0, vy: -200 })),
      powerUps: [{ x: WIDTH / 2, y: PADDLE_Y + 1, type: "multiball" }],
    });
    const { state: next } = stepGame(state, 1 / 60, WIDTH / 2, () => 1);
    expect(next.balls.length).toBeLessThanOrEqual(MAX_BALLS);
  });

  test("multiball from a single ball produces more balls than it started with", () => {
    const state = freshState({
      balls: [{ x: 160, y: 300, vx: 0, vy: -200 }],
      powerUps: [{ x: WIDTH / 2, y: PADDLE_Y + 1, type: "multiball" }],
    });
    const { state: next } = stepGame(state, 1 / 60, WIDTH / 2, () => 1);
    expect(next.balls.length).toBeGreaterThan(1);
  });
});

describe("stepGame — paddle", () => {
  test("the paddle follows the target x, clamped to stay fully on the board", () => {
    const state = freshState({ balls: [] });
    const { state: left } = stepGame(state, 1 / 60, -1000, () => 1);
    expect(left.paddle.x).toBe(BASE_PADDLE_WIDTH / 2);
    const { state: right } = stepGame(state, 1 / 60, 1000, () => 1);
    expect(right.paddle.x).toBe(WIDTH - BASE_PADDLE_WIDTH / 2);
  });
});
