import { expect, test } from 'bun:test';
import { createMergeableStore } from 'tinybase';
import { dayFromYMD } from '../src/lib/dates.ts';
import { buildCalendar } from './ical.ts';

const MON = dayFromYMD(2026, 9, 5);
const NOW = Date.UTC(2026, 9, 6, 9);

test('a person’s feed: all-day, timed, repeating, time off and days off', () => {
  const s = createMergeableStore();
  s.setRow('users', 'ava', { name: 'Ava' });
  s.setRow('users', 'noah', { name: 'Noah' });
  const t = (id: string, row: Record<string, string | number | boolean>) =>
    s.setRow('tasks', id, { userId: 'ava', start: MON, end: MON, title: id, notes: '', projectId: '', repeat: '', repeatUntil: 0, skip: '', time: '', kind: '', done: false, group: '', ...row });
  t('Workshop, day one', { start: MON, end: MON + 2 });
  t('Standup', { time: '9:30–9:45', repeat: 'weekly', repeatUntil: MON + 14 });
  t('Leave', { kind: 'off', title: '', start: MON + 7, end: MON + 11 });
  t('Not hers', { userId: 'noah' });
  s.setRow('milestones', 'h', { day: MON + 21, title: 'Bank holiday', off: true });
  s.setRow('milestones', 'm', { day: MON + 3, title: 'Launch', off: false });
  const ics = buildCalendar(s, 'ava', 'Studio', NOW, (id) => `https://x.test/s/a?task=${id}`);
  expect(ics).toContain('X-WR-CALNAME:Ava · Studio');
  expect(ics).toContain('SUMMARY:Workshop\\, day one');
  expect(ics).toContain('DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261008');
  expect(ics.match(/SUMMARY:Standup/g)).toHaveLength(3);
  expect(ics).toContain('DTSTART:20261012T093000\r\nDTEND:20261012T094500');
  expect(ics).toContain('UID:Standup-1@prepweek');
  expect(ics).toContain('URL:https://x.test/s/a?task=Standup~1');
  expect(ics).toContain('SUMMARY:Time off');
  expect(ics).toContain('SUMMARY:Day off: Bank holiday');
  expect(ics).not.toContain('Launch');
  expect(ics).not.toContain('Not hers');
  for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
});

test('the team feed lists a shared task once, with everyone on it', () => {
  const s = createMergeableStore();
  s.setRow('users', 'ava', { name: 'Ava' });
  s.setRow('users', 'noah', { name: 'Noah' });
  for (const [id, u] of [['a', 'ava'], ['b', 'noah']] as const)
    s.setRow('tasks', id, { userId: u, start: MON, end: MON, title: 'Pitch', notes: '', projectId: '', repeat: '', repeatUntil: 0, skip: '', time: '', kind: '', done: false, group: 'a' });
  const ics = buildCalendar(s, 'all', 'Studio', NOW, () => '');
  expect(ics.match(/SUMMARY:Pitch/g)).toHaveLength(1);
  expect(ics).toContain('SUMMARY:Pitch (Ava\\, Noah)');
});
