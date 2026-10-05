// Attachment bytes. Metadata (name, size, type, task) lives in the synced
// TinyBase store; the bytes are kept out of the CRDT:
//
//  - always in this browser's IndexedDB, so attachments work offline and
//    open instantly;
//  - and, when the sheet syncs to the Cloudflare worker with an R2 bucket
//    bound as FILES, uploaded to /files/<sheet>/<id> so collaborators can
//    open them too. Without R2 the upload is skipped and files stay local.

import { getServerHttp, getSheet } from './sync.ts';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const DB = 'prepweek-files';
const STORE = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;
const db = () =>
  (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));

const tx = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

const remoteUrl = (id: string) => {
  const base = getServerHttp();
  return base ? `${base}/files/${encodeURIComponent(getSheet())}/${encodeURIComponent(id)}` : null;
};

/** Store locally, then upload in the background when a server is configured. */
export const saveFile = async (id: string, blob: Blob) => {
  await tx('readwrite', (s) => s.put(blob, id));
  const url = remoteUrl(id);
  if (url) {
    fetch(url, { method: 'PUT', body: blob, headers: { 'content-type': blob.type || 'application/octet-stream' } }).catch(() => {});
  }
};

/** Local copy first; otherwise fetch from the server and cache it. */
export const loadFile = async (id: string): Promise<Blob | null> => {
  const local = await tx<Blob | undefined>('readonly', (s) => s.get(id)).catch(() => undefined);
  if (local) return local;
  const url = remoteUrl(id);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    await tx('readwrite', (s) => s.put(blob, id)).catch(() => {});
    return blob;
  } catch {
    return null;
  }
};

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
