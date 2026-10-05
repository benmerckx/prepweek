import { describe, expect, test } from 'bun:test';
import { parseCsv } from './csv.ts';
import { buildPlan, detectDateOrder, guessMapping, parseDate } from './teamweek.ts';
import { dayFromYMD } from '../lib/dates.ts';

const TOGGL = `﻿Task name,Task status,Project name,Segment,Tags,Assignee name,Assignee email,Start date,End date,Recurrence,Estimated time (minutes),Start time,End time
"Website relaunch, phase 2",In progress,Acme,Design,"ux, web",Ava Peeters,ava@acme.test,2026-10-05,2026-10-09,,480,,
Kickoff,Done,Acme,,,Noah Goossens,noah@acme.test,2026-09-28,2026-09-28,,60,09:00,10:00
Pairing,Open,Internal,,,"Ava Peeters, Noah Goossens","ava@acme.test, noah@acme.test",2026-10-12,2026-10-13,,,,
Backlog idea,Open,Internal,,,,,,,,,,
Orphan,Open,Internal,,,,,2026-10-20,2026-10-21,,,,
`;

describe('csv', () => {
  test('quotes, embedded commas and newlines, BOM, semicolons', () => {
    expect(parseCsv('a,"b, c","d ""q"""\n1,"x\ny",3\n')).toEqual([
      ['a', 'b, c', 'd "q"'],
      ['1', 'x\ny', '3'],
    ]);
    expect(parseCsv('﻿a;b\r\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('teamweek import', () => {
  const [header, ...rows] = parseCsv(TOGGL);

  test('guesses the Toggl Plan columns', () => {
    const m = guessMapping(header!);
    expect(m).toMatchObject({ title: 0, status: 1, project: 2, assignee: 5, email: 6, start: 7, end: 8, estimate: 10 });
    expect(m.tags).toBe(4);
  });

  test('dates: ISO, day/month order detection, serials', () => {
    expect(parseDate('2026-10-05', 'mdy')).toBe(dayFromYMD(2026, 9, 5));
    expect(parseDate('2026-10-05T09:00:00Z', 'dmy')).toBe(dayFromYMD(2026, 9, 5));
    expect(parseDate('05/10/2026', 'dmy')).toBe(dayFromYMD(2026, 9, 5));
    expect(parseDate('10/05/2026', 'mdy')).toBe(dayFromYMD(2026, 9, 5));
    expect(parseDate('5.10.26', 'dmy')).toBe(dayFromYMD(2026, 9, 5));
    expect(parseDate('46300', 'dmy')).toBe(dayFromYMD(2026, 9, 5));
    expect(parseDate('nope', 'dmy')).toBeNull();
    expect(detectDateOrder(['13/02/2026', '01/03/2026'])).toEqual({ order: 'dmy', ambiguous: false });
    expect(detectDateOrder(['02/13/2026'])).toEqual({ order: 'mdy', ambiguous: false });
    expect(detectDateOrder(['01/02/2026']).ambiguous).toBe(true);
  });

  test('builds a plan: matches people, splits assignees, skips what it should', () => {
    const plan = buildPlan(
      rows,
      { mapping: guessMapping(header!), dateOrder: 'dmy', includeDone: false, unassigned: 'skip' },
      [{ id: 'u1', name: 'ava peeters', email: '' }],
    );
    expect(plan.skipped).toEqual({ noDate: 1, unassigned: 1, done: 1 });
    // Ava matched by name to the existing person; Noah is new.
    const ava = plan.people.find((p) => p.existingId === 'u1')!;
    expect(ava.tasks).toBe(2);
    const noah = plan.people.find((p) => p.name === 'Noah Goossens')!;
    expect(noah.existingId).toBeUndefined();
    expect(noah.email).toBe('noah@acme.test');
    expect(plan.tasks).toHaveLength(3); // relaunch + pairing×2
    const relaunch = plan.tasks.find((t) => t.title === 'Website relaunch, phase 2')!;
    expect(relaunch.start).toBe(dayFromYMD(2026, 9, 5));
    expect(relaunch.end).toBe(dayFromYMD(2026, 9, 9));
    expect(relaunch.notes).toContain('Project: Acme');
    expect(relaunch.notes).toContain('Tags: ux, web');
  });

  test('ids are deterministic so re-importing updates instead of duplicating', () => {
    const opts = { mapping: guessMapping(header!), dateOrder: 'dmy' as const, includeDone: true, unassigned: 'row' as const };
    const a = buildPlan(rows, opts, []).tasks.map((t) => t.id);
    const b = buildPlan(rows, opts, []).tasks.map((t) => t.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  test('re-import after people were created keeps the same task ids', () => {
    const opts = { mapping: guessMapping(header!), dateOrder: 'dmy' as const, includeDone: true, unassigned: 'row' as const };
    const first = buildPlan(rows, opts, []);
    // Simulate the first import having created everyone on the sheet.
    const existing = first.people.map((p, i) => ({ id: `u${i}`, name: p.name, email: p.email }));
    const second = buildPlan(rows, opts, existing);
    expect(second.people.every((p) => p.existingId)).toBe(true);
    expect(second.tasks.map((t) => t.id).sort()).toEqual(first.tasks.map((t) => t.id).sort());
  });
});
