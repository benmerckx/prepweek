// Sheets that belong to a workspace ("claimed" by signing in) only open for
// their members. The server enforces that; this device remembers it too, so
// a claimed sheet doesn't open from its local copy after signing out, or
// while the server can't be asked.

const key = (sheet: string) => `prepweek:claimed:${sheet}`;
const SIGNED_IN = 'prepweek:signed-in';

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
};

export const isClaimed = (sheet: string) => get(key(sheet)) === '1';
export const markClaimed = (sheet: string, claimed: boolean) => set(key(sheet), claimed ? '1' : null);

/** Someone is signed in on this device (as of the last check). */
export const wasSignedIn = () => get(SIGNED_IN) === '1';
export const rememberSignedIn = (on: boolean) => set(SIGNED_IN, on ? '1' : null);

/** Drop this device's copy of a sheet (its IndexedDB databases). */
export const forgetLocalCopy = (sheet: string) => {
  try {
    indexedDB.deleteDatabase(`prepweek2:${sheet}`);
    indexedDB.deleteDatabase(`prepweek:${sheet}`);
  } catch {}
};
