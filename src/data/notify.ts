// Notifications are derived, not stored: from the comments and activity
// tables, for whoever "me" is in this browser. What has been seen is a
// per-device timestamp.

import { getUser, store } from './store.ts';
import { getMe, isMe } from './identity.ts';
import { getSheet } from './sync.ts';

export interface Note {
  id: string;
  at: number;
  kind: 'mention' | 'comment' | 'change';
  by: string;
  byId: string;
  /** Comment text or the change ("Move task"). */
  text: string;
  taskId: string;
  title: string;
}

const MAX = 60;

/** Notes for me, newest first. Empty when I'm not linked to a person. */
export const notifications = (): Note[] => {
  const me = getMe().personId;
  if (!me || !getUser(me)) return [];
  const out: Note[] = [];
  const mine = (taskId: string) => store.hasRow('tasks', taskId) && store.getCell('tasks', taskId, 'userId') === me;
  const title = (taskId: string, fallback = '') => (store.hasRow('tasks', taskId) ? (store.getCell('tasks', taskId, 'title') as string) : fallback);
  for (const id of store.getRowIds('comments')) {
    const c = store.getRow('comments', id) as { taskId: string; at: number; by: string; byId: string; text: string; mentions: string };
    if (isMe(c.byId, c.by)) continue;
    const mentioned = c.mentions.split(',').includes(me);
    if (mentioned || mine(c.taskId))
      out.push({ id, at: c.at, kind: mentioned ? 'mention' : 'comment', by: c.by || 'Someone', byId: c.byId, text: c.text, taskId: c.taskId, title: title(c.taskId) });
  }
  for (const id of store.getRowIds('activity')) {
    const a = store.getRow('activity', id) as { at: number; by: string; byId: string; label: string; taskId: string; title: string; owner: string };
    if (!a.taskId || a.label === 'Comment' || a.label === 'Delete comment' || isMe(a.byId, a.by)) continue;
    // Changes to my work (or work that was mine, e.g. reassigned away).
    if (a.owner === me || mine(a.taskId))
      out.push({ id, at: a.at, kind: 'change', by: a.by || 'Someone', byId: a.byId, text: a.label, taskId: a.taskId, title: title(a.taskId, a.title) });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX);
};

const seenKey = () => `prepweek:seen:${getSheet()}`;
export const getSeen = (): number => {
  try {
    return Number(localStorage.getItem(seenKey())) || 0;
  } catch {
    return 0;
  }
};
export const markSeen = (at = Date.now()) => {
  try {
    localStorage.setItem(seenKey(), String(at));
  } catch {}
};

/**
 * Show a system notification for new mentions/comments/changes from others
 * that arrive while this tab is in the background.
 */
export const watchDesktopNotifications = (onClick: (taskId: string) => void) => {
  const started = Date.now();
  const shown = new Set<string>();
  const check = () => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
    for (const n of notifications()) {
      if (n.at < started || n.at <= getSeen() || shown.has(n.id)) continue;
      shown.add(n.id);
      const title = n.kind === 'mention' ? `${n.by} mentioned you` : n.kind === 'comment' ? `${n.by} commented` : `${n.by}: ${n.text}`;
      const note = new Notification(title, { body: n.kind === 'change' ? n.title : `${n.title ? `${n.title}: ` : ''}${n.text}`, tag: n.id });
      note.onclick = () => {
        window.focus();
        onClick(n.taskId);
        note.close();
      };
    }
  };
  const a = store.addTableListener('comments', check);
  const b = store.addTableListener('activity', check);
  return () => {
    store.delListener(a);
    store.delListener(b);
  };
};
