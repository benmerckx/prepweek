import { describe, expect, test } from 'bun:test';
import { TOGGL_HEADER, togglToRows, workspacesFromMe } from './toggl.ts';
import { buildPlan, guessMapping } from './teamweek.ts';
import { dayFromYMD } from '../lib/dates.ts';

// v4-style (go-teamweek): one user_id per task, embedded project object.
const V4 = {
  members: [
    { id: 11, name: 'Ava Peeters', email: 'ava@acme.test' },
    { id: 12, name: 'Noah Goossens', email: 'noah@acme.test' },
  ],
  tasks: [
    { id: 1, name: 'Brand workshop', start_date: '2026-10-06', end_date: '2026-10-08', user_id: 11, project: { id: 5, name: 'Acme' }, estimated_minutes: 960, done: false },
    { id: 2, name: 'Kickoff', start_date: '2026-09-28', end_date: '2026-09-28', user_id: 12, done: true },
  ],
};

// v5-style: workspace_members ids, project_id + projects list, wrapped data,
// tag objects, color on the task.
const V5 = {
  members: { data: [{ id: 101, user_id: 7, name: 'Ava Peeters', email: 'ava@acme.test' }, { id: 102, user: { id: 8, name: 'Linus T', email: 'linus@acme.test' } }] },
  projects: [{ id: 9, name: 'Internal', color: '#22a06b' }],
  tasks: {
    data: [
      { id: 3, name: 'Pairing', start_date: '2026-10-13', end_date: '2026-10-14', workspace_members: [101, 102], project_id: 9, tags: [{ name: 'dev' }, 'pair'], notes: 'Bring coffee' },
      { id: 4, name: 'Unplanned', workspace_members: [101] },
    ],
  },
};

describe('toggl api → rows', () => {
  test('workspaces from /me', () => {
    expect(workspacesFromMe({ id: 1, workspaces: [{ id: 42, name: 'Acme' }] })).toEqual([{ id: 42, name: 'Acme' }]);
    expect(workspacesFromMe({ memberships: [{ workspace: { id: 7, name: 'B' } }] })).toEqual([{ id: 7, name: 'B' }]);
  });

  test('v4 shape', () => {
    const rows = togglToRows(V4.tasks, V4.members, []);
    expect(rows[0]).toEqual(['Brand workshop', '', 'Acme', '', 'Ava Peeters', 'ava@acme.test', '2026-10-06', '2026-10-08', '960', '', '']);
    expect(rows[1]![1]).toBe('Done');
  });

  test('v5 shape, multiple assignees, through the import plan', () => {
    const rows = togglToRows(V5.tasks, V5.members, V5.projects);
    expect(rows[0]!.slice(2, 6)).toEqual(['Internal', 'dev, pair', 'Ava Peeters; Linus T', 'ava@acme.test; linus@acme.test']);
    expect(rows[0]![9]).toBe('#22a06b');
    const plan = buildPlan(rows, { mapping: guessMapping(TOGGL_HEADER), dateOrder: 'dmy', includeDone: false, unassigned: 'skip' }, []);
    expect(plan.tasks).toHaveLength(2); // pairing × 2 people; the undated task is skipped
    expect(plan.skipped.noDate).toBe(1);
    expect(plan.tasks[0]!.start).toBe(dayFromYMD(2026, 9, 13));
    expect(plan.tasks[0]!.color).toBe('#22a06b');
    expect(plan.people.map((p) => p.email).sort()).toEqual(['ava@acme.test', 'linus@acme.test']);
  });
});
