import { createIndexedDbPersister } from 'tinybase/persisters/persister-indexed-db';
import { createBroadcastChannelSynchronizer } from 'tinybase/synchronizers/synchronizer-broadcast-channel';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { store } from './store.ts';
import { seed } from './seed.ts';

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
 *  - same origin `/sync` when the app is served by the worker (not localhost);
 *  - otherwise local-only (IndexedDB + other tabs).
 */
const syncUrl = (): string | null => {
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
  return local ? null : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/sync`;
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

export const startSync = async (sheetId: string) => {
  const server = syncUrl();
  currentSheet = sheetId;
  // wss://host/sync → https://host (files are served next to the sync route).
  serverHttp = server ? server.replace(/^ws/, 'http').replace(/\/sync\/?$/, '') : null;

  const persister = createIndexedDbPersister(store, `prepweek:${sheetId}`);
  await persister.load();
  // Demo data only for purely local sheets; a synced sheet gets its content
  // from the server (seeding both sides would merge two sets of people).
  if (!server && store.getRowCount('users') === 0) seed();
  await persister.startAutoSave();

  const tabs = createBroadcastChannelSynchronizer(store, `prepweek:${sheetId}`);
  await tabs.startSync();

  // Never block first paint on the network: the local replica is already
  // usable, the server merges in when it answers.
  if (server) void connect(server, sheetId);
};

const connect = async (server: string, sheetId: string) => {
  setStatus('connecting');
  const ws = new ReconnectingWebSocket(`${server.replace(/\/$/, '')}/${encodeURIComponent(sheetId)}`);
  ws.addEventListener('close', () => setStatus('offline'));
  const remote = await createWsSynchronizer(store, ws as unknown as WebSocket);
  // Re-sync after every (re)connect so offline edits propagate.
  ws.addEventListener('open', () => {
    setStatus('online');
    remote.load().then(() => remote.save());
  });
  if (ws.readyState === ws.OPEN) setStatus('online');
  await remote.startSync();
};
