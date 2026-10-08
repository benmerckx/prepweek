// The sheet's archive on this device: tasks that finished a while ago (see
// src/lib/rebuild.ts and worker/archive.ts), fetched a stretch of time at a
// time as you scroll back, kept in memory only. Archived tasks show in the
// timeline but can't be edited until they're restored into the live plan.

import { createStore, type Row as TbRow } from 'tinybase';
import { ARCHIVE_AFTER_DAYS, type Bundle } from '../lib/rebuild.ts';
import { today } from '../lib/dates.ts';
import { accessReady, getAccess, withKey } from './access.ts';
import { getServerHttp, getSheet } from './sync.ts';
import { commit, store, type TableId } from './store.ts';

/** Archived task rows, plus counts of what's on their thread (_files, _comments, _checks, _checked). */
export const archive = createStore();

const bundles = new Map<string, Bundle>();
/** Stretches of time asked for (index = day / SPAN). */
const asked = new Set<number>();
const SPAN = 28;

const load = async (from: number, to: number) => {
  const http = getServerHttp();
  if (!http) return;
  // A sheet started here gets its key on the first access check.
  await accessReady(http);
  if (getAccess()?.role === 'none') return;
  const res = await fetch(withKey(`${http}/archive/${encodeURIComponent(getSheet())}?from=${from}&to=${to}`), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Archive ${res.status}`);
  const list = (await res.json()) as Bundle[];
  if (!list.length) return;
  archive.transaction(() => {
    for (const b of list) {
      if (bundles.has(b.thread)) continue;
      bundles.set(b.thread, b);
      const checks = Object.values(b.checks);
      const counts = {
        _files: Object.keys(b.attachments).length,
        _comments: Object.keys(b.comments).length,
        _checks: checks.length,
        _checked: checks.filter((c) => c.done).length,
      };
      for (const [id, row] of Object.entries(b.tasks)) archive.setRow('tasks', id, { ...(row as TbRow), ...counts });
    }
  });
};

/** Make sure what's archived between d0 and d1 is here (a no-op for recent days). */
export const ensureArchive = (d0: number, d1: number) => {
  if (!getServerHttp() || getAccess()?.role === 'none') return;
  const until = Math.min(d1, today() - ARCHIVE_AFTER_DAYS);
  for (let i = Math.floor(d0 / SPAN); i * SPAN <= until; i++) {
    if (asked.has(i)) continue;
    asked.add(i);
    load(i * SPAN, i * SPAN + SPAN - 1).catch((e) => {
      asked.delete(i);
      console.warn('Could not load archived tasks', e);
    });
  }
};

/** The archived thread a task belongs to (if it's archived and loaded). */
export const archivedThread = (taskId: string) => {
  const g = archive.getCell('tasks', taskId, 'group') as string | undefined;
  return bundles.get(g || taskId) ?? null;
};

/** Bring an archived task (its whole thread) back into the live plan, to edit. */
export const restoreArchived = (taskId: string) => {
  const b = archivedThread(taskId);
  if (!b) return;
  const touched: [TableId, string][] = [
    ...Object.keys(b.tasks).map((id) => ['tasks', id] as [TableId, string]),
    ...Object.keys(b.checks).map((id) => ['checks', id] as [TableId, string]),
    ...Object.keys(b.comments).map((id) => ['comments', id] as [TableId, string]),
    ...Object.keys(b.attachments).map((id) => ['attachments', id] as [TableId, string]),
  ];
  commit('Restore from archive', touched, () => {
    for (const [table, rows] of [
      ['checks', b.checks],
      ['comments', b.comments],
      ['attachments', b.attachments],
      ['tasks', b.tasks],
    ] as const)
      for (const [id, row] of Object.entries(rows)) store.setRow(table, id, row as TbRow);
  });
  // The live plan has it now (and wins); the archive drops its copy at the next rebuild.
  archive.transaction(() => {
    for (const id of Object.keys(b.tasks)) archive.delRow('tasks', id);
  });
  bundles.delete(b.thread);
};

export interface ArchivedProject {
  project: string;
  tasks: number;
  days: number;
  first: number;
  last: number;
  people: string[];
}
let summary: Map<string, ArchivedProject> | null = null;
let summaryLoading: Promise<void> | null = null;
/** Per project: what's archived (for the projects pages), once loaded. */
export const archiveSummary = () => summary;
export const loadArchiveSummary = () =>
  (summaryLoading ??= (async () => {
    const http = getServerHttp();
    if (!http || getAccess()?.role === 'none') return;
    const res = await fetch(withKey(`${http}/archive/${encodeURIComponent(getSheet())}?summary`), { cache: 'no-store' });
    if (res.ok) summary = new Map(((await res.json()) as ArchivedProject[]).map((p) => [p.project, p]));
  })().catch(() => {
    summaryLoading = null;
  }));

/** Every archived bundle (CSV export), page by page. */
export const allArchived = async (): Promise<Bundle[]> => {
  const http = getServerHttp();
  if (!http) return [];
  const out: Bundle[] = [];
  for (let after: string | null = ''; after !== null; ) {
    const res = await fetch(withKey(`${http}/archive/${encodeURIComponent(getSheet())}?page=${encodeURIComponent(after)}`), { cache: 'no-store' });
    if (!res.ok) break;
    const page = (await res.json()) as { bundles: Bundle[]; next: string | null };
    out.push(...page.bundles);
    after = page.next;
  }
  return out;
};
