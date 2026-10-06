import { describe, expect, test } from 'bun:test';
import { occurrenceStart, occurrences, splitOccurrence } from './recur.ts';
import { dayFromYMD, isWeekend, ymd } from './dates.ts';

const mon = dayFromYMD(2026, 9, 5); // Monday 5 Oct 2026

describe('recur', () => {
  test('weekly and biweekly keep the weekday and length', () => {
    const occ = occurrences(mon, mon + 1, 'weekly', mon + 21, new Set(), mon + 999);
    expect(occ.map((o) => o.start - mon)).toEqual([0, 7, 14, 21]);
    expect(occ.every((o) => o.end - o.start === 1)).toBe(true);
    expect(occurrenceStart(mon, 'biweekly', 3)).toBe(mon + 42);
  });

  test('monthly clamps to the end of short months', () => {
    const jan31 = dayFromYMD(2027, 0, 31);
    expect(ymd(occurrenceStart(jan31, 'monthly', 1))).toEqual({ y: 2027, m: 1, d: 28 });
    expect(ymd(occurrenceStart(jan31, 'monthly', 2))).toEqual({ y: 2027, m: 2, d: 31 });
    expect(ymd(occurrenceStart(jan31, 'monthly', 12))).toEqual({ y: 2028, m: 0, d: 31 });
    const feb29 = dayFromYMD(2028, 1, 29);
    expect(ymd(occurrenceStart(feb29, 'yearly', 1))).toEqual({ y: 2029, m: 1, d: 28 });
    expect(ymd(occurrenceStart(feb29, 'yearly', 4))).toEqual({ y: 2032, m: 1, d: 29 });
  });

  test('daily skips weekends and matches occurrenceStart', () => {
    const occ = occurrences(mon + 3, mon + 3, 'daily', 0, new Set([2]), mon + 20);
    expect(occ.some((o) => isWeekend(o.start))).toBe(false);
    expect(occ.map((o) => o.n).slice(0, 4)).toEqual([0, 1, 3, 4]);
    for (const o of occ) expect(occurrenceStart(mon + 3, 'daily', o.n)).toBe(o.start);
  });

  test('skip and horizon', () => {
    const occ = occurrences(mon, mon, 'weekly', 0, new Set([0, 2]), mon + 28);
    expect(occ.map((o) => o.n)).toEqual([1, 3, 4]);
  });

  test('ids', () => {
    expect(splitOccurrence('abc~12')).toEqual({ base: 'abc', n: 12 });
    expect(splitOccurrence('abc')).toEqual({ base: 'abc', n: 0 });
  });
});
