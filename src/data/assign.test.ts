import { describe, expect, test } from 'bun:test';
import { createTask, deleteTask, groupMembers, setAssignees, store, threadOf, updateTask, type TaskRow } from './store.ts';

const users = (id: string) => groupMembers(id).map((t) => store.getCell('tasks', t, 'userId'));
const base: TaskRow = { userId: 'ann', start: 10, end: 12, title: 'Launch', color: '#3b7bff', lane: -1, notes: '' };

describe('several people on one task', () => {
  test('adding people makes linked rows that share edits', () => {
    const id = createTask(base);
    expect(setAssignees(id, ['ann', 'bob', 'cy'])).toBe(id);
    expect(users(id).sort()).toEqual(['ann', 'bob', 'cy']);
    for (const t of groupMembers(id)) expect(threadOf(t)).toBe(id);
    // Title and dates go to everyone; whose row it is doesn't.
    updateTask(id, { title: 'Launch v2', start: 11, end: 13, lane: 2 });
    for (const t of groupMembers(id)) {
      expect(store.getCell('tasks', t, 'title')).toBe('Launch v2');
      expect(store.getCell('tasks', t, 'start')).toBe(11);
    }
    const bob = groupMembers(id).find((t) => store.getCell('tasks', t, 'userId') === 'bob')!;
    expect(store.getCell('tasks', bob, 'lane')).toBe(-1);
  });

  test("removing the open row's person hands back another row", () => {
    const id = createTask(base);
    setAssignees(id, ['ann', 'bob']);
    const next = setAssignees(id, ['bob']);
    expect(next).not.toBe(id);
    expect(store.getCell('tasks', next, 'userId')).toBe('bob');
    // Comments stay on the same thread.
    expect(threadOf(next)).toBe(id);
  });

  test('deleting removes it for everyone; a duplicate stands alone', () => {
    const id = createTask(base);
    setAssignees(id, ['ann', 'bob']);
    const copy = createTask({ ...(store.getRow('tasks', id) as TaskRow) });
    expect(groupMembers(copy)).toEqual([copy]);
    deleteTask(id);
    expect(groupMembers(id)).toEqual([]);
    expect(store.getRowIds('tasks').filter((t) => store.getCell('tasks', t, 'group') === id)).toEqual([]);
  });
});
