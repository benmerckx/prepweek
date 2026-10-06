import { startLocalDb } from './localdb.ts';
import { createBroadcastChannelSynchronizer } from 'tinybase/synchronizers/synchronizer-broadcast-channel';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import ReconnectingWebSocket from 'reconnecting-websocket';
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
  const server = syncUrl(served);
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

  const tabs = createBroadcastChannelSynchronizer(store, `prepweek:${sheetId}`);
  await tabs.startSync();

  // Never block first paint on the network: the local replica is already
  // usable, the server merges in when it answers.
  if (server)
    connect(server, sheetId).catch((e) => {
      // e.g. refused because the sheet is private and our link isn't valid.
      console.warn('Sync connection failed', e);
      setStatus('offline');
    });
};

/**
 * Sync messages are split into fragments of this size: a large sheet's
 * payload can be many MB, and Cloudflare drops WebSocket messages over 1 MiB
 * (the local dev server doesn't, so it only shows in production).
 */
const SYNC_FRAGMENT = 768 * 1024;
/** Seconds to wait for a reply (large payloads take a while). */
const SYNC_TIMEOUT = 30;

const connect = async (server: string, sheetId: string) => {
  setStatus('connecting');
  // A function, so a reconnect after the share links are reset uses the new key.
  const ws = new ReconnectingWebSocket(() => withKey(`${server.replace(/\/$/, '')}/${encodeURIComponent(sheetId)}`));
  ws.addEventListener('close', () => setStatus('offline'));
  const remote = await createWsSynchronizer(
    store,
    ws as unknown as WebSocket,
    SYNC_TIMEOUT,
    undefined,
    undefined,
    (e) => console.warn('Sync error', e),
    SYNC_FRAGMENT,
  );
  // Re-sync after every (re)connect so offline edits propagate.
  ws.addEventListener('open', () => {
    setStatus('online');
    remote.load().then(() => remote.save());
  });
  if (ws.readyState === ws.OPEN) setStatus('online');
  await remote.startSync();
};
