import { startLocalDb } from './localdb.ts';
import { createBroadcastChannelSynchronizer } from 'tinybase/synchronizers/synchronizer-broadcast-channel';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { store } from './store.ts';
import { seed } from './seed.ts';
import { accessReady, getAccess, onAccess, withKey } from './access.ts';
import { forgetLocalCopy } from './claimed.ts';

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
    connect(server, sheetId, local.empty)
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
const epochKey = (sheet: string) => `prepweek:epoch:${sheet}`;
/** Which rebuild of the plan this device's copy comes from (0: none yet). */
const getEpoch = (sheet: string) => {
  try {
    return Number(localStorage.getItem(epochKey(sheet)) ?? 0) || 0;
  } catch {
    return 0;
  }
};
const setEpoch = (sheet: string, epoch: number) => {
  try {
    localStorage.setItem(epochKey(sheet), String(epoch));
  } catch {}
};
const startOver = (sheet: string, epoch: number) => {
  try {
    // Never loop: one start-over a minute at most.
    const last = Number(sessionStorage.getItem('prepweek:startedOver') ?? 0);
    if (Date.now() - last < 60_000) return console.warn('Plan was rebuilt again; not reloading twice in a minute');
    sessionStorage.setItem('prepweek:startedOver', String(Date.now()));
  } catch {}
  setEpoch(sheet, epoch);
  forgetLocalCopy(sheet);
  location.reload();
};

/** Without a connection this long (and the browser online), say "Offline". */
const OFFLINE_AFTER = 20_000;
/** TinyBase reports a closed socket as an error ("tinybase:5"): that's a reconnect, not news. */
const quietErrors = (e: unknown) => {
  // A socket's own error event says nothing more (the close that follows is handled).
  if (e instanceof Event || (e instanceof Error && /^tinybase:5\b/.test(e.message))) return;
  console.warn('Sync error', e);
};

/**
 * Connects, and reconnects after every drop, with a fresh synchronizer each
 * time: TinyBase's stops listening to its socket once that closes, so behind
 * a reconnecting socket it went on sending edits but never received again.
 * A new connection starts with a full (hash-based) sync, which also covers
 * edits made offline. Resolves once the first attempt connected or failed.
 */
const connect = (server: string, sheetId: string, fresh: boolean) =>
  new Promise<void>((resolveFirst) => {
    let delay = 1000;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Connections drop now and then (deploys, laptops sleep): reconnecting
    // quietly is not being offline. "Offline" is the browser saying so, or
    // no connection for OFFLINE_AFTER.
    let waiting: (() => void) | null = null;
    // Not ours to open (the lock screen says so): don't knock until that
    // changes (signing in, a link, joining the workspace).
    const locked = () => {
      if (getAccess()?.role !== 'none') return false;
      setStatus('local');
      waiting ??= onAccess(() => {
        if (getAccess()?.role === 'none') return;
        waiting?.();
        waiting = null;
        void open();
      });
      return true;
    };
    let downSince = 0;
    let offlineTimer: ReturnType<typeof setTimeout> | undefined;
    const open = async () => {
      clearTimeout(retry);
      retry = undefined;
      await accessReady(server.replace(/^ws/, 'http').replace(/\/sync\/?$/, ''));
      if (locked()) return resolveFirst();
      // A function call, so a reconnect after the share links are reset uses the new key.
      const url = withKey(`${server.replace(/\/$/, '')}/${encodeURIComponent(sheetId)}`);
      const ws = new WebSocket(`${url}${url.includes('?') ? '&' : '?'}e=${getEpoch(sheetId)}`);
      // Keepalive: a socket with nothing to say gets closed along the way
      // (proxies, the edge). The server answers "ping" itself; the "pong"
      // stops here, before TinyBase's own listener (added after this one).
      ws.addEventListener('message', (e) => e.data === 'pong' && e.stopImmediatePropagation());
      const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 30_000);
      let remote: Awaited<ReturnType<typeof createWsSynchronizer>> | undefined;
      ws.addEventListener('close', (ev) => {
        clearInterval(ping);
        // The plan was rebuilt on the server (see worker rebuild): this copy
        // is from before, and syncing it would bring back what the rebuild
        // left out. Drop it and start over from the server's.
        if (ev.code === 4002) {
          const epoch = Number(/epoch:(\d+)/.exec(ev.reason)?.[1] ?? 0);
          // Nothing here from before (a new device): just take the new epoch.
          if (fresh) {
            setEpoch(sheetId, epoch);
            fresh = false;
            return void open();
          }
          return startOver(sheetId, epoch);
        }
        void remote?.destroy();
        remote = undefined;
        // Reconnecting quietly is not being offline: say so only when the
        // browser is, or after a while without a connection.
        if (!downSince) downSince = Date.now();
        setStatus(navigator.onLine ? 'connecting' : 'offline');
        clearTimeout(offlineTimer);
        offlineTimer = setTimeout(() => downSince && setStatus('offline'), Math.max(0, OFFLINE_AFTER - (Date.now() - downSince)));
        resolveFirst();
        if (retry || waiting || locked()) return;
        retry = setTimeout(open, delay);
        delay = Math.min(delay * 2, 30_000);
      });
      try {
        remote = await createWsSynchronizer(store, ws, SYNC_TIMEOUT, undefined, undefined, quietErrors, SYNC_FRAGMENT);
        await remote.startSync();
        if (ws.readyState === WebSocket.OPEN) {
          delay = 1000;
          downSince = 0;
          // From here on this copy has the plan in it.
          fresh = false;
          clearTimeout(offlineTimer);
          setStatus('online');
        }
      } catch (e) {
        // e.g. refused because the sheet is private and our link isn't valid.
        quietErrors(e);
        ws.close();
      }
      resolveFirst();
    };
    setStatus('connecting');
    void open();
    // Back online, or back to this window: don't wait out the backoff.
    const now = () => {
      if (!retry) return;
      delay = 1000;
      void open();
    };
    addEventListener('online', now);
    addEventListener('focus', now);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && now());
  });
