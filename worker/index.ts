// Cloudflare backend: one Durable Object per sheet.
//
// Each sheet is a TinyBase MergeableStore living in its own Durable Object,
// persisted to that object's private SQLite database. The object is also the
// realtime room: every client of the sheet holds a WebSocket to it, and it
// relays/merges CRDT changes between them. So "one database per sheet" comes
// for free, colocated with the sockets, with no cross-request DB round trips.
//
// Routing (all take ?k=<share key> once a sheet has private links):
//   wss://<host>/sync/<sheetId>      → Durable Object named "sync/<sheetId>"
//   wss://<host>/presence/<sheetId>  → presence relay for the sheet
//   /files/<sheetId>/<id>            → attachment bytes in R2
//   /share/<sheetId>                 → GET sharing state, POST enable/rotate/disable/feed/rebuild
//   /archive/<sheetId>?from=&to=     → archived tasks in a date range (see archive.ts)
//   /ical/<sheetId>/<person|all>.ics?f=<feed key> → calendar feed (no cookie: calendar apps)
//   /auth/*, /api/*                  → accounts, workspaces, sheets (auth.ts)
//   /auth/appsumo/*, /api/appsumo/*  → AppSumo licences (appsumo.ts)
// Everything else is served from ../dist (the Bun-built app).
import { DurableObject } from 'cloudflare:workers';
import { createMergeableStore } from 'tinybase';
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage';
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';
import { directory, handleApi, handleAuth, sessionUser } from './auth.ts';
import { sendDigests, sheetDigest } from './digest.ts';
import { routeOf, statsApi, track } from './stats.ts';
import { adminApi } from './admin.ts';
import { buildCalendar } from './ical.ts';
import { appsumoApi, appsumoCallback, appsumoWebhook } from './appsumo.ts';
import { billingApi } from './billing.ts';
import { personKey } from '../src/lib/plans.ts';
import { rebuildTables } from '../src/lib/rebuild.ts';
import { today } from '../src/lib/dates.ts';
import { archiveOf } from './archive.ts';
import type { Env } from './env.ts';

export { DirectoryDurableObject } from './directory.ts';
export { ArchiveDurableObject } from './archive.ts';

export type Role = 'edit' | 'view' | 'none';
interface Share {
  edit: string;
  view: string;
}

/** TinyBase sync messages a view-only client may send: requests to read. */
const READ_MESSAGES = new Set([1 /* GetContentHashes */, 4, 5, 6, 7 /* Get…Diff */]);

const newToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** A plan this big is rebuilt even with people connected (they reload). */
const BIG_PLAN_TASKS = 15_000;

export class SheetDurableObject extends WsServerDurableObject {
  // Set by createPersister, which TinyBase calls from its constructor: before
  // this class's own fields exist, so no private field or initializer here.
  declare sheetStore: ReturnType<typeof createMergeableStore> | undefined;
  declare sheetPersister: ReturnType<typeof createDurableObjectSqlStoragePersister> | undefined;

  // Stored "fragmented": a row per table/row/value. The default JSON mode
  // keeps the whole sheet in one row, and Cloudflare caps a row at 2 MB, so a
  // big sheet (a Teamweek import) silently stopped being saved: it lived in
  // memory only and was gone for whoever connected after the object restarted.
  override async createPersister() {
    // Keepalive: browsers send "ping" every so often, so idle connections
    // aren't closed along the way; answered without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    const sql = this.ctx.storage.sql;
    const store = (this.sheetStore = createMergeableStore());
    // Once loaded, TinyBase saves the whole store straight back: every row
    // deleted and inserted again, each time the object starts. For a big sheet
    // that is tens of thousands of rows written for nothing, and the free tier
    // allows 100,000 a day. So writes are dropped until that first save is done.
    let skipWrites = false;
    const writes = /^\s*(INSERT|DELETE|UPDATE)\b/i;
    // TinyBase saves each changed row as a DELETE and then an INSERT of the
    // same key: with the primary key index, about 4 rows written where an
    // UPDATE is 1. So a DELETE waits to see what follows; an INSERT into the
    // same table becomes an UPDATE (an INSERT still if there was nothing to
    // update), anything else runs the DELETE first.
    let pending: { table: string; where: string; args: unknown[] } | null = null;
    const flush = () => {
      if (pending) sql.exec(`DELETE FROM ${pending.table} WHERE ${pending.where}`, ...pending.args);
      pending = null;
    };
    const exec = (query: string, ...args: unknown[]) => {
      if (skipWrites && writes.test(query)) return sql.exec('SELECT 1');
      const del = /^DELETE FROM (\S+) WHERE (.+)$/s.exec(query);
      const ins = /^INSERT INTO (\S+) \(.+, value_data, timestamp, hash\) VALUES/s.exec(query);
      if (ins && pending?.table === ins[1]) {
        const { table, where, args: whereArgs } = pending;
        pending = null;
        const update = sql.exec(`UPDATE ${table} SET value_data = ?, timestamp = ?, hash = ? WHERE ${where}`, ...args.slice(-3), ...whereArgs);
        return update.rowsWritten > 0 ? update : sql.exec(query, ...args);
      }
      flush();
      if (del && !/IS NOT NULL/.test(del[2]!)) {
        pending = { table: del[1]!, where: del[2]!, args };
        // A save runs synchronously: whatever is left runs right after it.
        queueMicrotask(flush);
        return sql.exec('SELECT 1');
      }
      return sql.exec(query, ...args);
    };
    const quiet = new Proxy(sql, { get: (target, key) => (key === 'exec' ? exec : Reflect.get(target, key, target)) });
    const persister = createDurableObjectSqlStoragePersister(store, quiet, { mode: 'fragmented' });
    // A wake: the plan is loaded from storage (what most of the hosting costs).
    track(this.env as Env, 'event', ['sheet_load', '']);
    // Sheets saved before the switch: carry the JSON copy over, once.
    const tables = new Set(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name));
    const migrated = tables.has('tinybase_tables') && sql.exec('SELECT 1 FROM tinybase_tables LIMIT 1').toArray().length > 0;
    if (tables.has('tinybase') && !migrated) {
      const old = createMergeableStore();
      await createDurableObjectSqlStoragePersister(old, sql).load();
      store.setMergeableContent(old.getMergeableContent());
      await persister.save();
      sql.exec('DROP TABLE tinybase');
    }
    skipWrites = true;
    this.sheetPersister = persister;
    let saving = false;
    persister.addStatusListener((_, status) => {
      if (status === 2 /* saving */) saving = true;
      else if (saving && status === 0 /* idle */) skipWrites = false;
    });
    // When the plan last changed (after loading), at most a write a minute:
    // the daily alarm only keeps coming back while there's something new.
    let marked = 0;
    store.addDidFinishTransactionListener(() => {
      if (skipWrites || Date.now() - marked < 60_000) return;
      const [tables] = store.getTransactionChanges();
      if (!Object.keys(tables).length) return;
      marked = Date.now();
      this.ctx.storage.kv.put('changed', marked);
    });
    return persister;
  }

  // A big sheet (a Teamweek import: thousands of tasks) syncs in payloads of
  // many megabytes, but Cloudflare drops WebSocket messages over 1 MiB. So
  // payloads go in fragments (see SYNC_FRAGMENT in src/data/sync.ts), and
  // replies that big may take longer than TinyBase's 1 second default.
  override getFragmentSize() {
    return 768 * 1024;
  }

  // Right after starting, the object asks the connected browsers for their
  // content. Usually none is connected yet (the access check wakes it before
  // the socket opens), so that request only ends at its timeout, and every
  // change a browser sends meanwhile waits behind it: a sheet opened on
  // another device looked empty for the first 30 seconds. TinyBase reads
  // this value once but computes each timer from it afresh (`seconds * 1000`),
  // so it answers 1 second for that first request and 30 for every big
  // payload after it.
  #startedRequests = false;
  override getRequestTimeoutSeconds() {
    return { valueOf: () => (this.#startedRequests ? 30 : 1) } as unknown as number;
  }
  override onMessage(fromClientId: string) {
    // The object's own first request is on its way, its timer already set.
    if (fromClientId === 'S') this.#startedRequests = true;
  }

  // --- Link sharing ---
  //
  // A sheet starts open: anyone who knows its URL can edit (like the demo).
  // Turning on private links mints two secret keys; from then on the edit
  // link or the view link is needed. Resetting replaces both and drops
  // everyone connected, so old links stop working at once.

  /** What a share key allows; 'open' when private links are off. */
  async keyRole(key: string): Promise<Role | 'open'> {
    const share = await this.ctx.storage.get<Share>('share');
    if (!share) return 'open';
    if (key && key === share.edit) return 'edit';
    if (key && key === share.view) return 'view';
    return 'none';
  }

  /** Close every connection: they reconnect, and are checked again. */
  kick(reason = 'Access changed') {
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, reason);
  }

  /** The sheet was deleted: drop its connections and free its storage. */
  async wipe() {
    this.kick('Sheet deleted');
    await this.ctx.storage.deleteAll();
  }

  /** The whole sheet as plain tables (data export). */
  async exportTables(): Promise<string> {
    // As JSON: TinyBase's objects have no prototype, which RPC can't send.
    return JSON.stringify({ tables: this.sheetStore?.getTables() ?? {}, values: this.sheetStore?.getValues() ?? {} });
  }

  /** One person's part of the daily digest (see digest.ts). */
  async digest(email: string, day: number, since: number) {
    return this.sheetStore ? sheetDigest(this.sheetStore, email, day, since) : null;
  }

  /** The secret in calendar feed links; made on first use, replaced with the share links. */
  async feedKey(): Promise<string> {
    let k = await this.ctx.storage.get<string>('feedKey');
    if (!k) await this.ctx.storage.put('feedKey', (k = newToken()));
    return k;
  }

  /** A calendar feed, if `key` is the sheet's feed key. */
  async calendar(key: string, who: string, name: string, origin: string, sheet: string): Promise<string | null> {
    const k = await this.ctx.storage.get<string>('feedKey');
    if (!k || key !== k || !this.sheetStore) return null;
    return buildCalendar(this.sheetStore, who, name, Date.now(), (id) => `${origin}/s/${encodeURIComponent(sheet)}?task=${encodeURIComponent(id)}`);
  }

  async shareKeys(): Promise<Share | null> {
    return (await this.ctx.storage.get<Share>('share')) ?? null;
  }

  /**
   * A sheet started without an account gets its keys from the device that
   * started it, on its first visit; anyone else then needs a link. Null when
   * it already has keys (someone else got there first).
   */
  async adopt(): Promise<Share | null> {
    if (await this.ctx.storage.get<Share>('share')) return null;
    const share = { edit: newToken(), view: newToken() };
    await this.ctx.storage.put<Share>('share', share);
    // Anyone connected without a key (from before sheets were private) is out.
    this.kick('Sharing links changed');
    return share;
  }

  /** The worker has already checked the caller may edit. */
  async setSharing(action: 'enable' | 'rotate' | 'disable'): Promise<Share | null> {
    if (action === 'disable') {
      await this.ctx.storage.delete('share');
      return null;
    }
    const share = { edit: newToken(), view: newToken() };
    await this.ctx.storage.put<Share>('share', share);
    // Old calendar links stop working along with the old share links.
    if (action === 'rotate') await this.ctx.storage.delete('feedKey');
    // Everyone reconnects and is checked against the new links.
    this.kick('Sharing links changed');
    return share;
  }

  /**
   * Rebuild the live plan: tasks that finished a while ago go to the archive,
   * and the plan is saved again without what it no longer needs (deleted
   * rows, cells at their default value, old activity; see lib/rebuild.ts).
   * Everyone is disconnected; their devices drop their copy (a new epoch)
   * and download the lean one. The object then restarts, freeing the old
   * copy. Unless forced, only when it makes a real difference.
   */
  async rebuild(force = false, dry = false): Promise<string> {
    const store = this.sheetStore;
    const sheet = this.ctx.storage.kv.get<string>('sheet');
    if (!store || !sheet) return 'nothing to rebuild';
    const sql = this.ctx.storage.sql;
    // As JSON: TinyBase's objects have no prototype (and this is a copy).
    const { tables, bundles, dropped } = rebuildTables(JSON.parse(JSON.stringify(store.getTables())), today(), Date.now());
    const stored = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tinybase_tables').one().n;
    // Stored rows: a row per table row, plus one per cell changed since
    // (and the rows of deleted things). Needed: the lean plan's rows.
    let rows = 0;
    for (const table of Object.values(tables)) rows += Object.keys(table).length;
    const worth = bundles.length >= 200 || dropped.activity >= 1000 || dropped.orphans >= 500 || stored > rows * 1.5 + 2000;
    if (dry || (!force && !worth)) return `${dry ? 'dry run' : 'not needed'}: ${stored} stored rows, ${rows} needed, ${bundles.length} to archive`;
    // The archive first: if this stops halfway, the plan still has them.
    const archive = archiveOf(this.env as Env, sheet);
    for (let i = 0; i < bundles.length; i += 300) await archive.put(JSON.stringify(bundles.slice(i, i + 300)));
    // Threads that are live (restored from the archive since): not archived twice.
    const live = new Set(Object.entries(tables.tasks ?? {}).map(([id, t]) => (t.group as string) || id));
    if (live.size) await archive.forget([...live]);
    // From here on nothing waits on anything else, so no message comes in
    // between: a new epoch turns every reconnecting device away until it
    // has dropped its copy, then the lean plan replaces the stored one.
    this.ctx.storage.kv.put('epoch', (this.ctx.storage.kv.get<number>('epoch') ?? 0) + 1);
    this.ctx.storage.kv.put('rebuilt', Date.now());
    await this.sheetPersister?.stopAutoSave();
    this.kick('Plan rebuilt');
    const lean = createMergeableStore();
    lean.transaction(() => {
      lean.setTables(tables as Parameters<typeof lean.setTables>[0]);
      lean.setValues(JSON.parse(JSON.stringify(store.getValues())));
    });
    // Written beside the stored plan first, then swapped in one transaction:
    // stopping halfway (memory, a deploy) leaves the old plan as it was.
    sql.exec('DROP TABLE IF EXISTS rebuild_tinybase_tables');
    sql.exec('DROP TABLE IF EXISTS rebuild_tinybase_values');
    await createDurableObjectSqlStoragePersister(lean, sql, { mode: 'fragmented', storagePrefix: 'rebuild_' }).save();
    this.ctx.storage.transactionSync(() => {
      sql.exec('DELETE FROM tinybase_tables');
      sql.exec('INSERT INTO tinybase_tables SELECT * FROM rebuild_tinybase_tables');
      sql.exec('DELETE FROM tinybase_values');
      sql.exec('INSERT INTO tinybase_values SELECT * FROM rebuild_tinybase_values');
      sql.exec('DROP TABLE rebuild_tinybase_tables');
      sql.exec('DROP TABLE rebuild_tinybase_values');
    });
    const after = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tinybase_tables').one().n;
    // Start over from the lean copy (the old one goes with this instance).
    setTimeout(() => this.ctx.abort('Rebuilt'), 50);
    const msg = `rebuilt: ${stored} → ${after} stored rows, ${bundles.length} threads archived, ${dropped.orphans} orphans and ${dropped.activity} old activity dropped`;
    console.log(sheet, msg);
    return msg;
  }

  /**
   * Daily: rebuild when it's worth it. Only while nobody is connected (they
   * would have to reload), unless the plan is so big it can't wait. A plan
   * nobody has touched since its last rebuild isn't woken again (each wake
   * loads the whole plan): the next connection sets the alarm again.
   */
  override async alarm() {
    const busy = this.ctx.getWebSockets().length > 0;
    const big = (this.sheetStore?.getRowCount('tasks') ?? 0) > BIG_PLAN_TASKS;
    const due = Date.now() - (this.ctx.storage.kv.get<number>('rebuilt') ?? 0) > DAY_MS;
    if (due && (!busy || big)) {
      // Checked (or done): not again today.
      this.ctx.storage.kv.put('rebuilt', Date.now());
      const r = await this.rebuild().catch((e) => `failed: ${e instanceof Error ? e.message : e}`);
      if (!r.startsWith('rebuilt')) console.log(this.ctx.storage.kv.get('sheet'), 'rebuild', r);
      if (r.startsWith('rebuilt')) return; // restarting; the next connection sets the alarm again
    }
    const changed = this.ctx.storage.kv.get<number>('changed') ?? Date.now();
    const rebuilt = this.ctx.storage.kv.get<number>('rebuilt') ?? 0;
    if (!due || busy || changed > rebuilt) await this.ctx.storage.setAlarm(Date.now() + (due && busy ? HOUR_MS : DAY_MS));
  }

  /**
   * Attachment files whose attachment was removed: at most weekly, when
   * someone connects. Only files over a week old, so a just-uploaded file
   * whose row hasn't arrived yet (or an undo soon after) is safe.
   */
  async #collectFiles(sheet: string) {
    const files = (this.env as Env).FILES;
    if (!files || !this.sheetStore) return;
    if (Date.now() - ((await this.ctx.storage.get<number>('filesCollected')) ?? 0) < WEEK_MS) return;
    await this.ctx.storage.put('filesCollected', Date.now());
    // Files on archived tasks are still in use.
    const live = new Set([...this.sheetStore.getRowIds('attachments'), ...(await archiveOf(this.env as Env, sheet).fileIds())]);
    const prefix = `${sheet}/`;
    for (let cursor: string | undefined; ; ) {
      const page = await files.list({ prefix, cursor });
      const stale = page.objects.filter((o) => !live.has(o.key.slice(prefix.length)) && o.uploaded.getTime() < Date.now() - WEEK_MS);
      if (stale.length) await files.delete(stale.map((o) => o.key));
      if (!page.truncated) break;
      cursor = page.cursor;
    }
  }

  /**
   * Tell the directory who is planned on this sheet (it counts people per
   * workspace for plans): once someone connects, then on every change to
   * the people, a few seconds later. With limits on, people added past the
   * plan's limit are taken out again (and their tasks): the app doesn't let
   * that happen, so it's an old or altered client. People who were already
   * here are never removed, even when a plan shrinks.
   */
  #reporting = false;
  #watchPeople(sheet: string) {
    const store = this.sheetStore;
    if (this.#reporting || !store) return;
    this.#reporting = true;
    const env = this.env as Env;
    const known = new Set(store.getRowIds('users'));
    const keyOf = (id: string) => personKey(sheet, id, store.getRow('users', id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checking: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const keys = store.getRowIds('users').map(keyOf);
      this.ctx.waitUntil(directory(env).setSheetPeople(sheet, keys).catch((e) => console.error('report people', e)));
    };
    const check = async () => {
      const added = store.getRowIds('users').filter((id) => !known.has(id));
      if (!added.length) return;
      const { limit, elsewhere } = await directory(env).peopleRoom(sheet);
      const ids = store.getRowIds('users');
      const counted = new Set([...elsewhere, ...ids.map(keyOf)]);
      // Newest first; taking out a row only frees room if nobody else has its key.
      const out: string[] = [];
      for (const id of [...added].reverse()) {
        if (counted.size <= limit) break;
        const key = keyOf(id);
        out.push(id);
        if (!elsewhere.includes(key) && !ids.some((other) => other !== id && !out.includes(other) && keyOf(other) === key)) counted.delete(key);
      }
      for (const id of added) if (!out.includes(id)) known.add(id);
      if (!out.length) return;
      console.log('over the plan: removing people', sheet, out.length);
      const gone = new Set(out);
      const tasks = store.getRowIds('tasks').filter((t) => gone.has(store.getCell('tasks', t, 'userId') as string));
      const taskSet = new Set(tasks);
      store.transaction(() => {
        for (const a of store.getRowIds('attachments')) if (taskSet.has(store.getCell('attachments', a, 'taskId') as string)) store.delRow('attachments', a);
        for (const t of tasks) store.delRow('tasks', t);
        for (const id of out) store.delRow('users', id);
      });
    };
    store.addTableListener('users', () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(report, 3000);
      if (env.PLAN_LIMITS !== 'on') return;
      if (checking !== undefined) clearTimeout(checking);
      checking = setTimeout(() => this.ctx.waitUntil(check().catch((e) => console.error('check people', e))), 1000);
    });
    report();
  }

  override async fetch(request: Request) {
    const sheet = /^\/sync\/([^/]+)/.exec(new URL(request.url).pathname)?.[1];
    if (sheet) this.ctx.waitUntil(this.#collectFiles(decodeURIComponent(sheet)).catch((e) => console.error('collect files', e)));
    if (sheet) {
      // Remembered so the watch restarts when a message wakes the object
      // from hibernation (no fetch then).
      if (this.ctx.storage.kv.get('sheet') !== decodeURIComponent(sheet)) this.ctx.storage.kv.put('sheet', decodeURIComponent(sheet));
      this.#watchPeople(decodeURIComponent(sheet));
    }
    // A device holding a copy from before the last rebuild drops it and
    // starts over: syncing it would bring back everything the rebuild left out.
    const epoch = this.ctx.storage.kv.get<number>('epoch') ?? 0;
    if (sheet && Number(new URL(request.url).searchParams.get('e') ?? 0) !== epoch) {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      server.close(4002, `epoch:${epoch}`);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (sheet && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
    const role = request.headers.get('x-prepweek-role');
    const response = await super.fetch!(request);
    // Mark view-only sockets; the mark lives on the socket (survives hibernation).
    const id = request.headers.get('sec-websocket-key');
    if (role === 'view' && id) for (const ws of this.ctx.getWebSockets(id)) ws.serializeAttachment({ view: true });
    return response;
  }

  override webSocketMessage(client: WebSocket, message: string | ArrayBuffer) {
    if (!this.#reporting) {
      const sheet = this.ctx.storage.kv.get<string>('sheet');
      if (sheet) this.#watchPeople(sheet);
    }
    if ((client.deserializeAttachment() as { view?: boolean } | null)?.view) {
      // Payload: "<toClientId>\n[requestId, messageType, body]". Fragments
      // (large messages) and anything that carries content are dropped.
      const raw = message.toString();
      const body = raw.slice(raw.indexOf('\n') + 1);
      if (!body.startsWith('[')) return;
      try {
        if (!READ_MESSAGES.has(JSON.parse(body)[1])) return;
      } catch {
        return;
      }
    }
    return super.webSocketMessage!(client, message);
  }
}

/**
 * Live presence for one sheet: who is here, where they look, what they have
 * selected. Pure relay, nothing is stored: each socket's latest state rides
 * on the socket itself (survives hibernation) so newcomers get a snapshot.
 */
export class PresenceDurableObject extends DurableObject {
  kick() {
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'Access changed');
  }

  override async fetch(request: Request) {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    // Snapshot of everyone already here.
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment();
      if (ws !== server && state) server.send(JSON.stringify(state));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > 4096) return;
    let msg: { t?: string; id?: string };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof msg.id !== 'string') return;
    if (msg.t === 'bye') ws.serializeAttachment(null);
    else ws.serializeAttachment(msg);
    for (const other of this.ctx.getWebSockets()) if (other !== ws) other.send(message);
  }

  override async webSocketClose(ws: WebSocket) {
    this.leave(ws);
  }
  override async webSocketError(ws: WebSocket) {
    this.leave(ws);
  }
  private leave(ws: WebSocket) {
    const state = ws.deserializeAttachment() as { id?: string } | null;
    if (!state?.id) return;
    const bye = JSON.stringify({ t: 'bye', id: state.id });
    for (const other of this.ctx.getWebSockets()) if (other !== ws) other.send(bye);
  }
}

/** The sheet's Durable Object (TinyBase names it after the sync path). */
const sheetStub = (env: Env, sheet: string) => env.SHEETS.get(env.SHEETS.idFromName(`sync/${sheet}`));
const forbidden = () => new Response('This sheet needs a share link', { status: 403 });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * The caller's role on a sheet. A sheet in a workspace is open to its
 * members; anyone else needs a private link. A sheet not (yet) in a
 * workspace, one started without an account, needs a link too: its keys go
 * to the device that started it (`adopt`, asked for with `own` on its first
 * visit), so its address alone opens nothing.
 */
const sheetAccess = async (request: Request, env: Env, sheet: string, key: string, needKeys: boolean, own = false) => {
  const user = await sessionUser(request, env);
  const info = await directory(env).sheet(sheet, user?.id ?? null, env.PLAN_LIMITS === 'on');
  // Asking the sheet's object wakes it, and starting loads every row of the
  // sheet (billed as rows read). A member's access doesn't depend on links.
  const member = !info.deleted && !!info.workspace && !!info.role;
  const byKey = member && !needKeys ? 'open' : await sheetStub(env, sheet).keyRole(key);
  let role: Role;
  if (info.deleted) role = 'none';
  else if (info.workspace) role = info.role ? 'edit' : byKey === 'open' ? 'none' : byKey;
  else if (byKey !== 'open') role = byKey;
  else if (own && (await sheetStub(env, sheet).adopt())) {
    await env.PRESENCE.get(env.PRESENCE.idFromName(sheet)).kick();
    return { role: 'edit' as Role, user, info, isPrivate: true };
  } else role = 'none';
  return { role, user, info, isPrivate: byKey !== 'open' };
};

export default {
  async fetch(request: Request, env: Env) {
    const t0 = Date.now();
    const route = routeOf(new URL(request.url).pathname);
    let res: Response;
    try {
      res = await handle(request, env);
    } catch (e) {
      // Without this a failure is only Cloudflare's opaque 1101 page.
      console.error(e);
      track(env, 'error', ['worker', (e instanceof Error ? e.message : String(e)).slice(0, 200), route]);
      res = new Response(`Server error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
    }
    // Every request the worker handles (static files never reach it): for
    // request counts, error rates and timings on the admin dashboard.
    if (route !== '/api/stats') track(env, 'req', [route, request.method, `${Math.floor(res.status / 100)}xx`], [1, res.status, Date.now() - t0]);
    return res;
  },
  // Hourly (wrangler.toml): the daily digests whose morning it is.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendDigests(env));
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // A deploy that didn't come from wrangler.toml (e.g. edited in the dashboard).
  if (!env.DIRECTORY || !env.SHEETS || !env.PRESENCE) {
    if (!/^\/(sync|files|presence|share|archive|auth|api)\//.test(url.pathname)) return env.ASSETS.fetch(request);
    return new Response('Server misconfigured: the Durable Object bindings (SHEETS, PRESENCE, DIRECTORY) are missing. Deploy with wrangler.toml.', { status: 500 });
  }
  if (url.pathname === '/auth/appsumo/callback') return appsumoCallback(request, env, url);
  if (url.pathname === '/api/appsumo/webhook') return appsumoWebhook(request, env);
  if (url.pathname.startsWith('/api/appsumo/')) return appsumoApi(request, env, url, url.pathname.split('/').slice(2));
  if (url.pathname.startsWith('/api/billing/')) return billingApi(request, env, url, url.pathname.split('/').slice(2));
  if (url.pathname.startsWith('/auth/')) return handleAuth(request, env, url);
  if (url.pathname === '/api/stats') return statsApi(request, env, url);
  if (url.pathname.startsWith('/api/admin/')) return adminApi(request, env, url);
  if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
  const ical = /^\/ical\/([^/]+)\/([^/]+)\.ics$/.exec(url.pathname);
  if (ical) {
    const sheet = decodeURIComponent(ical[1]!);
    const info = await directory(env).sheet(sheet, null);
    if (info.deleted) return new Response('Not found', { status: 404 });
    const body = await sheetStub(env, sheet).calendar(url.searchParams.get('f') ?? '', decodeURIComponent(ical[2]!), info.name, url.origin, sheet);
    if (body === null) return new Response('This calendar link has expired', { status: 404 });
    return new Response(body, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300', 'content-disposition': 'inline; filename="prepweek.ics"' } });
  }
  const route = /^\/(sync|files|presence|share|archive)\/([^/]+)/.exec(url.pathname);
  if (!route) return env.ASSETS.fetch(request);
  const kind = route[1]!;
  const sheet = decodeURIComponent(route[2]!);
  const key = url.searchParams.get('k') ?? '';
  const stub = sheetStub(env, sheet);
  // Only the access check (GET /share) may adopt a new sheet.
  const own = kind === 'share' && request.method === 'GET' && url.searchParams.get('own') === '1';
  const { role, user, info, isPrivate } = await sheetAccess(request, env, sheet, key, kind === 'share', own);

  if (kind === 'share') {
    if (request.method === 'GET') {
      const keys = role === 'edit' && isPrivate ? await stub.shareKeys() : null;
      // Locked out: nothing about the sheet or its workspace.
      if (role === 'none') return json({ role, private: isPrivate, signedIn: !!user, deleted: info.deleted });
      return json({ role, private: isPrivate, ...keys, name: info.name, workspace: info.workspace, signedIn: !!user, deleted: info.deleted, plan: 'plan' in info ? info.plan : null, limitsOn: env.PLAN_LIMITS === 'on' });
    }
    if (request.method === 'POST') {
      if (role === 'none') return forbidden();
      if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return forbidden();
      // Anyone who may see the sheet may subscribe to it in their calendar.
      if (url.searchParams.has('feed')) return json({ feed: await stub.feedKey() });
      if (role !== 'edit') return forbidden();
      // Rebuild now (normally daily, when worth it; see SheetDurableObject.rebuild).
      if (url.searchParams.has('rebuild')) return json({ result: await stub.rebuild(true, url.searchParams.get('rebuild') === 'dry') });
      const { action } = (await request.json().catch(() => ({}))) as { action?: string };
      if (action !== 'enable' && action !== 'rotate' && action !== 'disable') return json({ error: 'Unknown action' }, 400);
      // Without a workspace, the links are the only lock: they can't go.
      if (action === 'disable' && !info.workspace) return json({ error: 'Save this plan to a workspace first' }, 400);
      const keys = await stub.setSharing(action);
      if (action !== 'enable') await env.PRESENCE.get(env.PRESENCE.idFromName(sheet)).kick();
      return json({ role, private: !!keys, ...keys, name: info.name, workspace: info.workspace, signedIn: !!user });
    }
    return new Response('Method not allowed', { status: 405 });
  }

  if (role === 'none') return forbidden();
  if (kind === 'archive') {
    const archive = archiveOf(env, sheet);
    const text = (body: string) => new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    if (url.searchParams.has('summary')) return text(await archive.summary());
    if (url.searchParams.has('meta')) return json(await archive.meta());
    if (url.searchParams.has('page')) return text(await archive.page(url.searchParams.get('page') ?? ''));
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    if (!Number.isFinite(from) || !Number.isFinite(to)) return json({ error: 'from and to are days' }, 400);
    return text(await archive.range(from, to));
  }
  if (kind === 'sync') {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Upgrade required', { status: 426 });
    // The role is decided here, never by the client.
    const headers = new Headers(request.headers);
    headers.set('x-prepweek-role', role);
    return stub.fetch(new Request(request, { headers }));
  }
  if (kind === 'files') {
    if (request.method !== 'GET' && role !== 'edit') return forbidden();
    return files(request, env, url);
  }
  // Presence: viewers are present too.
  return env.PRESENCE.get(env.PRESENCE.idFromName(sheet)).fetch(request);
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** All of a plan's files together (src/data/files.ts says so before uploading). */
const SHEET_FILES_BYTES = 1024 ** 3;

/** Bytes stored under a plan's prefix (the app checks first; this is the backstop). */
const storedBytes = async (bucket: R2Bucket, prefix: string) => {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) total += o.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
};

/**
 * Attachment bytes: PUT/GET /files/<sheet>/<id>, stored in R2 under
 * <sheet>/<id>. Optional: without an R2 binding named FILES this returns 501
 * and the app keeps attachments in each browser only.
 */
async function files(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.FILES) return new Response('File storage is not configured', { status: 501 });
  const m = /^\/files\/([^/]+)\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (!m) return new Response('Not found', { status: 404 });
  const key = `${decodeURIComponent(m[1]!)}/${m[2]}`;
  if (request.method === 'PUT') {
    const len = Number(request.headers.get('content-length') ?? 0);
    if (len > MAX_FILE_BYTES) return new Response('Too large', { status: 413 });
    if ((await storedBytes(env.FILES, `${decodeURIComponent(m[1]!)}/`)) + len > SHEET_FILES_BYTES)
      return new Response('This plan’s files are full', { status: 413 });
    await env.FILES.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' },
    });
    return new Response(null, { status: 204 });
  }
  if (request.method === 'GET') {
    const obj = await env.FILES.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers({ 'cache-control': 'private, max-age=31536000, immutable' });
    obj.writeHttpMetadata(headers);
    // The type is whatever the uploader said: never let a file run as a page
    // on this origin (an uploaded .html could call the API as the viewer).
    headers.set('content-disposition', 'attachment');
    headers.set('x-content-type-options', 'nosniff');
    headers.set('content-security-policy', "sandbox; default-src 'none'");
    return new Response(obj.body, { headers });
  }
  return new Response('Method not allowed', { status: 405 });
}
