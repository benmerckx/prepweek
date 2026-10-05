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
export const startSync = async (sheetId: string) => {
  const server =
    new URLSearchParams(location.search).get('sync') ?? localStorage.getItem('prepweek:sync');

  const persister = createIndexedDbPersister(store, `prepweek:${sheetId}`);
  await persister.load();
  // Demo data only for purely local sheets; a synced sheet gets its content
  // from the server (seeding both sides would merge two sets of people).
  if (!server && store.getRowCount('users') === 0) seed();
  await persister.startAutoSave();

  const tabs = createBroadcastChannelSynchronizer(store, `prepweek:${sheetId}`);
  await tabs.startSync();

  if (server) {
    setStatus('connecting');
    const ws = new ReconnectingWebSocket(`${server.replace(/\/$/, '')}/${encodeURIComponent(sheetId)}`);
    const remote = await createWsSynchronizer(store, ws as unknown as WebSocket);
    await remote.startSync();
    ws.addEventListener('open', () => {
      setStatus('online');
      remote.load().then(() => remote.save());
    });
    ws.addEventListener('close', () => setStatus('offline'));
    if (ws.readyState === ws.OPEN) setStatus('online');
  }
};
