// All dates on the timeline are integer "day numbers": whole days since
// 1970-01-01 (UTC). Integers make layout, hit-testing and storage trivial and
// immune to DST/timezone drift. Convert to Date only at the presentation edge.

export type Day = number;

const MS_PER_DAY = 86_400_000;

export const dayFromYMD = (y: number, m: number, d: number): Day =>
  Math.floor(Date.UTC(y, m, d) / MS_PER_DAY);

export const dateFromDay = (day: Day): Date => new Date(day * MS_PER_DAY);

/** Today in the user's local calendar, as a day number. */
export const today = (): Day => {
  const now = new Date();
  return dayFromYMD(now.getFullYear(), now.getMonth(), now.getDate());
};

/** 0 = Monday … 6 = Sunday. (Day 0 was a Thursday.) */
export const isoWeekday = (day: Day): number => (((day + 3) % 7) + 7) % 7;

export const isWeekend = (day: Day): boolean => isoWeekday(day) >= 5;

/** Monday on or before `day`. */
export const startOfWeek = (day: Day): Day => day - isoWeekday(day);

export const ymd = (day: Day) => {
  const d = dateFromDay(day);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
};

export const startOfMonth = (day: Day): Day => {
  const { y, m } = ymd(day);
  return dayFromYMD(y, m, 1);
};

export const addMonths = (day: Day, n: number): Day => {
  const { y, m } = ymd(day);
  return dayFromYMD(y, m + n, 1);
};

export const startOfYear = (day: Day): Day => dayFromYMD(ymd(day).y, 0, 1);

/** ISO-8601 week number. */
export const isoWeek = (day: Day): number => {
  const thursday = day - isoWeekday(day) + 3;
  const jan1 = dayFromYMD(ymd(thursday).y, 0, 1);
  return Math.floor((thursday - jan1) / 7) + 1;
};

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export const monthShort = (m: number): string => MONTHS_SHORT[m] ?? '';
export const monthLong = (m: number): string => MONTHS_LONG[m] ?? '';
export const weekdayShort = (day: Day): string => WEEKDAYS[isoWeekday(day)] ?? '';

export const formatDay = (day: Day): string => {
  const { y, m, d } = ymd(day);
  return `${d} ${monthShort(m)} ${y}`;
};

export const formatRange = (start: Day, end: Day): string => {
  if (start === end) return formatDay(start);
  const a = ymd(start);
  const b = ymd(end);
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${monthShort(a.m)} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${monthShort(a.m)} – ${b.d} ${monthShort(b.m)} ${a.y}`;
  return `${formatDay(start)} – ${formatDay(end)}`;
};

/** Number of weekdays (Mon–Fri) in the inclusive range. */
export const workdays = (start: Day, end: Day): number => {
  let n = 0;
  for (let d = start; d <= end; d++) if (!isWeekend(d)) n++;
  return n;
};
