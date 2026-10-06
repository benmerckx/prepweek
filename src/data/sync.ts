import { startLocalDb } from './localdb.ts';
import { createBroadcastChannelSynchronizer } from 'tinybase/synchronizers/synchronizer-broadcast-channel';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { store } from './store.ts';
import { seed } from './seed.ts';
import { withKey } from './access.ts';

export type SyncStatus = 'local' | 'connecting' | 'online' | 'offline';

let status: SyncStatus = 'local';
const listeners = new Set<() => void>();
const setStatus = (s: SyncStatus) => {
  status = s;
  listeners.forEach((l) => l());
};
export const getSyncStatus = () => status;
/**
 * The sheet's content is all here: loaded from this device, and from the
 * server too when it has one and answered (or failed to). Until then, an
 * empty sheet may just be one that hasn't arrived yet.
 */
let settled = false;
export const isSynced = () => settled;
const settle = () => {
  if (settled) return;
  settled = true;
  listeners.forEach((l) => l());
};
export const onSyncStatus = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/**
 * Where to sync, in order:
 *  - `?sync=wss://host/sync` (remembered), `?sync=off` to forget it;
 *  - same origin `/sync` when the app is served by the worker (on localhost: once its API answered);
 *  - otherwise local-only (IndexedDB + other tabs).
 */
const syncUrl = (served: boolean): string | null => {
  const KEY = 'prepweek:sync';
  const param = new URLSearchParams(location.search).get('sync');
  try {
    if (param === 'off') localStorage.removeItem(KEY);
    else if (param) localStorage.setItem(KEY, param);
  } catch {}
  if (param === 'off') return null;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {}
  if (param || stored) return param ?? stored;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return local && !served ? null : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/sync`;
};

/**
 * Storage + realtime for one sheet:
 *
 *  1. IndexedDB: local-first, the sheet opens instantly and works offline.
 *  2. BroadcastChannel: other tabs on this machine see edits in realtime.
 *  3. WebSocket (optional): a Cloudflare Durable Object per sheet, see
 *     /worker. Enabled with `?sync=wss://your-worker.workers.dev`.
 *
 * All three speak TinyBase's MergeableStore protocol, so they compose: the
 * server is just another replica.
 */
let currentSheet = 'demo';
let serverHttp: string | null = null;
/** The sheet this page shows, and the HTTP origin of its sync server (if any). */
export const getSheet = () => currentSheet;
export const getServerHttp = () => serverHttp;

/** `served`: the app is known to be served by the worker (its API answered). */
export const startSync = async (sheetId: string, served = false) => {
  // The demo is everyone's own: local only, so it always starts with the
  // sample data and one visitor's edits never show up for the next.
  const server = sheetId === 'demo' ? null : syncUrl(served);
  currentSheet = sheetId;
  // wss://host/sync → https://host (files are served next to the sync route).
  serverHttp = server ? server.replace(/^ws/, 'http').replace(/\/sync\/?$/, '') : null;

  // Incremental IndexedDB persistence (see localdb.ts); migrates sheets
  // saved by the previous full-content persister.
  const local = await startLocalDb(store, `prepweek2:${sheetId}`, `prepweek:${sheetId}`);
  // Demo data only for purely local sheets; a synced sheet gets its content
  // from the server (seeding both sides would merge two sets of people).
  if (!server && local.empty && sheetId === 'demo') {
    seed();
    local.compactSoon();
  }

  // Other tabs: directly when there's no server. With one, each tab has its
  // own connection, and changes heard from a tab would go up again from here.
  if (!server) await createBroadcastChannelSynchronizer(store, `prepweek:${sheetId}`).startSync();

  // Never block first paint on the network: the local replica is already
  // usable, the server merges in when it answers.
  // A sheet this device already has is usable as is. Otherwise wait for the
  // server, but not forever (offline, the connection never opens).
  if (!server || !local.empty) settle();
  else setTimeout(settle, 5000);
  if (server)
    connect(server, sheetId)
      .catch((e) => {
        // e.g. refused because the sheet is private and our link isn't valid.
        console.warn('Sync connection failed', e);
        setStatus('offline');
      })
      .finally(settle);
};

/**
 * Sync messages are split into fragments of this size: a large sheet's
 * payload can be many MB, and Cloudflare drops WebSocket messages over 1 MiB
 * (the local dev server doesn't, so it only shows in production).
 */
const SYNC_FRAGMENT = 768 * 1024;
/** Seconds to wait for a reply (large payloads take a while). */
const SYNC_TIMEOUT = 30;

/**
 * Connects, and reconnects after every drop, with a fresh synchronizer each
 * time: TinyBase's stops listening to its socket once that closes, so behind
 * a reconnecting socket it went on sending edits but never received again.
 * A new connection starts with a full (hash-based) sync, which also covers
 * edits made offline. Resolves once the first attempt connected or failed.
 */
const connect = (server: string, sheetId: string) =>
  new Promise<void>((resolveFirst) => {
    let delay = 1000;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = async () => {
      clearTimeout(retry);
      retry = undefined;
      // A function call, so a reconnect after the share links are reset uses the new key.
      const ws = new WebSocket(withKey(`${server.replace(/\/$/, '')}/${encodeURIComponent(sheetId)}`));
      let remote: Awaited<ReturnType<typeof createWsSynchronizer>> | undefined;
      ws.addEventListener('close', () => {
        void remote?.destroy();
        remote = undefined;
        setStatus('offline');
        resolveFirst();
        if (retry) return;
        retry = setTimeout(open, delay);
        delay = Math.min(delay * 2, 30_000);
      });
      try {
        remote = await createWsSynchronizer(store, ws, SYNC_TIMEOUT, undefined, undefined, (e) => console.warn('Sync error', e), SYNC_FRAGMENT);
        await remote.startSync();
        if (ws.readyState === WebSocket.OPEN) {
          delay = 1000;
          setStatus('online');
        }
      } catch (e) {
        // e.g. refused because the sheet is private and our link isn't valid.
        console.warn('Sync connection failed', e);
        ws.close();
      }
      resolveFirst();
    };
    setStatus('connecting');
    void open();
    // Back online: don't wait out the backoff.
    addEventListener('online', () => retry && open());
  });
