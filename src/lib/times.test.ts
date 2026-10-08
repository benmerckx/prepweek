import { describe, expect, test } from 'bun:test';
import { defaultTime, formatDuration, joinTime, moveStart, parseEstimate, parseTime } from './times.ts';
import { today } from './dates.ts';

describe('times', () => {
  test('parses stored and imported forms', () => {
    expect(parseTime('10:30–11:00')).toEqual({ start: 630, end: 660 });
    expect(parseTime('9:00 - 17:30')).toEqual({ start: 540, end: 1050 });
    expect(parseTime('10:30')).toEqual({ start: 630, end: null });
    expect(parseTime('')).toBeNull();
    expect(parseTime('11:00–10:00')).toBeNull();
  });
  test('round trips', () => {
    expect(joinTime(540, 600)).toBe('09:00–10:00');
    expect(parseTime(joinTime(615, 1425))).toEqual({ start: 615, end: 1425 });
  });
  test('durations', () => {
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(90)).toBe('1h 30m');
  });
  test('defaults to 9–10, or the next hour today', () => {
    expect(defaultTime(today() + 3)).toEqual({ start: 540, end: 600 });
    const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m); return d; };
    expect(defaultTime(today(), at(13, 20))).toEqual({ start: 840, end: 900 });
    expect(defaultTime(today(), at(7, 10))).toEqual({ start: 540, end: 600 });
    expect(defaultTime(today(), at(19))).toEqual({ start: 540, end: 600 });
  });
  test('moving the start keeps the length', () => {
    expect(moveStart({ start: 540, end: 630 }, 600)).toEqual({ start: 600, end: 690 });
    expect(moveStart({ start: 540, end: 660 }, 1380)).toEqual({ start: 1380, end: 1425 });
  });
});

describe('parseEstimate', () => {
  test('reads hours and minutes as people type them', () => {
    expect(parseEstimate('6h')).toBe(360);
    expect(parseEstimate('1h 30m')).toBe(90);
    expect(parseEstimate('1h30')).toBe(90);
    expect(parseEstimate('90m')).toBe(90);
    expect(parseEstimate('45 min')).toBe(45);
    expect(parseEstimate('1.5')).toBe(90);
    expect(parseEstimate('1,5h')).toBe(90);
    expect(parseEstimate('2:30')).toBe(150);
    expect(parseEstimate('12 hours')).toBe(720);
  });
  test('refuses what isn’t an estimate', () => {
    expect(parseEstimate('')).toBeNull();
    expect(parseEstimate('0')).toBeNull();
    expect(parseEstimate('soon')).toBeNull();
    expect(parseEstimate('-2h')).toBeNull();
  });
});
