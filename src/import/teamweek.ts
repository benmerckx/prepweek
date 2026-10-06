// Import from a Teamweek / Toggl Plan task export (CSV).
//
// Toggl Plan's "Export tasks" CSV holds task name, status, project, segment,
// tags, assignee name + email, dates, recurrence, estimate and start/end
// times. Exact headers vary between Teamweek-era exports, Toggl Plan and
// whatever a spreadsheet app re-saved, so nothing here depends on exact
// names: columns are guessed from synonyms and the user can correct the
// mapping in the dialog before importing.

import { dayFromYMD, today, type Day } from '../lib/dates.ts';
import { occurrenceStart, type Rule } from '../lib/recur.ts';
import { PALETTE } from '../data/store.ts';

export const FIELDS = [
  'title', 'assignee', 'email', 'start', 'end', 'project', 'client', 'notes', 'tags', 'segment', 'status', 'color', 'estimate',
  'startTime', 'endTime', 'attachments', 'taskId', 'repeats', 'kind',
] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, number>>;

export const FIELD_LABELS: Record<Field, string> = {
  title: 'Task name',
  assignee: 'Assignee',
  email: 'Assignee email',
  start: 'Start date',
  end: 'End date',
  project: 'Project',
  client: 'Client',
  notes: 'Notes',
  tags: 'Tags',
  segment: 'Segment',
  startTime: 'Start time',
  endTime: 'End time',
  attachments: 'Attachment links',
  taskId: 'Task ID',
  repeats: 'Repeats',
  status: 'Status',
  color: 'Color',
  estimate: 'Estimate',
  kind: 'Type',
};

/** Normalized header synonyms, best first. */
const SYNONYMS: Record<Field, string[]> = {
  title: ['taskname', 'task', 'tasktitle', 'title', 'name'],
  assignee: ['assigneename', 'assignee', 'assignees', 'assignedto', 'user', 'username', 'member', 'membername', 'person', 'people', 'owner'],
  email: ['assigneeemail', 'assigneeemails', 'email', 'useremail', 'memberemail', 'emails'],
  start: ['startdate', 'start', 'startson', 'from', 'begin', 'startdatetime'],
  end: ['enddate', 'end', 'endson', 'to', 'until', 'duedate', 'due', 'enddatetime'],
  project: ['projectname', 'project', 'plan', 'group'],
  client: ['clientname', 'client', 'customer', 'customername'],
  notes: ['notes', 'note', 'description', 'details', 'comment', 'comments'],
  tags: ['tags', 'tag', 'labels', 'label'],
  segment: ['segment', 'segmentname', 'stage'],
  startTime: ['starttime', 'fromtime'],
  endTime: ['endtime', 'totime'],
  attachments: ['attachmentlinks', 'attachments', 'attachmenturls', 'files', 'links'],
  taskId: ['taskid', 'id'],
  repeats: ['repeats', 'repeat', 'recurrence', 'recurring', 'repeatrule'],
  status: ['taskstatus', 'status', 'state', 'done', 'completed'],
  color: ['color', 'colour', 'hex', 'taskcolor', 'projectcolor'],
  kind: ['type', 'kind', 'tasktype'],
  estimate: ['estimatedminutes', 'estimateminutes', 'estimatesminutes', 'estimate', 'estimatedtime', 'estimatedhours', 'estimates'],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Best-effort column mapping from the header row. */
export const guessMapping = (header: string[]): Mapping => {
  const cols = header.map(norm);
  const used = new Set<number>();
  const mapping: Mapping = {};
  // Exact synonym matches first (in field order), then prefix/contains.
  for (const pass of [0, 1, 2] as const) {
    for (const f of FIELDS) {
      if (mapping[f] !== undefined) continue;
      for (const syn of SYNONYMS[f]) {
        const i = cols.findIndex(
          (c, i) => !used.has(i) && (pass === 0 ? c === syn : pass === 1 ? c.startsWith(syn) : syn.length > 3 && c.includes(syn)),
        );
        if (i >= 0) {
          mapping[f] = i;
          used.add(i);
          break;
        }
      }
    }
  }
  return mapping;
};

// --- Dates -------------------------------------------------------------------

export type DateOrder = 'dmy' | 'mdy';

const NUMERIC = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/;
const ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/;

/** Decide day/month order from the values; `ambiguous` if nothing tells. */
export const detectDateOrder = (values: string[]): { order: DateOrder; ambiguous: boolean } => {
  let dmy = false;
  let mdy = false;
  for (const v of values) {
    const m = NUMERIC.exec(v.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (dmy && !mdy) return { order: 'dmy', ambiguous: false };
  if (mdy && !dmy) return { order: 'mdy', ambiguous: false };
  const anyNumeric = values.some((v) => NUMERIC.test(v.trim()));
  return { order: 'dmy', ambiguous: anyNumeric };
};

const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900 && y < 2200;

/** Parse one date cell to a day number, or null. Times are ignored. */
export const parseDate = (raw: string, order: DateOrder): Day | null => {
  const s = raw.trim();
  if (!s) return null;
  let m = ISO.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return valid(y, mo, d) ? dayFromYMD(y, mo - 1, d) : null;
  }
  m = NUMERIC.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [d, mo] = order === 'dmy' ? [a, b] : [b, a];
    return valid(y, mo, d) ? dayFromYMD(y, mo - 1, d) : null;
  }
  // Spreadsheet serial date (days since 1899-12-30).
  if (/^\d{5}(\.\d+)?$/.test(s)) return Math.floor(Number(s)) - 25569;
  // "Mar 4, 2025", "4 March 2025", …
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const dt = new Date(t);
    return dayFromYMD(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }
  return null;
};

// --- Plan ----------------------------------------------------------------------

export interface ExistingUser {
  id: string;
  name: string;
  email: string;
}

export interface ImportOptions {
  mapping: Mapping;
  dateOrder: DateOrder;
  includeDone: boolean;
  /** Turn rows with a repeat rule into series (else: one task each). */
  keepRepeats?: boolean;
  /** "Now" for telling stale series apart (default: today). */
  today?: Day;
  /** What to do with tasks that have no assignee. */
  unassigned: 'skip' | 'row';
}

export interface PlannedPerson {
  key: string;
  name: string;
  email: string;
  /** Set when this matches someone already on the sheet. */
  existingId?: string;
  tasks: number;
}

export interface PlannedTask {
  id: string;
  personKey: string;
  start: Day;
  end: Day;
  title: string;
  color: string;
  notes: string;
  project: string;
  client: string;
  /** Comma-separated. */
  tags: string;
  done: boolean;
  /** "10:30–11:00" for timed tasks, else ''. */
  time: string;
  /** Attachment URLs (added as links). */
  links: string[];
  /** Repeat rule, or '' for a one-off. */
  repeat: Rule | '';
  /** Last day an occurrence may start (0 = open-ended). */
  repeatUntil: Day;
  /** Shared by several people: the id of the first one's block ('' = not shared). */
  group?: string;
  /** 'off' for time off (from PrepWeek's own export). */
  kind?: string;
}

export interface ImportPlan {
  people: PlannedPerson[];
  tasks: PlannedTask[];
  skipped: { noDate: number; unassigned: number; done: number };
  range: [Day, Day] | null;
  /**
   * Rows with a repeat rule: kept as series (`ended` of them given an end
   * because they look finished), or imported once (no matching rule).
   */
  repeats: { series: number; ended: number; once: number };
}

/**
 * "every 1 week", "every 2 weeks", "monthly"… → a rule we support, null for
 * one we don't (every 5 months), '' for no repeat.
 */
export const parseRepeat = (s: string): Rule | '' | null => {
  const t = s.trim().toLowerCase();
  if (!t || /^(never|none|no|-|false|0)$/.test(t)) return '';
  const words: Record<string, Rule> = { daily: 'daily', weekly: 'weekly', biweekly: 'biweekly', fortnightly: 'biweekly', monthly: 'monthly', yearly: 'yearly', annually: 'yearly' };
  if (words[t]) return words[t];
  const m = /^every\s+(\d+)?\s*(workday|weekday|day|week|month|year)s?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1] ?? 1);
  const unit = m[2]!;
  if (n === 1 && /day/.test(unit)) return 'daily';
  if (unit === 'week') return n === 1 ? 'weekly' : n === 2 ? 'biweekly' : null;
  if (unit === 'month') return n === 1 ? 'monthly' : n === 12 ? 'yearly' : null;
  if (unit === 'year') return n === 1 ? 'yearly' : null;
  return null;
};

const DONE = /^(done|completed?|closed|archived|finished|yes|true|x)$/i;
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

const hash = (s: string) => {
  // FNV-1a, 32-bit, as base36.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

const colorFor = (key: string) => {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
};

const splitList = (s: string) =>
  s
    .split(/[;,\n]| & /)
    .map((x) => x.trim())
    .filter(Boolean);

const nameFromEmail = (email: string) =>
  email
    .split('@')[0]!
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(' ');

export const buildPlan = (rows: string[][], opts: ImportOptions, existing: ExistingUser[]): ImportPlan => {
  const { mapping: mp } = opts;
  const cell = (row: string[], f: Field) => (mp[f] === undefined ? '' : (row[mp[f]!] ?? '').trim());
  const byEmail = new Map(existing.filter((u) => u.email).map((u) => [u.email.toLowerCase(), u]));
  const byName = new Map(existing.map((u) => [u.name.toLowerCase(), u]));
  const people = new Map<string, PlannedPerson>();
  const tasks = new Map<string, PlannedTask>();
  const skipped = { noDate: 0, unassigned: 0, done: 0 };
  const repeats = { series: 0, ended: 0, once: 0 };
  let min = Infinity;
  let max = -Infinity;

  const person = (name: string, email: string): PlannedPerson => {
    const e = email.toLowerCase();
    const match = (e && byEmail.get(e)) || (name && byName.get(name.toLowerCase())) || undefined;
    const key = match ? match.id : `new:${e || name.toLowerCase()}`;
    let p = people.get(key);
    if (!p) {
      p = { key, name: match?.name ?? (name || nameFromEmail(email)), email: match?.email || email, existingId: match?.id, tasks: 0 };
      people.set(key, p);
    }
    return p;
  };

  for (const row of rows) {
    if (!opts.includeDone && DONE.test(cell(row, 'status'))) {
      skipped.done++;
      continue;
    }
    let start = parseDate(cell(row, 'start'), opts.dateOrder);
    let end = parseDate(cell(row, 'end'), opts.dateOrder);
    if (start === null && end === null) {
      skipped.noDate++;
      continue;
    }
    start ??= end!;
    end ??= start;
    if (end < start) [start, end] = [end, start];

    const names = splitList(cell(row, 'assignee'));
    const emails = splitList(cell(row, 'email'));
    const count = Math.max(names.length, emails.length);
    const assignees: PlannedPerson[] = [];
    const who = new Map<PlannedPerson, string>();
    const add = (name: string, email: string) => {
      const p = person(name, email);
      assignees.push(p);
      who.set(p, (email || name).toLowerCase());
    };
    for (let i = 0; i < count; i++) {
      add(names.length === count ? names[i]! : (names[0] ?? ''), emails.length === count ? emails[i]! : '');
    }
    if (assignees.length === 0) {
      if (opts.unassigned === 'skip') {
        skipped.unassigned++;
        continue;
      }
      add('Unassigned', '');
    }

    const project = cell(row, 'project');
    const title = cell(row, 'title') || project || 'Untitled';
    const rawColor = cell(row, 'color');
    const color = HEX.test(rawColor) ? (rawColor.startsWith('#') ? rawColor : `#${rawColor}`) : colorFor(project || title);
    // Segments ("🌴 Verlof", "Feedback") become tags; the default one is noise.
    const segment = cell(row, 'segment');
    const tags = [...cell(row, 'tags').split(/[,;|]/), /^default segment$/i.test(segment) ? '' : segment]
      .map((t) => t.trim())
      .filter(Boolean)
      .join(',');
    const est = cell(row, 'estimate');
    let notes = [
      // Exports escape line breaks as a literal "\n".
      cell(row, 'notes').replace(/(?:\\r)?\\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
      est && Number(est) > 0 ? `Estimate: ${est} min` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const t0 = cell(row, 'startTime').slice(0, 5);
    const t1 = cell(row, 'endTime').slice(0, 5);
    const time = t0 ? (t1 && t1 !== t0 ? `${t0}–${t1}` : t0) : '';
    const rawRepeat = cell(row, 'repeats');
    let repeat = opts.keepRepeats === false ? '' : parseRepeat(rawRepeat);
    if (repeat === null) {
      // A rule we can't express: import this occurrence and say so.
      repeats.once++;
      notes = [notes, `Repeats ${rawRepeat.toLowerCase()} in Teamweek.`].filter(Boolean).join('\n\n');
      repeat = '';
    } else if (repeat) repeats.series++;
    // A series' status describes one occurrence, not all of them.
    const done = !repeat && DONE.test(cell(row, 'status'));
    const links = cell(row, 'attachments')
      .split(/\s+|,(?=https?:)/)
      .filter((u) => /^https?:\/\//.test(u));
    const taskId = cell(row, 'taskId');
    const kind = /^(time ?off|off|leave|holiday|vacation|absence|away)$/i.test(cell(row, 'kind').trim()) ? 'off' : '';
    const client = cell(row, 'client');

    // Deterministic ids from what the file says (not from who it matched on
    // this sheet), so importing the same export again updates in place. A
    // task shared by several people becomes a block each, linked as one
    // task (its comments and links live with the first one).
    const ids = assignees.map((p) =>
      taskId ? `tw${taskId}-${hash(who.get(p) ?? '')}` : `tw${hash(`${who.get(p)}|${title}|${project}|${start}|${end}`)}`,
    );
    const group = ids.length > 1 ? ids[0]! : '';
    for (const [i, p] of assignees.entries()) {
      const id = ids[i]!;
      if (!tasks.has(id)) p.tasks++;
      tasks.set(id, { id, personKey: p.key, start, end, title, color, notes, project, client, tags, done, time, links: i ? [] : links, repeat, repeatUntil: 0, ...(group ? { group } : {}), ...(kind ? { kind } : {}) });
      if (start < min) min = start;
      if (end > max) max = end;
    }
  }

  // The export has no end date for a series, and an open-ended one from
  // years ago would fill every week since. So:
  // - when someone started a newer series of the same task (title, project,
  //   client) at least one interval later, the older one ends there (two
  //   yearly renewals a day apart are two series, not a replacement);
  // - a series older than six months ends the last time the same task shows
  //   up as a row of its own (moved or edited occurrences, or a replacement
  //   planned by hand); with none, only its first occurrence stays.
  const now = opts.today ?? today();
  const taskKey = (t: PlannedTask) => `${t.personKey}|${t.title.toLowerCase()}|${t.project}|${t.client}`;
  const series = new Map<string, PlannedTask[]>();
  const lastSeen = new Map<string, Day[]>();
  for (const t of tasks.values()) {
    if (t.repeat) (series.get(taskKey(t)) ?? series.set(taskKey(t), []).get(taskKey(t))!).push(t);
    else (lastSeen.get(taskKey(t)) ?? lastSeen.set(taskKey(t), []).get(taskKey(t))!).push(t.start);
  }
  for (const [k, list] of series) {
    list.sort((a, b) => a.start - b.start);
    const ones = lastSeen.get(k) ?? [];
    for (const cur of list) {
      const second = occurrenceStart(cur.start, cur.repeat as Rule, 1);
      const next = list.find((n) => n.repeat === cur.repeat && n.start >= second);
      if (next) cur.repeatUntil = next.start - 1;
      else if (cur.start < now - 183) {
        const seen = ones.filter((d) => d > cur.start);
        cur.repeatUntil = seen.length ? Math.max(...seen) : cur.start;
      } else continue;
      repeats.ended++;
    }
  }

  return {
    people: [...people.values()].sort((a, b) => b.tasks - a.tasks),
    tasks: [...tasks.values()],
    skipped,
    range: min === Infinity ? null : [min, max],
    repeats,
  };
};
