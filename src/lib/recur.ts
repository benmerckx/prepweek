// Recurring tasks. A series is one stored task with a rule; its occurrences
// are derived, never stored. Occurrence n=0 is the stored task itself; the
// rest get the id `<taskId>~<n>`. Deleting or moving a single occurrence
// adds n to the series' skip list (a moved one becomes a task of its own).

import { dayFromYMD, isWeekend, ymd, type Day } from './dates.ts';

export const RULES = ['daily', 'weekly', 'biweekly', 'monthly', 'yearly'] as const;
export type Rule = (typeof RULES)[number];

export const RULE_LABELS: Record<Rule, string> = {
  daily: 'Every workday',
  weekly: 'Every week',
  biweekly: 'Every 2 weeks',
  monthly: 'Every month',
  yearly: 'Every year',
};

export const isRule = (r: string | undefined): r is Rule => !!r && (RULES as readonly string[]).includes(r);

/** At most this many occurrences per series, and no further than 2 years out. */
export const MAX_OCCURRENCES = 520;
export const HORIZON_DAYS = 2 * 366;

const daysInMonth = (y: number, m: number) => dayFromYMD(y, m + 1, 1) - dayFromYMD(y, m, 1);

/** Start day of occurrence n (n >= 0). */
export const occurrenceStart = (start: Day, rule: Rule, n: number): Day => {
  switch (rule) {
    case 'weekly':
      return start + 7 * n;
    case 'biweekly':
      return start + 14 * n;
    case 'monthly':
    case 'yearly': {
      const k = rule === 'yearly' ? 12 * n : n;
      const { y, m, d } = ymd(start);
      const ty = y + Math.floor((m + k) / 12);
      const tm = (((m + k) % 12) + 12) % 12;
      return dayFromYMD(ty, tm, Math.min(d, daysInMonth(ty, tm)));
    }
    case 'daily': {
      let day = start;
      for (let i = 0; i < n; ) if (!isWeekend(++day)) i++;
      return day;
    }
  }
};

export const parseSkip = (s: string | undefined): Set<number> =>
  new Set(s ? s.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0) : []);

export interface Occurrence {
  n: number;
  start: Day;
  end: Day;
}

/**
 * Occurrences of a series (n=0 included unless skipped), up to `until`
 * (inclusive, 0 = open-ended) and never past `horizon`.
 */
export const occurrences = (start: Day, end: Day, rule: Rule, until: Day, skip: Set<number>, horizon: Day): Occurrence[] => {
  const len = end - start;
  const last = until > 0 ? Math.min(until, horizon) : horizon;
  const out: Occurrence[] = [];
  if (rule === 'daily') {
    // Walk day by day instead of recomputing each occurrence from the start.
    let day = start;
    for (let n = 0; n < MAX_OCCURRENCES && day <= last; n++) {
      if (!skip.has(n)) out.push({ n, start: day, end: day + len });
      do day++;
      while (isWeekend(day));
    }
    return out;
  }
  for (let n = 0; n < MAX_OCCURRENCES; n++) {
    const s = occurrenceStart(start, rule, n);
    if (s > last) break;
    if (!skip.has(n)) out.push({ n, start: s, end: s + len });
  }
  return out;
};

/** `abc~3` → { base: 'abc', n: 3 }; a plain id → n = 0. */
export const splitOccurrence = (id: string): { base: string; n: number } => {
  const i = id.lastIndexOf('~');
  if (i < 0) return { base: id, n: 0 };
  const n = Number(id.slice(i + 1));
  return Number.isInteger(n) ? { base: id.slice(0, i), n } : { base: id, n: 0 };
};
export const occurrenceId = (base: string, n: number) => (n === 0 ? base : `${base}~${n}`);
