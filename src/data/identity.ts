// Who is using this browser.
//
// Signed in (accounts, see account.ts): you are the person row whose email is
// your login email, and your name is your account's. Nothing to pick: the
// tie lives on the row, so it holds on every device and for everyone.
//
// Without accounts (the local dev server, offline): people say who they are
// once per sheet, as before: a row, or just a display name.

import { getUser, setActor, store } from './store.ts';
import { getSheet } from './sync.ts';
import { getMe as getAccount, onMe as onAccount } from './account.ts';

export interface Me {
  /** Person row on this sheet ('' = not linked). */
  personId: string;
  /** Display name, used when not linked (or the person is gone). */
  name: string;
}

/**
 * - 'account': signed in; identity comes from the login.
 * - 'signedOut': accounts exist here but nobody is signed in.
 * - 'local': no accounts available; identity is picked per device.
 */
export type IdentityMode = 'account' | 'signedOut' | 'local';

const key = () => `prepweek:me:${getSheet()}`;
/** The per-device choice (local mode only). */
let picked: Me = { personId: '', name: '' };
let me: Me = picked;
let snapshot = '';
const listeners = new Set<() => void>();

export const identityMode = (): IdentityMode => {
  const a = getAccount();
  return !a ? 'local' : a.user ? 'account' : 'signedOut';
};

/** The person row tied to an email (case-insensitive), or ''. */
export const rowForEmail = (email: string) => {
  const e = email.trim().toLowerCase();
  if (!e) return '';
  return store.getRowIds('users').find((id) => (store.getCell('users', id, 'email') as string)?.trim().toLowerCase() === e) ?? '';
};

const compute = (): Me => {
  const mode = identityMode();
  if (mode === 'account') {
    const user = getAccount()!.user!;
    return { personId: rowForEmail(user.email), name: user.name };
  }
  if (mode === 'signedOut') return { personId: '', name: '' };
  return picked;
};

const apply = () => {
  const next = compute();
  const sig = `${next.personId}|${next.name}|${next.personId ? getUser(next.personId)?.name : ''}`;
  if (sig === snapshot) return;
  snapshot = sig;
  me = next;
  setActor({ name: displayName(), id: me.personId && getUser(me.personId) ? me.personId : '' });
  listeners.forEach((l) => l());
};

/** Read the saved identity; call once the sheet is known. */
export const loadMe = () => {
  try {
    const v = JSON.parse(localStorage.getItem(key()) ?? 'null');
    if (v && typeof v.name === 'string') picked = { personId: String(v.personId ?? ''), name: v.name };
  } catch {}
  apply();
  // Rows gaining or losing an email (or being renamed) can change who we are.
  store.addTableListener('users', apply);
  onAccount(apply);
};

export const getMe = () => me;
export const onMeChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
/** Pick who you are (local mode only; signed in, the login decides). */
export const setMe = (next: Me) => {
  picked = next;
  try {
    localStorage.setItem(key(), JSON.stringify(picked));
  } catch {}
  apply();
};

/** Signed in: your account's name. Otherwise the linked row's, or the typed name. */
export const displayName = () =>
  identityMode() === 'account' ? me.name || (me.personId && getUser(me.personId)?.name) || '' : (me.personId && getUser(me.personId)?.name) || me.name || '';
export const isMe = (personId: string, name?: string) =>
  (!!me.personId && personId === me.personId) || (!personId && !!name && name === displayName());
