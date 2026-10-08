// Rebuilding a sheet: what stays in the live plan, and what moves to the
// archive.
//
// The server keeps a sheet's whole live plan in memory (TinyBase), and a
// Durable Object has 128 MB. So the live plan holds recent and upcoming work;
// tasks that finished a while ago move to the archive (plain rows, read by
// date range when someone scrolls back). The rebuild also leaves out what the
// plan doesn't need: cells at their default value, the rows of deleted things
// (comments, checklist items, files of tasks that are gone), and activity
// older than a few months. See worker/index.ts (rebuild) and worker/archive.ts.

import { isRule } from './recur.ts';

/** Tasks that ended more than this many days ago are archived. */
export const ARCHIVE_AFTER_DAYS = 90;
/** Activity is kept this long, and at most this many entries. */
export const ACTIVITY_DAYS = 90;
export const ACTIVITY_MAX = 3000;

/** Optional task cells at their default value: absent and default read the same. */
export const TASK_DEFAULTS: Record<string, unknown> = {
  projectId: '',
  tags: '',
  repeat: '',
  pattern: '',
  done: false,
  time: '',
  repeatUntil: 0,
  skip: '',
  group: '',
  kind: '',
  estimate: 0,
};

export type Row = Record<string, unknown>;
export type Tables = Record<string, Record<string, Row>>;

/** One archived task with everything on its thread. */
export interface Bundle {
  /** The thread: the task's id, or its group's (a task for several people). */
  thread: string;
  start: number;
  /** Last day any of it covers (a finished series: its last occurrence). */
  last: number;
  tasks: Record<string, Row>;
  checks: Record<string, Row>;
  comments: Record<string, Row>;
  attachments: Record<string, Row>;
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** First and last day a task covers; Infinity for a series without an end. */
export const taskSpan = (t: Row): [number, number] => {
  const start = Math.min(num(t.start), num(t.end));
  const end = Math.max(num(t.start), num(t.end));
  if (!isRule(t.repeat as string)) return [start, end];
  const until = num(t.repeatUntil);
  return [start, until > 0 ? until + (end - start) : Infinity];
};

const leanTask = (row: Row): Row => {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined && v !== null && !(k in TASK_DEFAULTS && TASK_DEFAULTS[k] === v)) out[k] = v;
  return out;
};

export interface Rebuilt {
  tables: Tables;
  bundles: Bundle[];
  /** How much smaller (rows dropped: archived, orphaned, old activity). */
  dropped: { archived: number; orphans: number; activity: number };
}

/**
 * Split a sheet's live tables (no deleted rows: `store.getTables()`) into the
 * lean live plan and archive bundles. `day` is today; `now` the clock (ms).
 */
export const rebuildTables = (input: Tables, day: number, now: number): Rebuilt => {
  const cutoff = day - ARCHIVE_AFTER_DAYS;
  const tasks = input.tasks ?? {};
  // Threads: archived only when every row on them ended before the cutoff.
  const threads = new Map<string, { ids: string[]; start: number; last: number }>();
  for (const [id, t] of Object.entries(tasks)) {
    const thread = (t.group as string) || id;
    const [start, last] = taskSpan(t);
    const th = threads.get(thread);
    if (th) {
      th.ids.push(id);
      th.start = Math.min(th.start, start);
      th.last = Math.max(th.last, last);
    } else threads.set(thread, { ids: [id], start, last });
  }
  const archived = new Map<string, Bundle>();
  for (const [thread, th] of threads)
    if (th.last < cutoff) archived.set(thread, { thread, start: th.start, last: th.last, tasks: {}, checks: {}, comments: {}, attachments: {} });
  const threadOf = new Map<string, string>();
  for (const [thread, th] of threads) for (const id of th.ids) threadOf.set(id, thread);

  const out: Tables = {};
  const dropped = { archived: 0, orphans: 0, activity: 0 };
  for (const [tableId, rows] of Object.entries(input)) {
    const table: Record<string, Row> = {};
    if (tableId === 'tasks') {
      for (const [id, row] of Object.entries(rows)) {
        const b = archived.get(threadOf.get(id)!);
        if (b) {
          b.tasks[id] = leanTask(row);
          dropped.archived++;
        } else table[id] = leanTask(row);
      }
    } else if (tableId === 'checks' || tableId === 'comments' || tableId === 'attachments') {
      // Kept on a live thread, moved along with an archived one, dropped
      // when their task is gone (a thread is a task id or a group id).
      for (const [id, row] of Object.entries(rows)) {
        const thread = row.taskId as string;
        const b = archived.get(thread);
        if (b) b[tableId][id] = row;
        else if (threads.has(thread)) table[id] = row;
        else dropped.orphans++;
      }
    } else if (tableId === 'activity') {
      const recent = Object.entries(rows)
        .filter(([, row]) => num(row.at) >= now - ACTIVITY_DAYS * 86_400_000)
        .sort((a, b) => num(b[1].at) - num(a[1].at))
        .slice(0, ACTIVITY_MAX);
      for (const [id, row] of recent) table[id] = row;
      dropped.activity += Object.keys(rows).length - recent.length;
    } else Object.assign(table, rows);
    if (Object.keys(table).length) out[tableId] = table;
  }
  return { tables: out, bundles: [...archived.values()], dropped };
};
