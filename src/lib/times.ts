// Times of day on tasks. A task stores its time as text, "10:30–11:00" (24h,
// en dash), or '' for all day; imports may also bring a single "10:30".
// Times are handled here as minutes since midnight.

import { today, type Day } from './dates.ts';

/** Steps offered in the time pickers, in minutes. */
export const TIME_STEP = 15;
/** Latest time a task can end. */
export const DAY_END = 24 * 60 - TIME_STEP;

export interface TimeRange {
  start: number;
  /** null when only a start time is known. */
  end: number | null;
}

export const parseTime = (s: string): TimeRange | null => {
  const m = /^\s*(\d{1,2})[:.h](\d{2})\s*(?:[–—-]\s*(\d{1,2})[:.h](\d{2}))?\s*$/.exec(s);
  if (!m) return null;
  const start = +m[1]! * 60 + +m[2]!;
  const end = m[3] ? +m[3] * 60 + +m[4]! : null;
  if (start >= 24 * 60 || (end !== null && (end > 24 * 60 || end <= start))) return null;
  return { start, end };
};

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** The stored form: "09:00–10:00". */
export const joinTime = (start: number, end: number) => `${hhmm(start)}–${hhmm(end)}`;

// Follow the locale: "14:30" in most of the world, "2:30 PM" where that's usual.
const hour12 = (() => {
  try {
    return /^h1[12]$/.test(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle ?? '');
  } catch {
    return false;
  }
})();

export const formatClock = (min: number): string => {
  if (!hour12) return hhmm(min);
  const h = Math.floor(min / 60) % 24;
  return `${h % 12 || 12}:${pad(min % 60)} ${h < 12 ? 'AM' : 'PM'}`;
};

/** A stored time for display; unparseable text is shown as is. */
export const formatTime = (s: string): string => {
  const t = parseTime(s);
  if (!t) return s;
  return t.end === null ? formatClock(t.start) : `${formatClock(t.start)}–${formatClock(t.end)}`;
};

/** "45m", "1h", "1h 30m". */
export const formatDuration = (min: number): string => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
};

/**
 * An estimate as typed: "6h", "1h 30m", "1h30", "90m", "1.5" or "1,5" (hours),
 * "2:30". Minutes, or null when it isn't one (or is zero).
 */
export const parseEstimate = (s: string): number | null => {
  const t = s.trim().toLowerCase().replace(',', '.');
  if (!t) return null;
  let min: number;
  const clock = /^(\d+):(\d{2})$/.exec(t);
  const units = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*(?:m(?:in(?:utes?)?)?)?)?$/.exec(t);
  if (clock) min = +clock[1]! * 60 + +clock[2]!;
  else if (/^\d+(?:\.\d+)?$/.test(t)) min = +t * 60;
  else if (units && (units[1] || units[2])) min = (units[1] ? +units[1] * 60 : 0) + (units[2] ? +units[2] : 0);
  else return null;
  min = Math.round(min);
  return min > 0 && min < 10000 * 60 ? min : null;
};

/** "6h", "7.5h": hours, briefly. */
export const formatHours = (h: number): string => `${Math.round(h * 10) / 10}h`;

/**
 * The time a task gets when you add one: an hour from 9:00, or for a task
 * today during working hours, an hour from the next full hour.
 */
export const defaultTime = (day: Day, now = new Date()): { start: number; end: number } => {
  if (day === today()) {
    const next = (now.getHours() + 1) * 60;
    if (next > 9 * 60 && next <= 17 * 60) return { start: next, end: next + 60 };
  }
  return { start: 9 * 60, end: 10 * 60 };
};

/** Move the start, keeping the length (and staying within the day). */
export const moveStart = (t: { start: number; end: number }, start: number) => {
  const end = Math.min(start + (t.end - t.start), DAY_END);
  return { start, end: end > start ? end : Math.min(start + TIME_STEP, 24 * 60) };
};
