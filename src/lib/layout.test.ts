import { describe, expect, test } from 'bun:test';
import { packLanes, type PackItem } from './layout.ts';

const overlaps = (a: PackItem, b: PackItem) => a.start <= b.end && b.start <= a.end;

const assertValid = (items: PackItem[]) => {
  const { lanes, laneCount } = packLanes(items);
  for (const a of items)
    for (const b of items)
      if (a !== b && overlaps(a, b)) expect(lanes.get(a.id)).not.toBe(lanes.get(b.id));
  // Optimal: lane count equals the max number of tasks on any single day.
  let maxDay = 0;
  const days = new Set(items.flatMap((i) => [i.start, i.end]));
  for (const d of days) {
    const n = items.filter((i) => i.start <= d && d <= i.end).length;
    if (n > maxDay) maxDay = n;
  }
  expect(laneCount).toBe(maxDay);
  return lanes;
};

describe('packLanes', () => {
  test('empty', () => {
    expect(packLanes([]).laneCount).toBe(0);
  });

  test('non-overlapping tasks share lane 0', () => {
    const lanes = assertValid([
      { id: 'a', start: 0, end: 2 },
      { id: 'b', start: 3, end: 4 },
      { id: 'c', start: 10, end: 12 },
    ]);
    expect([...lanes.values()]).toEqual([0, 0, 0]);
  });

  test('adjacent days do not overlap, same day does', () => {
    const lanes = assertValid([
      { id: 'a', start: 0, end: 2 },
      { id: 'b', start: 2, end: 4 },
    ]);
    expect(lanes.get('a')).toBe(0);
    expect(lanes.get('b')).toBe(1);
  });

  test('honours lane hints when they are free', () => {
    const lanes = assertValid([
      { id: 'a', start: 0, end: 5, lane: 1 },
      { id: 'b', start: 1, end: 3, lane: 0 },
    ]);
    expect(lanes.get('a')).toBe(1);
    expect(lanes.get('b')).toBe(0);
  });

  test('ignores hints that would increase lane count', () => {
    const { lanes, laneCount } = packLanes([
      { id: 'a', start: 0, end: 5, lane: 4 },
      { id: 'b', start: 10, end: 12, lane: 7 },
    ]);
    expect(laneCount).toBe(1);
    expect(lanes.get('a')).toBe(0);
    expect(lanes.get('b')).toBe(0);
  });

  test('no gaps: tasks float up into lanes left free above them', () => {
    // d spans everything; e and x need three lanes early on. Later, g kept
    // lane 2 from a previous layout, but lane 1 is free all through g.
    const lanes = assertValid([
      { id: 'd', start: 0, end: 9, lane: 0 },
      { id: 'e', start: 1, end: 2, lane: 1 },
      { id: 'x', start: 1, end: 2, lane: 2 },
      { id: 'g', start: 6, end: 7, lane: 2 },
    ]);
    expect(lanes.get('g')).toBe(1);
    expect(lanes.get('x')).toBe(2);
  });

  test('no gaps: a freed top lane fills from below', () => {
    // The task in lane 0 was deleted: the rest move up, keeping their order.
    const lanes = assertValid([
      { id: 'a', start: 0, end: 9, lane: 1 },
      { id: 'b', start: 0, end: 9, lane: 2 },
      { id: 'c', start: 3, end: 4, lane: 3 },
    ]);
    expect([lanes.get('a'), lanes.get('b'), lanes.get('c')]).toEqual([0, 1, 2]);
  });

  test('reports clusters', () => {
    const { clusters } = packLanes([
      { id: 'a', start: 0, end: 2 },
      { id: 'b', start: 1, end: 4 },
      { id: 'c', start: 8, end: 9 },
    ]);
    expect(clusters).toEqual([
      { start: 0, end: 4, lanes: 2 },
      { start: 8, end: 9, lanes: 1 },
    ]);
  });

  test('random inputs are always valid and optimal, with or without hints', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 300; round++) {
      const items: PackItem[] = [];
      const n = 1 + Math.floor(rnd() * 40);
      for (let i = 0; i < n; i++) {
        const start = Math.floor(rnd() * 60);
        const item: PackItem = { id: `t${i}`, start, end: start + Math.floor(rnd() * 8) };
        if (rnd() < 0.5) item.lane = Math.floor(rnd() * 5);
        items.push(item);
      }
      const lanes = assertValid(items);
      // And no task has a lane above it that's free for its whole span.
      for (const it of items)
        for (let l = 0; l < lanes.get(it.id)!; l++)
          expect(items.some((o) => o !== it && lanes.get(o.id) === l && overlaps(o, it))).toBe(true);
    }
  });

  test('stable: re-packing with previous lanes as hints is a fixed point', () => {
    const items: PackItem[] = [
      { id: 'a', start: 0, end: 9 },
      { id: 'b', start: 2, end: 3 },
      { id: 'c', start: 4, end: 6 },
      { id: 'd', start: 5, end: 8 },
    ];
    const first = packLanes(items).lanes;
    const second = packLanes(items.map((i) => ({ ...i, lane: first.get(i.id) }))).lanes;
    expect(second).toEqual(first);
  });
});
