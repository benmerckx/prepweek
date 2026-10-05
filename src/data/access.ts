// Who may do what on this sheet, as decided by the server (worker/index.ts).
//
// A sheet with private links needs a key in the URL (`?k=…`). The key is
// remembered per sheet and stripped from the address bar, so it isn't left
// in screenshots or copied around by accident; the Share dialog hands out
// fresh links.

import { setReadOnly } from './store.ts';

export type Role = 'edit' | 'view' | 'none';
export interface ShareInfo {
  role: Role;
  private: boolean;
  /** Keys, only for editors of a private sheet. */
  edit?: string;
  view?: string;
}

let sheet = 'demo';
let key = '';
let info: ShareInfo | null = null;
let server: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const storageKey = () => `prepweek:key:${sheet}`;

/** Read the key from the URL (then hide it) or from storage. Call first. */
export const initAccess = (sheetId: string) => {
  sheet = sheetId;
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('k');
  try {
    if (fromUrl) localStorage.setItem(storageKey(), fromUrl);
    key = fromUrl ?? localStorage.getItem(storageKey()) ?? '';
  } catch {
    key = fromUrl ?? '';
  }
  if (fromUrl) {
    url.searchParams.delete('k');
    history.replaceState(history.state, '', url);
  }
};

export const getKey = () => key;
const setKey = (k: string) => {
  key = k;
  try {
    if (k) localStorage.setItem(storageKey(), k);
    else localStorage.removeItem(storageKey());
  } catch {}
};

/** `url` with this sheet's key attached (for sync, presence, files). */
export const withKey = (url: string) => (key ? `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}` : url);

export const getAccess = () => info;
export const onAccess = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
/** Synced through a server (sharing is possible at all). */
export const hasServer = () => !!server;

const apply = (next: ShareInfo) => {
  info = next;
  setReadOnly(next.role !== 'edit');
  emit();
};

/** Ask the server what our key allows. Local-only sheets are always editable. */
export const loadAccess = async (serverHttp: string | null) => {
  server = serverHttp;
  if (!server) return apply({ role: 'edit', private: false });
  try {
    const res = await fetch(withKey(`${server}/share/${encodeURIComponent(sheet)}`), { cache: 'no-store' });
    if (res.ok) apply((await res.json()) as ShareInfo);
  } catch {
    // Offline: keep working with what this device has.
  }
};

/** Turn private links on, reset them, or make the sheet open again. */
export const changeSharing = async (action: 'enable' | 'rotate' | 'disable') => {
  if (!server) throw new Error('Sharing needs the hosted version (a sync server).');
  const res = await fetch(withKey(`${server}/share/${encodeURIComponent(sheet)}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error(res.status === 403 ? 'Only people with the edit link can change sharing.' : `Server error (${res.status})`);
  const next = (await res.json()) as ShareInfo;
  // Keep our own edit access across a reset.
  setKey(next.edit ?? '');
  apply(next);
  return next;
};

export const shareLink = (k?: string) => {
  const u = new URL(`/s/${encodeURIComponent(sheet)}`, location.origin);
  if (k) u.searchParams.set('k', k);
  return u.toString();
};
