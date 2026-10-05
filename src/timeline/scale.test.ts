import { describe, expect, test } from 'bun:test';
import { Scale } from './scale.ts';
import { dayFromYMD, isWeekend } from '../lib/dates.ts';

const monday = dayFromYMD(2026, 9, 5); // 5 Oct 2026 is a Monday

describe('Scale', () => {
  test('all days', () => {
    const s = new Scale(monday, 40, false);
    expect(s.x(monday)).toBe(0);
    expect(s.x(monday + 6)).toBe(240);
    expect(s.w(monday, monday + 6)).toBe(280);
    expect(s.dayAt(250)).toBeCloseTo(monday + 6.25);
  });

  test('weekends hidden: five columns a week, weekends have no width', () => {
    const s = new Scale(monday, 40, true);
    expect(s.x(monday + 4)).toBe(160); // Friday
    expect(s.x(monday + 5)).toBe(200); // Saturday collapses onto next Monday
    expect(s.x(monday + 7)).toBe(200); // next Monday
    expect(s.w(monday + 5, monday + 6)).toBe(0); // a weekend-only span
    expect(s.w(monday, monday + 13)).toBe(400); // two weeks = 10 columns
    expect(s.cols(monday + 3, monday + 8)).toBe(4); // Thu..Tue = Thu Fri Mon Tue
  });

  test('round trips never land on a weekend', () => {
    const s = new Scale(monday - 70, 30, true);
    for (let c = 0; c < 200; c++) {
      const d = s.dayOfCol(c);
      expect(isWeekend(d)).toBe(false);
      expect(s.col(d)).toBe(c);
    }
    for (let x = 0; x < 3000; x += 7) expect(isWeekend(Math.floor(s.dayAt(x)))).toBe(false);
  });

  test('fractional columns follow fractional days', () => {
    const s = new Scale(monday, 40, true);
    expect(s.colF(monday + 2.5)).toBeCloseTo(2.5);
    expect(s.colF(monday + 5.5)).toBe(5); // inside a hidden day: snaps to its edge
  });
});
