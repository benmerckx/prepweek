// Export the plan as CSV, in the columns Teamweek / Toggl Plan exports use
// (so the file opens in a spreadsheet and imports back into PrepWeek or
// elsewhere), plus PrepWeek's own: type, color and notes. Estimates are in
// minutes, as Teamweek writes them.

import { getUser, parseTags, store, type TaskRow } from '../data/store.ts';
import { allArchived } from '../data/archive.ts';
import { ymd } from '../lib/dates.ts';

const HEADER = [
  'Task name', 'Task status', 'Type', 'Project name', 'Client name', 'Tags', 'Assignee name', 'Assignee email',
  'Start date', 'End date', 'Recurrence', 'Repeat until', 'Start time', 'End time', 'Estimated minutes', 'Color', 'Notes', 'Task ID',
];

const iso = (day: number) => {
  const { y, m, d } = ymd(day);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const TIME = /(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/;

/**
 * Every task as a CSV row (a task for several people: a row per person),
 * archived ones (`archived`: id → row) included.
 */
export const planCsv = (archived: Record<string, TaskRow> = {}): string => {
  const rows = [HEADER.map(cell).join(',')];
  const all: Record<string, TaskRow> = { ...archived };
  for (const id of store.getRowIds('tasks')) all[id] = store.getRow('tasks', id) as TaskRow;
  const ids = Object.keys(all).sort((a, b) => all[a]!.start - all[b]!.start);
  for (const id of ids) {
    const t = all[id]!;
    const user = getUser(t.userId);
    const project = t.projectId && store.hasRow('projects', t.projectId) ? store.getRow('projects', t.projectId) : null;
    const clientId = (project?.clientId as string) || '';
    const client = clientId && store.hasRow('clients', clientId) ? (store.getCell('clients', clientId, 'name') as string) : ((project?.client as string) ?? '');
    const time = TIME.exec(t.time ?? '');
    rows.push(
      [
        t.title,
        t.done ? 'Done' : 'Open',
        t.kind === 'off' ? 'Time off' : 'Work',
        (project?.name as string) ?? '',
        client,
        parseTags(t.tags).join(', '),
        user?.name ?? '',
        user?.email ?? '',
        iso(Math.min(t.start, t.end)),
        iso(Math.max(t.start, t.end)),
        t.repeat ?? '',
        t.repeat && t.repeatUntil ? iso(t.repeatUntil) : '',
        time?.[1] ?? '',
        time?.[2] ?? '',
        t.estimate || '',
        t.color,
        t.notes ?? '',
        // Rows of one task for several people share it, so it imports as one.
        t.group || id,
      ]
        .map((v) => cell(String(v)))
        .join(','),
    );
  }
  return rows.join('\r\n') + '\r\n';
};

/** Save the CSV as a download. */
export const downloadPlanCsv = async (name: string) => {
  const archived: Record<string, TaskRow> = {};
  for (const b of await allArchived().catch(() => [])) Object.assign(archived, b.tasks);
  // A BOM, so Excel reads it as UTF-8.
  const blob = new Blob(['﻿', planCsv(archived)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(name || 'prepweek').replace(/[^\w\- ]+/g, '').trim() || 'prepweek'} ${iso(Math.floor(Date.now() / 86_400_000))}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
