// Who is using this browser.
//
// Signed in (accounts, see account.ts): you are the person row whose email is
// your login email, and your name is your account's. Nothing to pick: the
// tie lives on the row, so it holds on every device and for everyone.
//
// Not signed in, you're a guest: not tied to any row, but free to look
// around, comment and @mention anyone. Signing up is how a row becomes yours.

import { getUser, isReadOnly, setActor, store } from './store.ts';
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
 * - 'local': no accounts available here (the local dev server, offline).
 */
export type IdentityMode = 'account' | 'signedOut' | 'local';

const GUEST: Me = { personId: '', name: '' };
let me: Me = GUEST;
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
  return GUEST;
};

const apply = () => {
  const next = compute();
  const sig = `${next.personId}|${next.name}|${next.personId ? getUser(next.personId)?.name : ''}`;
  if (sig === snapshot) return;
  snapshot = sig;
  me = next;
  syncAvatar();
  setActor({ name: displayName(), id: me.personId && getUser(me.personId) ? me.personId : '' });
  listeners.forEach((l) => l());
};

/**
 * Signed in and tied to a row: the row shows your account's picture (from
 * Google). Written as data on the sheet, so everyone sees it; not an undo step.
 */
const syncAvatar = () => {
  const avatar = identityMode() === 'account' ? getAccount()?.user?.avatar : '';
  const id = me.personId;
  if (!avatar || !id || isReadOnly() || getUser(id)?.avatar === avatar) return;
  setTimeout(() => {
    if (me.personId === id && store.hasRow('users', id) && !isReadOnly()) store.setCell('users', id, 'avatar', avatar);
  });
};

/** Work out who we are; call once the sheet is known. */
export const loadMe = () => {
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
/** Signed in: your account's name (or your row's); a guest has none. */
export const displayName = () => me.name || (me.personId && getUser(me.personId)?.name) || '';
export const isMe = (personId: string, name?: string) =>
  (!!me.personId && personId === me.personId) || (!personId && !!name && name === displayName());
