import { describe, expect, test } from 'bun:test';
import { answers, dailyWeek, isSolved, levelOf, localDay, makeWeek, ruleState, ruleText, type Week } from './daily.ts';

const check = (w: Week) => {
  // The blocks fill the free days exactly.
  const free = w.rows * 5 - w.off.size;
  expect(w.pieces.reduce((s, p) => s + p.len, 0)).toBe(free);
  // The answer holds, and it's the only one.
  expect(isSolved(w, w.solution)).toBe(true);
  expect(answers(w, 3)).toBe(1);
};

describe('daily week', () => {
  test('every level makes a puzzle with exactly one answer', () => {
    for (const level of [0, 1, 2] as const) for (let seed = 1; seed <= 25; seed++) check(makeWeek(seed * 7919, level));
  });

  test('four months of daily puzzles: unique, readable, quick to make', () => {
    const start = localDay(new Date(2026, 9, 1));
    let slowest = 0;
    for (let d = start; d < start + 120; d++) {
      const t = performance.now();
      const w = dailyWeek(d);
      slowest = Math.max(slowest, performance.now() - t);
      check(w);
      expect(w.rules.filter((r) => r.kind !== 'who').length).toBeLessThanOrEqual(7);
      for (const r of w.rules) expect(ruleText(r, w.pieces).length).toBeGreaterThan(5);
    }
    expect(slowest).toBeLessThan(1500);
  });

  test('the same day gives the same puzzle', () => {
    const d = localDay(new Date(2026, 9, 9));
    const a = dailyWeek(d);
    const b = dailyWeek(d);
    expect(JSON.stringify(a.pieces)).toBe(JSON.stringify(b.pieces));
    expect(JSON.stringify(a.rules)).toBe(JSON.stringify(b.rules));
    expect(a.number).toBe(9);
  });

  test('easy early in the week, hard on Friday', () => {
    expect(levelOf(localDay(new Date(2026, 9, 5)))).toBe(0); // Monday
    expect(levelOf(localDay(new Date(2026, 9, 7)))).toBe(1); // Wednesday
    expect(levelOf(localDay(new Date(2026, 9, 9)))).toBe(2); // Friday
  });

  test('rules report broken, holding or not yet', () => {
    const w = makeWeek(42, 2);
    const r = w.rules.find((x) => x.kind === 'after' || x.kind === 'together') ?? w.rules[0]!;
    expect(ruleState(r, w.pieces, w.pieces.map(() => null))).toBe(null);
    expect(ruleState(r, w.pieces, w.solution)).toBe(true);
  });
});
