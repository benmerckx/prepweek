import { describe, expect, test } from 'bun:test';
import { ACTIVITY_DAYS, ARCHIVE_AFTER_DAYS, rebuildTables, type Tables } from './rebuild.ts';

const DAY = 21000;
const NOW = 1_800_000_000_000;
const old = DAY - ARCHIVE_AFTER_DAYS - 10;

const sheet = (): Tables => ({
  users: { ann: { name: 'Ann', color: '#000', order: 0, email: '' } },
  tasks: {
    // Finished long ago, with its thread's rows.
    a: { userId: 'ann', start: old - 3, end: old, title: 'Old', color: '#111', lane: -1, notes: '', repeat: '', done: true, tags: '' },
    // Recent: stays, default cells dropped.
    b: { userId: 'ann', start: DAY - 2, end: DAY + 1, title: 'Now', color: '#222', lane: 0, notes: '', repeat: '', group: '', estimate: 0 },
    // A group: one row old enough, the other not, so the thread stays live.
    g1: { userId: 'ann', start: old, end: old, title: 'Pair', color: '#333', lane: -1, notes: '', group: 'g1' },
    g2: { userId: 'bob', start: old, end: DAY, title: 'Pair', color: '#333', lane: -1, notes: '', group: 'g1' },
    // An open-ended series never archives; a finished one does.
    r1: { userId: 'ann', start: old - 400, end: old - 400, title: 'Weekly', color: '#444', lane: -1, notes: '', repeat: 'weekly', repeatUntil: 0 },
    r2: { userId: 'ann', start: old - 400, end: old - 400, title: 'Ended', color: '#555', lane: -1, notes: '', repeat: 'weekly', repeatUntil: old - 30 },
  },
  comments: {
    c1: { taskId: 'a', text: 'done!' },
    c2: { taskId: 'b', text: 'on it' },
    c3: { taskId: 'gone', text: 'task deleted' },
  },
  checks: { k1: { taskId: 'a', text: 'step' } },
  attachments: { f1: { taskId: 'a', name: 'brief.pdf' }, f2: { taskId: 'g1', name: 'shared.pdf' } },
  activity: {
    new: { at: NOW - 1000, label: 'Move task' },
    stale: { at: NOW - (ACTIVITY_DAYS + 1) * 86_400_000, label: 'Old move' },
  },
  links: { l1: { from: 'a', to: 'b' } },
});

describe('rebuildTables', () => {
  const { tables, bundles, dropped } = rebuildTables(sheet(), DAY, NOW);

  test('tasks that finished long ago move to the archive with their thread', () => {
    expect(Object.keys(tables.tasks!).sort()).toEqual(['b', 'g1', 'g2', 'r1']);
    expect(bundles.map((b) => b.thread).sort()).toEqual(['a', 'r2']);
    const a = bundles.find((b) => b.thread === 'a')!;
    expect(Object.keys(a.comments)).toEqual(['c1']);
    expect(Object.keys(a.checks)).toEqual(['k1']);
    expect(Object.keys(a.attachments)).toEqual(['f1']);
    expect(a.last).toBe(old);
    expect(bundles.find((b) => b.thread === 'r2')!.last).toBe(old - 30);
  });

  test('the live plan keeps no defaults, orphans or old activity', () => {
    expect(tables.tasks!.b).toEqual({ userId: 'ann', start: DAY - 2, end: DAY + 1, title: 'Now', color: '#222', lane: 0, notes: '' });
    expect(Object.keys(tables.comments!)).toEqual(['c2']);
    expect(Object.keys(tables.attachments!)).toEqual(['f2']);
    expect(Object.keys(tables.activity!)).toEqual(['new']);
    expect(tables.checks).toBeUndefined();
    expect(tables.links).toEqual({ l1: { from: 'a', to: 'b' } });
    expect(dropped).toEqual({ archived: 2, orphans: 1, activity: 1 });
  });
});
