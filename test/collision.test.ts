// Unit tests for the physics primitives: wall/paddle/brick reflection, the paddle's
// hit-position-dependent bounce angle, and the anti-tunnelling substep guarantee. No DOM, no
// canvas: `bun test` runs this directly against `frontend/modules/.logic.ts`.

import { describe, expect, test } from "bun:test";
import {
  BALL_RADIUS,
  HEIGHT,
  MAX_BOUNCE_ANGLE,
  MAX_SUBSTEP_DISTANCE,
  WIDTH,
  circleRectOverlap,
  paddleBounceVelocity,
  reflectOffRect,
  reflectWalls,
  speedOf,
  substepCount,
  type Ball,
  type Paddle,
} from "../frontend/modules/.logic.ts";

function ball(partial: Partial<Ball>): Ball {
  return { x: 0, y: 0, vx: 0, vy: 0, ...partial };
}

describe("reflectWalls", () => {
  test("bounces off the left wall", () => {
    const b = reflectWalls(ball({ x: -1, y: 100, vx: -50, vy: 10 }));
    expect(b.x).toBe(BALL_RADIUS);
    expect(b.vx).toBe(50);
  });

  test("bounces off the right wall", () => {
    const b = reflectWalls(ball({ x: WIDTH + 1, y: 100, vx: 50, vy: 10 }));
    expect(b.x).toBe(WIDTH - BALL_RADIUS);
    expect(b.vx).toBe(-50);
  });

  test("bounces off the ceiling", () => {
    const b = reflectWalls(ball({ x: 100, y: -1, vx: 10, vy: -50 }));
    expect(b.y).toBe(BALL_RADIUS);
    expect(b.vy).toBe(50);
  });

  test("does nothing in the open middle of the board", () => {
    const b = reflectWalls(ball({ x: 160, y: 200, vx: 30, vy: -30 }));
    expect(b).toEqual({ x: 160, y: 200, vx: 30, vy: -30 });
  });

  test("never reflects the floor — that's a lost ball, handled elsewhere", () => {
    const b = reflectWalls(ball({ x: 160, y: HEIGHT + 50, vx: 0, vy: 50 }));
    expect(b.vy).toBe(50);
    expect(b.y).toBe(HEIGHT + 50);
  });
});

describe("paddleBounceVelocity", () => {
  const paddle: Paddle = { x: 160, width: 56 };

  test("dead centre bounces straight up", () => {
    const { vx, vy } = paddleBounceVelocity(ball({ x: 160 }), paddle, 200);
    expect(vx).toBeCloseTo(0, 5);
    expect(vy).toBeCloseTo(-200, 5);
  });

  test("hitting the right edge sends it right at the maximum bounce angle", () => {
    const { vx, vy } = paddleBounceVelocity(ball({ x: 160 + 28 }), paddle, 200);
    expect(vx).toBeCloseTo(200 * Math.sin(MAX_BOUNCE_ANGLE), 5);
    expect(vy).toBeCloseTo(-200 * Math.cos(MAX_BOUNCE_ANGLE), 5);
  });

  test("hitting the left edge mirrors the right edge", () => {
    const right = paddleBounceVelocity(ball({ x: 160 + 28 }), paddle, 200);
    const left = paddleBounceVelocity(ball({ x: 160 - 28 }), paddle, 200);
    expect(left.vx).toBeCloseTo(-right.vx, 5);
    expect(left.vy).toBeCloseTo(right.vy, 5);
  });

  test("a hit beyond the paddle's edge clamps rather than overshooting the max angle", () => {
    const farRight = paddleBounceVelocity(ball({ x: 500 }), paddle, 200);
    const edge = paddleBounceVelocity(ball({ x: 160 + 28 }), paddle, 200);
    expect(farRight).toEqual(edge);
  });

  test("speed is always preserved — an elastic bounce, never a speed source or sink", () => {
    for (const x of [132, 145, 160, 175, 188]) {
      const { vx, vy } = paddleBounceVelocity(ball({ x }), paddle, 200);
      expect(Math.hypot(vx, vy)).toBeCloseTo(200, 5);
    }
  });

  test("always bounces upward, regardless of the incoming ball's own direction", () => {
    const { vy } = paddleBounceVelocity(ball({ x: 160, vy: 999 }), paddle, 200);
    expect(vy).toBeLessThan(0);
  });
});

describe("circleRectOverlap / reflectOffRect", () => {
  const rect = { x: 100, y: 100, w: 40, h: 16 };

  test("no overlap when far away", () => {
    expect(circleRectOverlap(ball({ x: 0, y: 0 }), rect)).toBe(false);
  });

  test("overlap when the circle touches the rect", () => {
    expect(circleRectOverlap(ball({ x: 100, y: 95 }), rect)).toBe(true);
  });

  test("reflects vertically off the top face and pushes the ball back outside it", () => {
    const b = reflectOffRect(ball({ x: 110, y: 99, vx: 20, vy: 50 }), rect);
    expect(b.vy).toBeLessThan(0);
    expect(b.y).toBeLessThanOrEqual(rect.y - BALL_RADIUS + 1e-9);
  });

  test("reflects horizontally off a side face it penetrates less deeply than top/bottom", () => {
    // Centred vertically on the rect, just touching its left edge — purely a side hit.
    const b = reflectOffRect(ball({ x: 101, y: 108, vx: 30, vy: 5 }), rect);
    expect(b.vx).toBeLessThan(0);
    expect(b.x).toBeLessThanOrEqual(rect.x - BALL_RADIUS + 1e-9);
  });

  test("after reflecting, the ball sits at exactly its radius from the rect, not buried inside it", () => {
    const b = reflectOffRect(ball({ x: 110, y: 99, vx: 20, vy: 50 }), rect);
    const closestX = Math.min(Math.max(b.x, rect.x), rect.x + rect.w);
    const closestY = Math.min(Math.max(b.y, rect.y), rect.y + rect.h);
    expect(Math.hypot(b.x - closestX, b.y - closestY)).toBeCloseTo(BALL_RADIUS, 5);
  });
});

describe("substepCount — the anti-tunnelling guarantee", () => {
  test("a stationary ball needs only one substep", () => {
    expect(substepCount(ball({ vx: 0, vy: 0 }), 1 / 60, 1)).toBe(1);
  });

  test("a slow ball at a normal frame rate needs only one substep", () => {
    expect(substepCount(ball({ vx: 0, vy: -220 }), 1 / 60, 1)).toBe(1);
  });

  test("a very fast ball, or a dropped frame, is split into enough substeps that each one is short", () => {
    const fast = ball({ vx: 0, vy: -4000 });
    const dt = 1 / 10; // a 10fps frame — the kind of hitch that tunnels naive physics
    const n = substepCount(fast, dt, 1);
    const perSubstep = (speedOf(fast) * dt) / n;
    expect(perSubstep).toBeLessThanOrEqual(MAX_SUBSTEP_DISTANCE + 1e-9);
    expect(n).toBeGreaterThan(1);
  });
});
