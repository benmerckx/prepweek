import { describe, expect, test } from 'bun:test';
import { addCheck, addLink, allLinks, checksOf, createTask, deleteTask, setAssignees, store, updateTask, type TaskRow } from './store.ts';
import { isoWeekday } from '../lib/dates.ts';

// Day 11 is a Monday (day 0 was a Thursday).
const MON = 11;
const task = (start: number, end: number, title: string, userId = 'ann'): string =>
  createTask({ userId, start, end, title, color: '#3b7bff', lane: -1, notes: '' } as TaskRow);
const dates = (id: string) => [store.getCell('tasks', id, 'start'), store.getCell('tasks', id, 'end')];

describe('dependencies', () => {
  test('linking moves the waiting task after the other, down the chain', () => {
    expect(isoWeekday(MON)).toBe(0);
    const a = task(MON, MON + 2, 'Design');
    const b = task(MON + 1, MON + 3, 'Build');
    const c = task(MON + 4, MON + 4, 'Ship');
    expect(addLink(a, b)).toBe('');
    expect(dates(b)).toEqual([MON + 3, MON + 5]);
    expect(addLink(b, c)).toBe('');
    // Build now ends Saturday: Ship (a weekday task) goes to Monday.
    expect(dates(c)).toEqual([MON + 7, MON + 7]);
    // Moving Design later carries both along.
    updateTask(a, { start: MON + 1, end: MON + 4 });
    expect(dates(b)).toEqual([MON + 7, MON + 9]);
    expect(dates(c)).toEqual([MON + 10, MON + 10]);
    // Moving it earlier leaves them where they are.
    updateTask(a, { start: MON - 7, end: MON - 6 });
    expect(dates(b)).toEqual([MON + 7, MON + 9]);
  });

  test('no loops, no self links, no duplicates', () => {
    const a = task(MON, MON, 'A');
    const b = task(MON + 1, MON + 1, 'B');
    expect(addLink(a, a)).not.toBe('');
    expect(addLink(a, b)).toBe('');
    expect(addLink(a, b)).toBe('');
    expect(allLinks().filter((l) => l.from === a && l.to === b)).toHaveLength(1);
    expect(addLink(b, a)).toMatch(/each other/);
  });

  test('a task for several people moves as one, and deleting drops its links and checklist', () => {
    const a = task(MON, MON + 1, 'Plan');
    const b = task(MON, MON, 'Pair', 'bob');
    setAssignees(b, ['bob', 'cy']);
    addLink(a, b);
    for (const t of store.getRowIds('tasks').filter((t) => store.getCell('tasks', t, 'group') === b)) expect(dates(t)).toEqual([MON + 2, MON + 2]);
    addCheck(b, 'Prepare');
    expect(checksOf(b)).toHaveLength(1);
    deleteTask(b);
    expect(allLinks().some((l) => l.to === b)).toBe(false);
    expect(checksOf(b)).toHaveLength(0);
  });
});
