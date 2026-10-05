// Who is using this browser. Until there are real accounts, people say who
// they are once per sheet: a display name, ideally linked to their row on the
// sheet so mentions and "assigned to you" notifications reach them.

import { getUser, setActor, store } from './store.ts';
import { getSheet } from './sync.ts';

export interface Me {
  /** Person row on this sheet ('' = not linked). */
  personId: string;
  /** Display name, used when not linked (or the person is gone). */
  name: string;
}

const key = () => `prepweek:me:${getSheet()}`;
let me: Me = { personId: '', name: '' };
const listeners = new Set<() => void>();

const apply = () => {
  setActor({ name: displayName(), id: me.personId && getUser(me.personId) ? me.personId : '' });
  listeners.forEach((l) => l());
};

/** Read the saved identity; call once the sheet is known. */
export const loadMe = () => {
  try {
    const v = JSON.parse(localStorage.getItem(key()) ?? 'null');
    if (v && typeof v.name === 'string') me = { personId: String(v.personId ?? ''), name: v.name };
  } catch {}
  apply();
  // A rename of the linked person changes how we sign our edits.
  store.addRowListener('users', null, (_s, id) => id === me.personId && apply());
};

export const getMe = () => me;
export const onMeChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const setMe = (next: Me) => {
  me = next;
  try {
    localStorage.setItem(key(), JSON.stringify(me));
  } catch {}
  apply();
};

export const displayName = () => (me.personId && getUser(me.personId)?.name) || me.name || '';
export const isMe = (personId: string, name?: string) =>
  (!!me.personId && personId === me.personId) || (!personId && !!name && name === displayName());
