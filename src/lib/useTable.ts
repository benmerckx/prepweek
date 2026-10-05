import { useSyncExternalStore } from 'react';
import { store } from '../data/store.ts';

// TinyBase returns fresh objects from getTable(), so components subscribe to
// a per-table change counter and read the store while rendering.
const versions = new Map<string, number>();
const subs = new Map<string, (fn: () => void) => () => void>();

const subscriber = (table: string) => {
  let s = subs.get(table);
  if (!s) {
    s = (fn) => {
      const id = store.addTableListener(table, () => {
        versions.set(table, (versions.get(table) ?? 0) + 1);
        fn();
      });
      return () => void store.delListener(id);
    };
    subs.set(table, s);
  }
  return s;
};

/** Re-render when any of these tables change; returns a combined version. */
export const useTables = (...tables: string[]): string =>
  tables.map((t) => useSyncExternalStore(subscriber(t), () => versions.get(t) ?? 0)).join('.'); // eslint-disable-line react-hooks/rules-of-hooks

export const ago = (ms: number, now = Date.now()): string => {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
