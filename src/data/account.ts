// Accounts (worker/auth.ts): who is signed in, their workspaces and sheets.
// Only available when the app is served by the worker; under the Bun dev
// server (or offline) everything here quietly reports "unavailable" and the
// app works as a local, account-less planner.

import { getKey } from './access.ts';

export interface Account {
  id: string;
  email: string;
  name: string;
  avatar: string;
}
export interface SheetRef {
  id: string;
  name: string;
}
export interface Workspace {
  id: string;
  name: string;
  role: 'admin' | 'member';
  sheets: SheetRef[];
}
export interface Me {
  user: Account | null;
  workspaces: Workspace[];
}

/** null = accounts not available here (dev server, offline). */
let me: Me | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getMe = () => me;
export const onMe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const api = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data;
};

/** Load (or reload) who is signed in. Resolves quickly even when offline. */
export const loadMe = async (timeoutMs = 2500): Promise<Me | null> => {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch('/api/me', { signal: ctl.signal, cache: 'no-store', credentials: 'same-origin' });
    clearTimeout(t);
    const isJson = res.headers.get('content-type')?.includes('application/json');
    me = res.ok && isJson ? ((await res.json()) as Me) : null;
  } catch {
    me = null;
  }
  emit();
  return me;
};

export interface AuthConfig {
  email: boolean;
  google: boolean;
  /** Local dev without a mail provider: the link is shown instead of sent. */
  devLinks: boolean;
}
export const authConfig = () => api<AuthConfig>('GET', '/auth/config');
export const sendMagicLink = (email: string, next: string) => api<{ sent: boolean; devLink?: string }>('POST', '/auth/email', { email, next });
export const googleUrl = (next: string) => `/auth/google?next=${encodeURIComponent(next)}`;
/** Ask the app to show the sign-in dialog (from anywhere). */
export const requestSignIn = () => window.dispatchEvent(new Event('prepweek:signin'));
export const signOut = async () => {
  await api('POST', '/auth/logout');
  await loadMe();
};

// --- Workspaces & sheets ----------------------------------------------------------

export interface People {
  role: 'admin' | 'member';
  members: (Account & { role: 'admin' | 'member' })[];
  invites: { token: string; email: string; role: 'admin' | 'member'; created: number }[];
}

export const createWorkspace = async (name: string) => {
  const r = await api<{ id: string }>('POST', '/api/workspaces', { name });
  await loadMe();
  return r.id;
};
export const renameWorkspace = async (id: string, name: string) => {
  await api('PATCH', `/api/workspaces/${encodeURIComponent(id)}`, { name });
  await loadMe();
};
/** Admins: deletes the workspace and all its sheets. */
export const deleteWorkspace = async (id: string) => {
  await api('DELETE', `/api/workspaces/${encodeURIComponent(id)}`);
  await loadMe();
};
/** Last known people per workspace, so the People dialog opens complete. */
const peopleCache = new Map<string, People>();
export const cachedPeople = (workspaceId: string) => peopleCache.get(workspaceId) ?? null;
export const getPeople = async (workspaceId: string) => {
  const p = await api<People>('GET', `/api/workspaces/${encodeURIComponent(workspaceId)}/people`);
  peopleCache.set(workspaceId, p);
  return p;
};
/** Fetch ahead (e.g. when the sheet menu opens); errors are ignored here. */
export const prefetchPeople = (workspaceId: string) => void getPeople(workspaceId).catch(() => {});
export const setMemberRole = (workspaceId: string, userId: string, role: 'admin' | 'member') =>
  api('PATCH', `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, { role });
export const removeMember = async (workspaceId: string, userId: string) => {
  await api('DELETE', `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`);
  await loadMe();
};
export const inviteToWorkspace = (workspaceId: string, email: string, role: 'admin' | 'member') =>
  api<{ token: string; link: string; sent: boolean }>('POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/invites`, { email, role });
export const revokeInvite = (token: string) => api('DELETE', `/api/invites/${encodeURIComponent(token)}`);
export const inviteInfo = (token: string) => api<{ workspace: string; inviter: string; email: string }>('GET', `/api/invites/${encodeURIComponent(token)}`);
export const acceptInvite = async (token: string) => {
  const r = await api<{ workspaceId: string }>('POST', `/api/invites/${encodeURIComponent(token)}/accept`);
  await loadMe();
  return r.workspaceId;
};

/** A new sheet in a workspace, or (with `id`) put the current one there. */
export const addSheet = async (workspaceId: string, name: string, id?: string) => {
  const r = await api<{ id: string }>('POST', '/api/sheets', { workspaceId, name, id, key: id ? getKey() : undefined });
  await loadMe();
  return r.id;
};
export const renameSheet = async (id: string, name: string) => {
  await api('PATCH', `/api/sheets/${encodeURIComponent(id)}`, { name });
  await loadMe();
};
export const deleteSheet = async (id: string) => {
  await api('DELETE', `/api/sheets/${encodeURIComponent(id)}`);
  await loadMe();
};

// --- Sheets started on this device without an account ---------------------------------

const MINE = 'prepweek:mySheets';
const LAST = 'prepweek:lastSheet';

const read = (k: string): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
/** Sheets created here before signing in; signing in saves them to an account. */
export const mySheets = () => read(MINE);
export const rememberMySheet = (id: string) => {
  try {
    localStorage.setItem(MINE, JSON.stringify([...new Set([...mySheets(), id])]));
  } catch {}
};
export const forgetMySheet = (id: string) => {
  try {
    localStorage.setItem(MINE, JSON.stringify(mySheets().filter((s) => s !== id)));
  } catch {}
};
export const lastSheet = () => {
  try {
    const id = localStorage.getItem(LAST);
    return id === 'demo' ? null : id;
  } catch {
    return null;
  }
};
export const forgetLastSheet = () => {
  try {
    localStorage.removeItem(LAST);
  } catch {}
};
export const rememberLastSheet = (id: string) => {
  // The demo is a sample, not where you plan: "back in" shouldn't land there.
  if (id === 'demo') return;
  try {
    localStorage.setItem(LAST, id);
  } catch {}
};

/** A fresh, unguessable sheet id (the URL is the way back to it). */
export const newSheetId = () => {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};
