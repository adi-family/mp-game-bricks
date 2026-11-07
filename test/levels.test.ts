// Unit tests for level progression: the hand-designed boards come back verbatim, and the
// procedural generator that takes over afterward gets strictly harder and never deals a dead
// board nothing can finish.

import { describe, expect, test } from "bun:test";
import {
  BRICK_COLS,
  DESIGNED_LEVELS,
  ballSpeedForLevel,
  generateLevel,
  MAX_BALL_SPEED,
} from "../frontend/modules/.logic.ts";

describe("generateLevel", () => {
  test("the first levels are exactly the hand-designed boards, brick-for-brick", () => {
    for (let i = 0; i < DESIGNED_LEVELS.length; i++) {
      const bricks = generateLevel(i);
      const expectedCount = DESIGNED_LEVELS[i].flat().filter((hp) => hp > 0).length;
      expect(bricks.length).toBe(expectedCount);
      for (const brick of bricks) {
        expect(brick.hp).toBe(DESIGNED_LEVELS[i][brick.row][brick.col]);
      }
    }
  });

  test("is deterministic for a given level and rng", () => {
    const rng = () => 0.42;
    const level = DESIGNED_LEVELS.length + 2;
    const a = generateLevel(level, rng);
    const b = generateLevel(level, rng);
    expect(a).toEqual(b);
  });

  test("every column index is within the board's column count", () => {
    const bricks = generateLevel(DESIGNED_LEVELS.length + 5, () => 0.5);
    for (const brick of bricks) {
      expect(brick.col).toBeGreaterThanOrEqual(0);
      expect(brick.col).toBeLessThan(BRICK_COLS);
    }
  });

  test("a generated level is never entirely empty, even on an unlucky roll", () => {
    // rng() always 1 would roll every cell empty under a naive `rng() < density` check.
    const bricks = generateLevel(DESIGNED_LEVELS.length, () => 0.999999);
    expect(bricks.length).toBeGreaterThan(0);
  });

  test("later procedural levels are never easier than earlier ones: more bricks or more hp", () => {
    const base = DESIGNED_LEVELS.length;
    const early = generateLevel(base, () => 0.5);
    const later = generateLevel(base + 12, () => 0.5);
    const totalHp = (bricks: ReturnType<typeof generateLevel>) =>
      bricks.reduce((sum, b) => sum + b.maxHp, 0);
    expect(later.length + totalHp(later)).toBeGreaterThan(early.length + totalHp(early));
  });
});

describe("ballSpeedForLevel", () => {
  test("increases with level", () => {
    expect(ballSpeedForLevel(5)).toBeGreaterThan(ballSpeedForLevel(0));
  });

  test("never exceeds the cap, howeer high the level", () => {
    expect(ballSpeedForLevel(1000)).toBe(MAX_BALL_SPEED);
  });
});
