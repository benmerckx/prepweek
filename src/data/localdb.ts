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

export const startLocalDb = async (store: MergeableStore, name: string, legacyName?: string): Promise<LocalDb> => {
  const db = await open(name);

  // --- Load: snapshot, then replay the log on top. ---
  let logCount = 0;
  {
    const tx = db.transaction([SNAPSHOT, LOG], 'readonly');
    const [snapshot, log] = await Promise.all([
      req(tx.objectStore(SNAPSHOT).get('content')) as Promise<Content | undefined>,
      req(tx.objectStore(LOG).getAll()) as Promise<Changes[]>,
    ]);
    logCount = log.length;
    store.transaction(() => {
      if (snapshot) store.setMergeableContent(snapshot);
      for (const ch of log) store.applyMergeableChanges(ch);
    });
  }

  // One-time migration from the previous full-content persister.
  let migrated = false;
  if (store.getRowCount('users') === 0 && store.getRowCount('tasks') === 0 && legacyName) {
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
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    const tx = db.transaction(LOG, 'readwrite');
    const os = tx.objectStore(LOG);
    for (const ch of batch) os.add(ch);
    logCount += batch.length;
    // Commit now rather than when the transaction auto-closes, so a reload
    // or tab close right after an edit can't lose it.
    tx.commit?.();
    await done(tx);
    if (logCount > COMPACT_AFTER) scheduleCompact();
  };

  const compact = async () => {
    compactScheduled = false;
    await flush();
    // Snapshot and log truncation in one transaction: either both or neither.
    const content = store.getMergeableContent();
    const tx = db.transaction([SNAPSHOT, LOG], 'readwrite');
    tx.objectStore(SNAPSHOT).put(content, 'content');
    tx.objectStore(LOG).clear();
    tx.commit?.();
    await done(tx);
    logCount = 0;
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

  return { empty, flush, compactSoon: scheduleCompact };
};
