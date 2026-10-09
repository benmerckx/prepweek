// Incremental local persistence for a MergeableStore.
//
// TinyBase's IndexedDB persister rewrites the *whole* mergeable content
// (every cell plus its sync timestamp: ~1.5 MB for the demo sheet) on every
// change. On a phone that is 200+ ms of main-thread work per edit, which is
// what made a simple recolor feel slow.
//
// Here each transaction appends only its own mergeable changes (a few cells
// with their HLC stamps) to a log, batched into one IndexedDB write. When
// the browser is idle and the log has grown, it is folded into a snapshot.
// Loading = snapshot + replay the log; mergeable changes are idempotent and
// order-independent, so a crash between steps can't corrupt anything.

import type { MergeableStore } from 'tinybase';
import { createIndexedDbPersister } from 'tinybase/persisters/persister-indexed-db';

type Content = ReturnType<MergeableStore['getMergeableContent']>;
type Changes = Parameters<MergeableStore['applyMergeableChanges']>[0];

const SNAPSHOT = 'snapshot';
const LOG = 'log';
const COMPACT_AFTER = 200; // log entries
/** ...or this many rows changed: an import or a first sync from the server is
 *  a handful of huge entries, and replaying those on every open is slow. */
const COMPACT_AFTER_ROWS = 1500;
/** Rows touched by a batch of changes (a cheap measure of its size). */
const rowsIn = (ch: Changes): number => {
  let n = 0;
  const tables = (ch as unknown as [[Record<string, [Record<string, unknown>]>]])[0]?.[0];
  for (const t in tables) n += Object.keys(tables[t]?.[0] ?? {}).length;
  return n;
};
/** Writes go out on the next tick: entries are tiny, and this still merges
 *  synchronous bursts (e.g. a remote sync applying many transactions). */
const FLUSH_MS = 0;

const req = <T,>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

const open = (name: string) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(SNAPSHOT);
      r.result.createObjectStore(LOG, { autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/**
 * Opening waits behind a pending delete of the same database, and a delete
 * waits for every tab holding it to let go: a tab that never does would
 * leave this one on the boot screen for good. Past this, the sheet opens
 * without its local copy (from the server) instead.
 */
const OPEN_TIMEOUT = 4000;

const idle = (fn: () => void) =>
  'requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 1500);

export interface LocalDb {
  /** True when nothing was stored yet (new sheet on this device). */
  empty: boolean;
  /** Write pending changes now (e.g. before the page goes away). */
  flush(): Promise<void>;
  /** Fold the log into a snapshot when the browser is next idle. */
  compactSoon(): void;
}

/** No local copy this time: the sheet lives in memory (and on the server). */
const inMemory = (store: MergeableStore): LocalDb => ({
  empty: store.getRowCount('users') === 0 && store.getRowCount('tasks') === 0,
  flush: async () => {},
  compactSoon: () => {},
});

export const startLocalDb = async (store: MergeableStore, name: string, legacyName?: string): Promise<LocalDb> => {
  const opening = open(name);
  const db = await Promise.race([opening, new Promise<null>((r) => setTimeout(() => r(null), OPEN_TIMEOUT))]);
  if (!db) {
    console.warn('This sheet’s copy on this device is busy (another tab is letting go of it); opening it without');
    // If it does open later, don't hold it: that would block the next delete.
    void opening.then((late) => late.close()).catch(() => {});
    return inMemory(store);
  }
  // Another tab wants it gone (signing out, losing access) or upgraded: let
  // go, so that tab isn't stuck waiting. This tab keeps going in memory.
  let closed = false;
  db.onversionchange = () => {
    closed = true;
    db.close();
  };

  // --- Load: snapshot, then replay the log on top. ---
  let logCount = 0;
  let logRows = 0;
  let stored = false;
  {
    const tx = db.transaction([SNAPSHOT, LOG], 'readonly');
    const [snapshot, log] = await Promise.all([
      req(tx.objectStore(SNAPSHOT).get('content')) as Promise<Content | undefined>,
      req(tx.objectStore(LOG).getAll()) as Promise<Changes[]>,
    ]);
    logCount = log.length;
    stored = !!snapshot || log.length > 0;
    for (const ch of log) logRows += rowsIn(ch);
    store.transaction(() => {
      if (snapshot) store.setMergeableContent(snapshot);
      for (const ch of log) store.applyMergeableChanges(ch);
    });
  }

  // One-time migration from the previous full-content persister: only into a
  // database that has nothing yet (loading replaces the whole store, so doing
  // it again later would bring back old content), and only if the old one
  // exists (opening it would create it).
  let migrated = false;
  const hasLegacy = async () => !indexedDB.databases || (await indexedDB.databases()).some((d) => d.name === legacyName);
  if (!stored && legacyName && (await hasLegacy().catch(() => true))) {
    try {
      await createIndexedDbPersister(store, legacyName).load();
      migrated = store.getRowCount('tasks') > 0 || store.getRowCount('users') > 0;
    } catch {
      /* nothing to migrate */
    }
  }
  const empty = !migrated && store.getRowCount('users') === 0 && store.getRowCount('tasks') === 0;

  // --- Save: append each transaction's mergeable changes. ---
  let queue: Changes[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let compactScheduled = false;

  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (closed) queue = [];
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    const tx = db.transaction(LOG, 'readwrite');
    const os = tx.objectStore(LOG);
    for (const ch of batch) {
      os.add(ch);
      logRows += rowsIn(ch);
    }
    logCount += batch.length;
    // Commit now rather than when the transaction auto-closes, so a reload
    // or tab close right after an edit can't lose it.
    tx.commit?.();
    await done(tx);
    if (logCount > COMPACT_AFTER || logRows > COMPACT_AFTER_ROWS) scheduleCompact();
  };

  const compact = async () => {
    compactScheduled = false;
    await flush();
    if (closed) return;
    // Snapshot and log truncation in one transaction: either both or neither.
    const content = store.getMergeableContent();
    const tx = db.transaction([SNAPSHOT, LOG], 'readwrite');
    tx.objectStore(SNAPSHOT).put(content, 'content');
    tx.objectStore(LOG).clear();
    tx.commit?.();
    await done(tx);
    logCount = 0;
    logRows = 0;
  };

  function scheduleCompact() {
    if (compactScheduled) return;
    compactScheduled = true;
    idle(() => void compact().catch(() => (compactScheduled = false)));
  }

  store.addDidFinishTransactionListener(() => {
    const [tables, values] = store.getTransactionChanges();
    if (!Object.keys(tables).length && !Object.keys(values).length) return;
    queue.push(store.getTransactionMergeableChanges(false));
    timer ??= setTimeout(() => void flush(), FLUSH_MS);
  });

  // Don't lose the last quarter second when the tab is hidden or closed.
  const onHide = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  document.addEventListener('visibilitychange', onHide);
  addEventListener('pagehide', () => void flush());

  if (migrated || logCount > COMPACT_AFTER) scheduleCompact();

  // A sheet saved before size-based compaction (or synced in big batches):
  // fold its log now, so the next open is a single snapshot.
  if (logCount > COMPACT_AFTER || logRows > COMPACT_AFTER_ROWS) scheduleCompact();

  return { empty, flush, compactSoon: scheduleCompact };
};
