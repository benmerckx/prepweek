// A sheet's archive: tasks that finished a while ago, with their comments,
// checklists and files, as plain rows in this object's SQLite database.
// Unlike the live plan (a TinyBase store the sheet's object keeps in memory),
// nothing here is loaded until asked for, a date range at a time, so years
// of history cost no memory. Filled by the sheet's rebuild (see index.ts and
// src/lib/rebuild.ts); one object per sheet, named after it.
//
// Arguments and results cross RPC as JSON strings: rows straight from
// TinyBase have no prototype, which RPC can't send.

import { DurableObject } from 'cloudflare:workers';
import type { Bundle } from '../src/lib/rebuild.ts';
import { workdays } from '../src/lib/dates.ts';
import type { Env } from './env.ts';

/** At most this many threads per range answer (the client asks again for more). */
const PAGE = 2000;

export class ArchiveDurableObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (thread TEXT PRIMARY KEY, start INTEGER NOT NULL, last INTEGER NOT NULL, bundle TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS threads_last ON threads (last);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, thread TEXT NOT NULL, project TEXT NOT NULL, person TEXT NOT NULL, start INTEGER NOT NULL, last INTEGER NOT NULL, days INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_thread ON tasks (thread);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, thread TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS files_thread ON files (thread);
    `);
  }

  /** Add (or replace) archived threads. */
  async put(json: string) {
    const bundles = JSON.parse(json) as Bundle[];
    for (const b of bundles) {
      this.forgetOne(b.thread);
      this.sql.exec('INSERT INTO threads (thread, start, last, bundle) VALUES (?, ?, ?, ?)', b.thread, b.start, b.last, JSON.stringify(b));
      for (const [id, t] of Object.entries(b.tasks)) {
        const start = Math.min(Number(t.start), Number(t.end));
        const end = Math.max(Number(t.start), Number(t.end));
        this.sql.exec(
          'INSERT INTO tasks (id, thread, project, person, start, last, days) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id,
          b.thread,
          String(t.projectId ?? ''),
          String(t.userId ?? ''),
          start,
          end,
          workdays(start, end) || end - start + 1,
        );
      }
      for (const id of Object.keys(b.attachments)) this.sql.exec('INSERT OR REPLACE INTO files (id, thread) VALUES (?, ?)', id, b.thread);
    }
    return bundles.length;
  }

  private forgetOne(thread: string) {
    this.sql.exec('DELETE FROM threads WHERE thread = ?', thread);
    this.sql.exec('DELETE FROM tasks WHERE thread = ?', thread);
    this.sql.exec('DELETE FROM files WHERE thread = ?', thread);
  }

  /** Threads that are live again (restored, then rebuilt): drop their archived copy. */
  async forget(threads: string[]) {
    for (const t of threads) this.forgetOne(t);
  }

  /** Archived threads touching [from, to], as a JSON array of bundles. */
  async range(from: number, to: number): Promise<string> {
    const rows = this.sql
      .exec<{ bundle: string }>('SELECT bundle FROM threads WHERE last >= ? AND start <= ? ORDER BY start LIMIT ?', from, to, PAGE)
      .toArray();
    return `[${rows.map((r) => r.bundle).join(',')}]`;
  }

  /** Every bundle, a page at a time (data export): JSON {bundles, next}. */
  async page(after: string): Promise<string> {
    const rows = this.sql.exec<{ thread: string; bundle: string }>('SELECT thread, bundle FROM threads WHERE thread > ? ORDER BY thread LIMIT ?', after, PAGE).toArray();
    const next = rows.length === PAGE ? rows[rows.length - 1]!.thread : null;
    return `{"bundles":[${rows.map((r) => r.bundle).join(',')}],"next":${JSON.stringify(next)}}`;
  }

  /** Per project: archived tasks, workdays, first and last day, people. */
  async summary(): Promise<string> {
    const rows = this.sql
      .exec<{ project: string; tasks: number; days: number; first: number; last: number; people: string }>(
        "SELECT project, COUNT(*) AS tasks, SUM(days) AS days, MIN(start) AS first, MAX(last) AS last, GROUP_CONCAT(DISTINCT person) AS people FROM tasks WHERE project != '' GROUP BY project",
      )
      .toArray();
    return JSON.stringify(rows.map((r) => ({ ...r, people: r.people ? r.people.split(',') : [] })));
  }

  /** How much is archived, and from when to when. */
  async meta(): Promise<{ threads: number; tasks: number; first: number | null; last: number | null }> {
    const t = this.sql.exec<{ n: number; first: number | null; last: number | null }>('SELECT COUNT(*) AS n, MIN(start) AS first, MAX(last) AS last FROM threads').one();
    const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tasks').one().n;
    return { threads: t.n, tasks: n, first: t.first, last: t.last };
  }

  /** Attachment ids still on archived tasks (their files must stay in R2). */
  async fileIds(): Promise<string[]> {
    return this.sql
      .exec<{ id: string }>('SELECT id FROM files')
      .toArray()
      .map((r) => r.id);
  }

  /** The sheet was deleted. */
  async wipe() {
    await this.ctx.storage.deleteAll();
  }
}

/** The archive of a sheet. */
export const archiveOf = (env: Env, sheet: string) => env.ARCHIVES.get(env.ARCHIVES.idFromName(sheet));
