// Who may do what on this sheet, as decided by the server (worker/index.ts).
//
// A sheet with private links needs a key in the URL (`?k=…`). The key is
// remembered per sheet and stripped from the address bar, so it isn't left
// in screenshots or copied around by accident; the Share dialog hands out
// fresh links.

import { setReadOnly } from './store.ts';
import type { PlanInfo } from '../lib/plans.ts';
import { forgetLocalCopy, isClaimed, markClaimed, wasSignedIn } from './claimed.ts';

export type Role = 'edit' | 'view' | 'none';
export interface ShareInfo {
  role: Role;
  private: boolean;
  /** Keys, only for editors of a private sheet. */
  edit?: string;
  view?: string;
  /** The sheet's name and workspace (none for a sheet started without an account). */
  name?: string;
  workspace?: { id: string; name: string } | null;
  signedIn?: boolean;
  /** The sheet was deleted from its workspace. */
  deleted?: boolean;
  /** The workspace's plan (none for a sheet outside a workspace). */
  plan?: PlanInfo | null;
  /** Plans limit people on this server (PLAN_LIMITS="on"). */
  limitsOn?: boolean;
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
export const getSheetId = () => sheet;
/** Re-check after signing in, joining or saving the sheet to a workspace. */
export const reloadAccess = () => loadAccess(server);
export const onAccess = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
/** Synced through a server (sharing is possible at all). */
export const hasServer = () => !!server;

/** Started on this device without an account (see mySheets in account.ts). */
const startedHere = () => {
  try {
    const mine = JSON.parse(localStorage.getItem('prepweek:mySheets') ?? '[]');
    return Array.isArray(mine) && mine.includes(sheet);
  } catch {
    return false;
  }
};

const apply = (next: ShareInfo) => {
  info = next;
  // The keys of a sheet this device started (its first visit): keep them.
  if (!key && next.role === 'edit' && next.edit) setKey(next.edit);
  // Not ours to see: don't keep a copy of it on this device either.
  if (next.role === 'none' && !next.deleted && !startedHere()) forgetLocalCopy(sheet);
  // Remember whether this sheet belongs to a workspace (see claimed.ts).
  if (next.workspace) markClaimed(sheet, true);
  else if (next.workspace === null && next.role !== 'none') markClaimed(sheet, false);
  setReadOnly(next.role !== 'edit');
  emit();
};

/** Ask the server what our key allows. Local-only sheets are always editable. */
export const loadAccess = async (serverHttp: string | null) => {
  server = serverHttp;
  if (!server) return apply({ role: 'edit', private: false });
  // A sheet this device knows is claimed, with nobody signed in: locked
  // until the server says otherwise (and still locked when it can't be
  // reached), rather than open from the local copy.
  if (isClaimed(sheet) && !wasSignedIn()) apply({ role: 'none', private: false, signedIn: false });
  // The first check is under way (it may be getting a new sheet's keys):
  // its answer will do.
  if (first && !checked) {
    await first;
    if (checked) return;
  }
  try {
    // A sheet started here without a key yet asks for its keys (`own`).
    const own = !key && startedHere() ? '?own=1' : '';
    let res = await fetch(withKey(`${server}/share/${encodeURIComponent(sheet)}${own}`), { cache: 'no-store' });
    // Another tab here got the keys first: it saved them, ask again with them.
    if (own && res.ok && ((await res.clone().json()) as ShareInfo).role === 'none') {
      try {
        key = localStorage.getItem(storageKey()) ?? '';
      } catch {}
      if (key) res = await fetch(withKey(`${server}/share/${encodeURIComponent(sheet)}`), { cache: 'no-store' });
    }
    if (res.ok) {
      checked = true;
      apply((await res.json()) as ShareInfo);
    }
  } catch {
    // Offline: keep working with what this device has.
  }
};

let first: Promise<void> | null = null;
/** The server has answered an access check for this sheet. */
let checked = false;
/**
 * Before the first sync connection: what may we do here? A sheet started
 * here gets its key on its first check, and a sheet that isn't ours to open
 * shouldn't be connected to at all. Waits for that check, but not for long.
 */
export const accessReady = (serverHttp: string) => {
  if (checked) return Promise.resolve();
  first ??= loadAccess(serverHttp);
  return Promise.race([first, new Promise<void>((r) => setTimeout(r, 5000))]);
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

/**
 * A calendar subscription address for `who` (a person row id, or 'all'):
 * Google, Apple and Outlook calendars subscribe to it and keep it fresh.
 */
export const calendarLink = async (who: string): Promise<string> => {
  if (!server) throw new Error('Calendar links need the hosted version (a sync server).');
  const res = await fetch(withKey(`${server}/share/${encodeURIComponent(sheet)}?feed=1`), { method: 'POST' });
  if (!res.ok) throw new Error(`Couldn’t make a calendar link (${res.status})`);
  const { feed } = (await res.json()) as { feed: string };
  return `${server}/ical/${encodeURIComponent(sheet)}/${encodeURIComponent(who)}.ics?f=${encodeURIComponent(feed)}`;
};

export const shareLink = (k?: string) => {
  const u = new URL(`/s/${encodeURIComponent(sheet)}`, location.origin);
  if (k) u.searchParams.set('k', k);
  return u.toString();
};
