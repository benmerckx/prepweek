// Calendar feeds: a sheet's plan (or one person's) as an iCalendar file that
// Google Calendar, Apple Calendar and Outlook subscribe to and refresh on
// their own. All-day blocks become all-day events, timed ones get their
// times (floating: shown in the calendar's own time zone).

import type { MergeableStore } from 'tinybase';
import { ymd, type Day } from '../src/lib/dates.ts';
import { isRule, occurrences, parseSkip } from '../src/lib/recur.ts';

/** A year ahead and three months back is what calendars care about. */
const BACK = 92;
const AHEAD = 366;

const pad = (n: number) => String(n).padStart(2, '0');
const date = (day: Day) => {
  const { y, m, d } = ymd(day);
  return `${y}${pad(m + 1)}${pad(d)}`;
};
/** RFC 5545 text: backslash-escape, and fold lines at 75 octets. */
const text = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = (line: string) => {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      len = 0;
    }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
};
const TIME = /(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/;

type Task = { userId: string; start: number; end: number; title: string; notes: string; projectId: string; repeat: string; repeatUntil: number; skip: string; time: string; kind: string; done: boolean; group: string };

/**
 * The feed for `who` (a person row id, or 'all' for everyone) on this sheet.
 * `link` makes a task's address in the app.
 */
export const buildCalendar = (store: MergeableStore, who: string, name: string, now: number, link: (taskId: string) => string): string => {
  const today = Math.floor(now / 86_400_000);
  const from = today - BACK;
  const to = today + AHEAD;
  const person = who === 'all' ? '' : who;
  const personName = person ? String(store.getCell('users', person, 'name') ?? '') : '';
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PrepWeek//Plan//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(personName ? `${personName} · ${name || 'PrepWeek'}` : name || 'PrepWeek')}`,
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];
  const event = (uid: string, start: Day, end: Day, summary: string, description: string, url: string, time: string) => {
    const m = TIME.exec(time);
    lines.push('BEGIN:VEVENT', `UID:${uid}@prepweek`, `DTSTAMP:${stamp}`);
    if (m) {
      lines.push(`DTSTART:${date(start)}T${pad(Number(m[1]))}${m[2]}00`, `DTEND:${date(end)}T${pad(Number(m[3]))}${m[4]}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${date(start)}`, `DTEND;VALUE=DATE:${date(end + 1)}`, 'TRANSP:TRANSPARENT');
    }
    lines.push(fold(`SUMMARY:${text(summary)}`));
    if (description) lines.push(fold(`DESCRIPTION:${text(description)}`));
    if (url) lines.push(fold(`URL:${url}`));
    lines.push('END:VEVENT');
  };

  const people = new Map(store.getRowIds('users').map((id) => [id, String(store.getCell('users', id, 'name') ?? '')]));
  // One event per task for several people in the team feed, with everyone's names.
  const seen = new Set<string>();
  for (const id of store.getRowIds('tasks')) {
    const t = store.getRow('tasks', id) as unknown as Task;
    if (person ? t.userId !== person : seen.has(t.group || id)) continue;
    seen.add(t.group || id);
    const names = !person && t.group
      ? store.getRowIds('tasks').filter((x) => store.getCell('tasks', x, 'group') === t.group).map((x) => people.get(String(store.getCell('tasks', x, 'userId'))) ?? '')
      : [people.get(t.userId) ?? ''];
    const project = t.projectId ? String(store.getCell('projects', t.projectId, 'name') ?? '') : '';
    const title = t.title || (t.kind === 'off' ? 'Time off' : 'Untitled');
    const summary = (t.done ? '✓ ' : '') + (person ? title : `${title} (${names.filter(Boolean).join(', ') || 'Unassigned'})`);
    const description = [t.kind === 'off' ? 'Time off' : project && `Project: ${project}`, t.notes.slice(0, 1500)].filter(Boolean).join('\n\n');
    const runs = isRule(t.repeat)
      ? occurrences(Math.min(t.start, t.end), Math.max(t.start, t.end), t.repeat, t.repeatUntil ?? 0, parseSkip(t.skip), to).map((o) => ({ ...o, oid: o.n ? `${id}~${o.n}` : id }))
      : [{ n: 0, start: Math.min(t.start, t.end), end: Math.max(t.start, t.end), oid: id }];
    for (const r of runs) {
      if (r.end < from || r.start > to) continue;
      event(`${id}-${r.n}`, r.start, r.end, summary, description, link(r.oid), t.time);
    }
  }
  // Days off for everyone, in every feed; other milestones in the team feed.
  for (const id of store.getRowIds('milestones')) {
    const m = store.getRow('milestones', id) as { day: number; title: string; off: boolean };
    if (m.day < from || m.day > to || (person && !m.off)) continue;
    event(`ms-${id}`, m.day, m.day, m.off ? `Day off${m.title ? `: ${m.title}` : ''}` : `◆ ${m.title || 'Milestone'}`, '', '', '');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
};
