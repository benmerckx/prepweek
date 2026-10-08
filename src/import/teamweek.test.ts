import { describe, expect, test } from 'bun:test';
import { parseCsv } from './csv.ts';
import { buildPlan, detectDateOrder, guessMapping, parseDate, parseRepeat } from './teamweek.ts';
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
    expect(relaunch.project).toBe('Acme');
    expect(relaunch.tags).toBe('ux,web,Design'); // segment becomes a tag
    expect(relaunch.estimate).toBe(480);
    expect(relaunch.notes).toBe('');
    expect(plan.tasks.find((t) => t.title === 'Pairing')!.estimate).toBeUndefined();
  });

  test('estimates in hours, when the column says so', () => {
    const opts = { mapping: guessMapping(header!), dateOrder: 'dmy' as const, includeDone: false, unassigned: 'skip' as const, estimateUnit: 'h' as const };
    const relaunch = buildPlan(rows, opts, []).tasks.find((t) => t.title === 'Website relaunch, phase 2')!;
    expect(relaunch.estimate).toBe(480 * 60);
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

describe('teamweek workspace export (ids, clients, times)', () => {
  const csv = [
    'User ID,User Name,User Email,Client ID,Client Name,Project ID,Project Name,Task ID,Task Name,Start Date,Start Time,End Date,End Time,Estimated Time (minutes),Status,Segment,Tags,Repeats,Notes,Attachment Links',
    '1,Ann Smith,ann@x.test,7,Imec,9,Website,42,Status meeting,2026-03-02,10:30:00,2026-03-02,11:00:00,30,Done,Default Segment,,,Agenda:\\n- item one\\n- item two,https://cdn.test/a/Screen%20shot.png',
    '2,Bob Jones,bob@x.test,7,Imec,9,Website,42,Status meeting,2026-03-02,10:30:00,2026-03-02,11:00:00,30,to-do,🌴 Verlof,,,,',
  ].join('\n');
  const [header, ...rows] = parseCsv(csv);
  const mapping = guessMapping(header!);
  const plan = buildPlan(rows, { mapping, dateOrder: 'dmy', includeDone: true, unassigned: 'skip' }, []);

  test('maps the extra columns', () => {
    expect(header![mapping.client!]).toBe('Client Name');
    expect(header![mapping.startTime!]).toBe('Start Time');
    expect(header![mapping.start!]).toBe('Start Date');
    expect(header![mapping.taskId!]).toBe('Task ID');
    expect(header![mapping.attachments!]).toBe('Attachment Links');
  });

  test('one block per assignee of a shared task, with its details', () => {
    expect(plan.tasks).toHaveLength(2);
    const [a, b] = plan.tasks;
    expect(a!.id).not.toBe(b!.id);
    expect(a!.id.startsWith('tw42-')).toBe(true);
    expect(a!.start).toBe(dayFromYMD(2026, 2, 2));
    expect(a!.time).toBe('10:30–11:00');
    expect(a!.done).toBe(true);
    expect(b!.done).toBe(false);
    expect(a!.client).toBe('Imec');
    expect(a!.tags).toBe(''); // "Default Segment" is dropped
    expect(b!.tags).toBe('🌴 Verlof');
    expect(a!.notes.startsWith('Agenda:\n- item one\n- item two')).toBe(true);
    expect(a!.links).toEqual(['https://cdn.test/a/Screen%20shot.png']);
  });
});

describe('teamweek repeats', () => {
  test('parses Teamweek repeat rules', () => {
    expect(parseRepeat('')).toBe('');
    expect(parseRepeat('every 1 week')).toBe('weekly');
    expect(parseRepeat('every 2 weeks')).toBe('biweekly');
    expect(parseRepeat('every 1 month')).toBe('monthly');
    expect(parseRepeat('every 1 year')).toBe('yearly');
    expect(parseRepeat('Every 1 day')).toBe('daily');
    expect(parseRepeat('every 5 months')).toBeNull();
    expect(parseRepeat('every 3 weeks')).toBeNull();
  });

  const head = 'User ID,User Name,User Email,Task ID,Task Name,Start Date,End Date,Status,Repeats,Notes';
  const csv = [
    head,
    '1,Ann,ann@x.test,10,Stavaza,2025-03-11,2025-03-11,Done,every 1 week,',
    '1,Ann,ann@x.test,11,Stavaza,2026-06-02,2026-06-02,To-do,every 1 week,',
    '1,Ann,ann@x.test,15,Prebes,2024-01-16,2024-01-19,Done,every 1 week,',
    '1,Ann,ann@x.test,16,Prebes,2024-01-23,2024-01-26,Done,,',
    '1,Ann,ann@x.test,17,Prebes,2024-03-12,2024-03-15,Done,,',
    '1,Ann,ann@x.test,18,Cursus,2021-07-08,2021-07-09,Done,every 1 week,',
    '1,Ann,ann@x.test,12,SLA,2026-12-11,2026-12-11,To-do,every 1 year,',
    '1,Ann,ann@x.test,13,Uittreksels,2026-07-11,2026-07-11,To-do,every 5 months,Bring ID',
    '1,Ann,ann@x.test,14,Launch,2026-07-11,2026-07-11,Done,,',
  ].join('\n');
  const [header, ...rows] = parseCsv(csv);
  const mapping = guessMapping(header!);
  const opts = { mapping, dateOrder: "dmy" as const, includeDone: true, unassigned: "skip" as const, today: dayFromYMD(2026, 9, 6) };
  const plan = buildPlan(rows, opts, []);
  const byTitle = (t: string) => plan.tasks.filter((x) => x.title === t).sort((a, b) => a.start - b.start);

  test('repeating rows become series; a newer series ends the older one', () => {
    expect(header![mapping.repeats!]).toBe('Repeats');
    const [old, cur] = byTitle('Stavaza');
    expect(old!.repeat).toBe('weekly');
    expect(old!.repeatUntil).toBe(dayFromYMD(2026, 5, 1));
    expect(cur!.repeatUntil).toBe(0);
    expect(old!.done).toBe(false); // a series' status is one occurrence's
    expect(byTitle('SLA')[0]!.repeat).toBe('yearly');
    expect(byTitle('Launch')[0]!.done).toBe(true);
    expect(plan.repeats).toEqual({ series: 5, ended: 3, once: 1 });
  });

  test('series older than six months end where the task was last seen', () => {
    expect(byTitle('Prebes')[0]!.repeatUntil).toBe(dayFromYMD(2024, 2, 12));
    expect(byTitle('Cursus')[0]!.repeatUntil).toBe(dayFromYMD(2021, 6, 8)); // just the first one
  });

  test('unsupported rules import once, with the rule in the notes', () => {
    const t = byTitle('Uittreksels')[0]!;
    expect(t.repeat).toBe('');
    expect(t.notes).toBe('Bring ID\n\nRepeats every 5 months in Teamweek.');
  });

  test('can import repeats as single tasks', () => {
    const flat = buildPlan(rows, { ...opts, keepRepeats: false }, []);
    expect(flat.tasks.every((t) => t.repeat === '')).toBe(true);
    expect(flat.repeats).toEqual({ series: 0, ended: 0, once: 0 });
  });
});
